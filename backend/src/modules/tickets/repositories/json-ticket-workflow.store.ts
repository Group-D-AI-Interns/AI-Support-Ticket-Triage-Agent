import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

import type { TenantContext } from '../../../shared/tenant.js';
import type {
  TicketWorkflowConfig,
  TicketWorkflowRecord,
} from '../domain/ticket-workflow.js';

const supportedRoles = new Set([
  'requester',
  'support_agent',
  'support_lead',
  'organisation_admin',
]);

export class TicketWorkflowStoreError extends Error {}
export class TicketWorkflowConflictError extends Error {}

export class JsonTicketWorkflowStore {
  private readonly recordsPath: string;
  private readonly lockPath: string;

  constructor(private readonly dataDirectory: string) {
    this.recordsPath = join(dataDirectory, 'ticket-workflows.json');
    this.lockPath = join(dataDirectory, 'ticket-workflows.lock');
  }

  async list(tenant: TenantContext): Promise<TicketWorkflowRecord[]> {
    return this.withLock(async () =>
      (await this.readRecords()).filter(
        (record) => record.organisationId === tenant.organisationId,
      ),
    );
  }

  async find(
    tenant: TenantContext,
    workflowId: string,
  ): Promise<TicketWorkflowRecord | null> {
    return this.withLock(async () => {
      const record = (await this.readRecords()).find(
        (workflow) =>
          workflow.id === workflowId &&
          workflow.organisationId === tenant.organisationId,
      );
      return record ?? null;
    });
  }

  async getActive(
    tenant: TenantContext,
  ): Promise<TicketWorkflowRecord | null> {
    return this.withLock(async () =>
      (await this.readRecords()).find(
        (record) =>
          record.organisationId === tenant.organisationId &&
          record.status === 'active',
      ) ?? null,
    );
  }

  async createDraft(
    tenant: TenantContext,
    config: TicketWorkflowConfig,
    createdBy: string,
  ): Promise<TicketWorkflowRecord> {
    return this.withLock(async () => {
      const records = await this.readRecords();
      const now = new Date().toISOString();
      const record: TicketWorkflowRecord = {
        id: `workflow_${randomUUID().replace(/-/g, '')}`,
        organisationId: tenant.organisationId,
        config,
        status: 'draft',
        createdBy,
        createdAt: now,
        updatedAt: now,
      };
      records.push(record);
      await this.writeRecords(records);
      return record;
    });
  }

  async approve(
    tenant: TenantContext,
    workflowId: string,
    approvedBy: string,
  ): Promise<TicketWorkflowRecord | null> {
    return this.withLock(async () => {
      const records = await this.readRecords();
      const index = records.findIndex(
        (record) =>
          record.id === workflowId &&
          record.organisationId === tenant.organisationId,
      );
      if (index === -1) {
        return null;
      }

      const workflow = records[index];
      if (workflow.status !== 'draft') {
        throw new TicketWorkflowConflictError(
          'Only a draft ticket workflow can be approved.',
        );
      }

      const now = new Date().toISOString();
      const active: TicketWorkflowRecord = {
        ...workflow,
        status: 'active',
        approvedBy,
        approvedAt: now,
        updatedAt: now,
      };
      records[index] = active;
      for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
        const record = records[recordIndex];
        if (
          recordIndex !== index &&
          record.organisationId === tenant.organisationId &&
          record.status === 'active'
        ) {
          records[recordIndex] = {
            ...record,
            status: 'archived',
            updatedAt: now,
          };
        }
      }
      await this.writeRecords(records);
      return active;
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => Promise<void>) | undefined;
    try {
      await mkdir(this.dataDirectory, { recursive: true });
      const lockFile = await open(this.lockPath, 'a');
      await lockFile.close();
      release = await lockfile.lock(this.lockPath, {
        retries: { retries: 10, factor: 1.2, minTimeout: 50, maxTimeout: 250 },
        stale: 30_000,
        update: 10_000,
      });
      return await operation();
    } catch (error) {
      if (
        error instanceof TicketWorkflowConflictError ||
        error instanceof TicketWorkflowStoreError
      ) {
        throw error;
      }
      throw new TicketWorkflowStoreError(
        'Ticket workflow storage could not be accessed.',
        { cause: error },
      );
    } finally {
      if (release) {
        try {
          await release();
        } catch (error) {
          throw new TicketWorkflowStoreError(
            'Ticket workflow storage lock could not be released.',
            { cause: error },
          );
        }
      }
    }
  }

  private async readRecords(): Promise<TicketWorkflowRecord[]> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.recordsPath, 'utf8'));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }
      throw new TicketWorkflowStoreError(
        'Ticket workflow storage could not be read as valid JSON.',
        { cause: error },
      );
    }

    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      !Array.isArray(value.records) ||
      value.records.some((record) => !isWorkflowRecord(record))
    ) {
      throw new TicketWorkflowStoreError(
        'Ticket workflow storage does not match the supported schema.',
      );
    }
    return value.records;
  }

  private async writeRecords(records: TicketWorkflowRecord[]): Promise<void> {
    const temporaryPath = `${this.recordsPath}.${randomUUID().replace(/-/g, '')}.tmp`;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(temporaryPath, 'wx');
      await file.writeFile(
        JSON.stringify({ schemaVersion: 1, records }),
        'utf8',
      );
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporaryPath, this.recordsPath);
    } catch (error) {
      if (file) {
        await file.close();
      }
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
          throw new TicketWorkflowStoreError(
            'Ticket workflow temporary file could not be removed.',
            { cause: cleanupError },
          );
        }
      }
      throw new TicketWorkflowStoreError(
        'Ticket workflow storage could not be written safely.',
        { cause: error },
      );
    }
  }
}

function isWorkflowRecord(value: unknown): value is TicketWorkflowRecord {
  return (
    isRecord(value) &&
    ['id', 'organisationId', 'createdBy', 'createdAt', 'updatedAt'].every(
      (field) => typeof value[field] === 'string' && value[field],
    ) &&
    ['draft', 'active', 'archived'].includes(String(value.status)) &&
    isWorkflowConfig(value.config) &&
    (value.approvedBy === undefined || typeof value.approvedBy === 'string') &&
    (value.approvedAt === undefined || typeof value.approvedAt === 'string')
  );
}

function isWorkflowConfig(value: unknown): value is TicketWorkflowConfig {
  if (
    !isRecord(value) ||
    typeof value.sourceReference !== 'string' ||
    !value.sourceReference ||
    typeof value.initialStatus !== 'string' ||
    typeof value.reopenStatus !== 'string' ||
    !stringArray(value.statuses) ||
    value.statuses.length === 0 ||
    !stringArray(value.requestableReopenFrom) ||
    !stringArray(value.restrictedReopenFrom) ||
    !isRecord(value.transitions) ||
    !isRecord(value.permissions)
  ) {
    return false;
  }
  const statuses = value.statuses;
  const reopenStatus = value.reopenStatus;
  const requestableReopenFrom = value.requestableReopenFrom;
  const restrictedReopenFrom = value.restrictedReopenFrom;
  const statusSet = new Set(statuses);
  const transitions = value.transitions;
  const permissions = value.permissions;
  const transitionMap: Record<string, string[]> = {};
  if (
    !stringArray(requestableReopenFrom) ||
    !stringArray(restrictedReopenFrom) ||
    typeof reopenStatus !== 'string'
  ) {
    return false;
  }
  if (
    statusSet.size !== statuses.length ||
    !statusSet.has(value.initialStatus) ||
    !statusSet.has(value.reopenStatus) ||
    Object.keys(transitions).length !== statuses.length ||
    statuses.some(
      (status) => !Object.prototype.hasOwnProperty.call(transitions, status),
    )
  ) {
    return false;
  }
  for (const [fromStatus, targets] of Object.entries(transitions)) {
    if (
      !stringArray(targets) ||
      new Set(targets).size !== targets.length ||
      targets.some((target) => !statusSet.has(target) || target === fromStatus)
    ) {
      return false;
    }
    transitionMap[fromStatus] = targets;
  }
  if (
    requestableReopenFrom.some(
      (status) =>
        !statusSet.has(status) ||
        !transitionMap[status]?.includes(reopenStatus),
    ) ||
    restrictedReopenFrom.some(
      (status) =>
        !statusSet.has(status) ||
        !transitionMap[status]?.includes(reopenStatus),
    )
  ) {
    return false;
  }
  return [
    'directStatusChangeRoles',
    'closedReopenRoles',
    'reopenRequestRoles',
    'reopenApprovalRoles',
    'administratorOverrideRoles',
  ].every((field) => {
    const roles = permissions[field];
    return (
      stringArray(roles) &&
      roles.length > 0 &&
      roles.every((role) => supportedRoles.has(role)) &&
      new Set(roles).size === roles.length
    );
  });
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
