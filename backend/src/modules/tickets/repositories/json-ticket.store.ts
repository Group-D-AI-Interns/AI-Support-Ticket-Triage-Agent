import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import lockfile from 'proper-lockfile';

import { assertTenantAccess, type TenantContext } from '../../../shared/tenant.js';
import type {
  JsonValue,
  TicketAttachment,
  TicketComment,
  TicketHistoryEvent,
  TicketRecord,
  TicketSource,
} from '../domain/ticket.js';
import type { TicketReopenRequest } from '../domain/ticket-workflow.js';
import {
  normalizeStoredTicketPriority,
  normalizeTicketPriority,
} from '../domain/priority.js';
import {
  SLA_EVIDENCE_ACTIONS,
  type SlaEvidenceWrite,
  type SlaPauseEvidence,
  type SlaResolutionEvidence,
} from '../../sla/domain/sla-evidence.js';

export class TicketStoreError extends Error {}
export class TicketConflictError extends Error {}

type NewTicket = Omit<
  TicketRecord,
  'id' | 'createdAt' | 'updatedAt' | 'comments' | 'history'
>;
type JiraOutcome = 'created' | 'updated' | 'duplicate';
type PriorityOverrideAudit = {
  reason: string;
  businessJustification: string;
};

export class JsonTicketStore {
  private readonly ticketsPath: string;
  private readonly lockPath: string;

  constructor(private readonly dataDirectory: string) {
    this.ticketsPath = join(dataDirectory, 'tickets.json');
    this.lockPath = join(dataDirectory, 'tickets.lock');
  }

  async upsertJiraTicket(ticket: NewTicket): Promise<[TicketRecord, JiraOutcome]> {
    const normalizedTicket = normalizeTicketRecordPriority(ticket);
    return this.withLock(async () => {
      const records = await this.readRecords();
      const source = normalizedTicket.source;
      if (!source) {
        throw new TicketStoreError('Jira ticket source metadata is required.');
      }

      const existing = records.find(
        (record) =>
          record.organisationId === normalizedTicket.organisationId &&
          record.source?.system === 'jira' &&
          record.source.issueId === source.issueId,
      );
      const issueKeyCollision = records.some(
        (record) =>
          record.organisationId === normalizedTicket.organisationId &&
          record.source?.system === 'jira' &&
          record.source.issueKey === source.issueKey &&
          record.source.issueId !== source.issueId,
      );
      if (issueKeyCollision) {
        throw new TicketConflictError(
          'A different Jira issue already uses this issue key.',
        );
      }

      const now = new Date().toISOString();
      if (existing) {
        if (Object.entries(normalizedTicket).every(([key, value]) => isDeepStrictEqual(existing[key as keyof TicketRecord], value))) {
          return [existing, 'duplicate'];
        }

        const jiraChanges = { ...normalizedTicket };
        delete jiraChanges.status;
        delete jiraChanges.workflowId;
        const changes = changedValues(existing, jiraChanges);
        const updated: TicketRecord = {
          ...existing,
          ...jiraChanges,
          ...(existing.status === undefined ? {} : { status: existing.status }),
          ...(existing.workflowId === undefined
            ? {}
            : { workflowId: existing.workflowId }),
          updatedAt: now,
          comments: existing.comments ?? [],
          reopenRequests: existing.reopenRequests ?? [],
          history: existing.history ?? [],
        };
        appendHistory(updated, 'jira.issue_updated', 'jira_webhook', changes);
        if (
          existing.teamId == null &&
          typeof updated.teamId === 'string' &&
          !(existing.history ?? []).some(
            (event) => event.action === SLA_EVIDENCE_ACTIONS.assignment,
          )
        ) {
          appendHistory(
            updated,
            SLA_EVIDENCE_ACTIONS.assignment,
            'jira_webhook',
            { teamId: updated.teamId },
            now,
          );
        }
        records[records.indexOf(existing)] = updated;
        await this.writeRecords(records);
        return [updated, 'updated'];
      }

      const created: TicketRecord = {
        id: `ticket_${randomUUID().replace(/-/g, '')}`,
        ...normalizedTicket,
        createdAt: now,
        updatedAt: now,
        comments: [],
        reopenRequests: [],
        history: [],
      };
      appendHistory(created, 'jira.issue_created', 'jira_webhook', {});
      if (created.teamId) {
        appendHistory(
          created,
          SLA_EVIDENCE_ACTIONS.assignment,
          'jira_webhook',
          { teamId: created.teamId },
          now,
        );
      }
      records.push(created);
      await this.writeRecords(records);
      return [created, 'created'];
    });
  }

  async listTickets(tenant: TenantContext): Promise<TicketRecord[]> {
    return this.withLock(async () =>
      (await this.readRecords()).filter(
        (record) => record.organisationId === tenant.organisationId,
      ),
    );
  }

  async findTicket(
    tenant: TenantContext,
    ticketId: string,
  ): Promise<TicketRecord | null> {
    return this.withLock(async () => {
      const record = (await this.readRecords()).find(
        (ticket) => ticket.id === ticketId,
      );
      return assertTenantAccess(tenant, record) ?? null;
    });
  }

  async createTicket(
    ticket: NewTicket,
    tenant: TenantContext,
  ): Promise<TicketRecord> {
    if (ticket.organisationId !== tenant.organisationId) {
      throw new TicketStoreError(
        'Ticket organisation does not match tenant context.',
      );
    }

    return this.withLock(async () => {
      const records = await this.readRecords();
      const now = new Date().toISOString();
      const created: TicketRecord = {
        id: `ticket_${randomUUID().replace(/-/g, '')}`,
        ...normalizeTicketRecordPriority(ticket),
        createdAt: now,
        updatedAt: now,
        comments: [],
        reopenRequests: [],
        history: [],
      };
      appendHistory(created, 'ticket.created', tenant.userId, {});
      if (created.teamId) {
        appendHistory(
          created,
          SLA_EVIDENCE_ACTIONS.assignment,
          tenant.userId,
          { teamId: created.teamId },
          now,
        );
      }
      records.push(created);
      await this.writeRecords(records);
      return created;
    });
  }

  async updateTicket(
    tenant: TenantContext,
    ticketId: string,
    changes: Partial<
      Pick<
        TicketRecord,
        'title' | 'description' | 'product' | 'affectedService' | 'teamId' | 'priority'
      >
    >,
    priorityOverride?: PriorityOverrideAudit,
  ): Promise<TicketRecord | null> {
    return this.withLock(async () => {
      const records = await this.readRecords();
      const ticket = records.find(
        (record) =>
          record.id === ticketId &&
          record.organisationId === tenant.organisationId,
      );
      if (!ticket) {
        return null;
      }

      const normalizedChanges = changes.priority === undefined
        ? changes
        : {
            ...changes,
            priority: normalizeTicketPriority(changes.priority) ?? changes.priority,
          };
      if (
        changes.priority !== undefined &&
        !normalizeTicketPriority(changes.priority)
      ) {
        throw new TicketStoreError('Ticket priority must be P1, P2, P3, or P4.');
      }
      const changed = changedValues(ticket, normalizedChanges);
      if (Object.keys(changed).length === 0) {
        return ticket;
      }

      const updated: TicketRecord = {
        ...ticket,
        ...normalizedChanges,
        updatedAt: new Date().toISOString(),
        comments: ticket.comments ?? [],
        reopenRequests: ticket.reopenRequests ?? [],
        history: ticket.history ?? [],
      };
      appendHistory(
        updated,
        priorityOverride ? 'ticket.priority.overridden' : 'ticket.updated',
        tenant.userId,
        {
          ...changed,
          ...(priorityOverride === undefined
            ? {}
            : { priorityOverride }),
        },
        updated.updatedAt,
      );
      if (
        ticket.teamId == null &&
        typeof normalizedChanges.teamId === 'string' &&
        !(ticket.history ?? []).some(
          (event) => event.action === SLA_EVIDENCE_ACTIONS.assignment,
        )
      ) {
        appendHistory(
          updated,
          SLA_EVIDENCE_ACTIONS.assignment,
          tenant.userId,
          { teamId: normalizedChanges.teamId },
          updated.updatedAt,
        );
      }
      records[records.indexOf(ticket)] = updated;
      await this.writeRecords(records);
      return updated;
    });
  }

  async changeStatus(
    tenant: TenantContext,
    ticketId: string,
    expectedStatus: string,
    status: string,
    reason: string | undefined,
    workflowId: string,
    slaEvidence?: {
      pauseStart?: SlaPauseEvidence;
      pauseEnd?: boolean;
      resolution?: SlaResolutionEvidence;
    },
  ): Promise<TicketRecord | null> {
    return this.withLock(async () => {
      const records = await this.readRecords();
      const ticket = records.find(
        (record) =>
          record.id === ticketId &&
          record.organisationId === tenant.organisationId,
      );
      if (!ticket) {
        return null;
      }
      const currentStatus = ticket.status ?? expectedStatus;
      if (normalizeStatus(currentStatus) !== normalizeStatus(expectedStatus)) {
        throw new TicketConflictError(
          'Ticket status changed before the requested transition could be saved.',
        );
      }

      const now = new Date().toISOString();
      const history = ticket.history ?? [];
      const activePause = findActiveSlaInterval(
        history,
        SLA_EVIDENCE_ACTIONS.pauseStarted,
        SLA_EVIDENCE_ACTIONS.pauseEnded,
      );
      const activeExclusion = findActiveSlaInterval(
        history,
        SLA_EVIDENCE_ACTIONS.exclusionStarted,
        SLA_EVIDENCE_ACTIONS.exclusionEnded,
      );
      if (slaEvidence?.pauseStart && (activePause || activeExclusion)) {
        throw new TicketConflictError(
          'An SLA pause or exclusion interval is already active.',
        );
      }
      if (slaEvidence?.pauseEnd && (!activePause || activeExclusion)) {
        throw new TicketConflictError('There is no active SLA pause to resume.');
      }
      const updated: TicketRecord = {
        ...ticket,
        workflowId: ticket.workflowId ?? workflowId,
        status,
        updatedAt: now,
        comments: ticket.comments ?? [],
        reopenRequests: ticket.reopenRequests ?? [],
        history: ticket.history ?? [],
      };
      const statusEvent = appendHistory(
        updated,
        'ticket.status_changed',
        tenant.userId,
        {
          status: {
            before: currentStatus,
            after: status,
          },
          ...(reason !== undefined ? { reason } : {}),
        },
        now,
      );
      if (slaEvidence?.resolution) {
        appendHistory(
          updated,
          SLA_EVIDENCE_ACTIONS.resolution,
          tenant.userId,
          {
            ...slaEvidence.resolution,
            statusEventId: statusEvent.id,
          },
          now,
        );
      }
      if (slaEvidence?.pauseStart) {
        appendHistory(
          updated,
          SLA_EVIDENCE_ACTIONS.pauseStarted,
          tenant.userId,
          {
            ...slaEvidence.pauseStart,
            intervalId: `sla_pause_${randomUUID().replace(/-/g, '')}`,
          },
          now,
        );
      } else if (slaEvidence?.pauseEnd && activePause) {
        appendHistory(
          updated,
          SLA_EVIDENCE_ACTIONS.pauseEnded,
          tenant.userId,
          { intervalId: activePause.intervalId },
          now,
        );
      }
      records[records.indexOf(ticket)] = updated;
      await this.writeRecords(records);
      return updated;
    });
  }

  async requestReopen(
    tenant: TenantContext,
    ticketId: string,
    expectedStatus: string,
    request: TicketReopenRequest,
    workflowId: string,
  ): Promise<[TicketRecord, TicketReopenRequest] | null> {
    return this.withLock(async () => {
      const records = await this.readRecords();
      const ticket = records.find(
        (record) =>
          record.id === ticketId &&
          record.organisationId === tenant.organisationId,
      );
      if (!ticket) {
        return null;
      }
      if (normalizeStatus(ticket.status) !== normalizeStatus(expectedStatus)) {
        throw new TicketConflictError(
          'Ticket status changed before the reopen request could be saved.',
        );
      }
      if (
        (ticket.reopenRequests ?? []).some(
          (item) => item.status === 'pending',
        )
      ) {
        throw new TicketConflictError(
          'A reopen request is already pending for this ticket.',
        );
      }

      const updated: TicketRecord = {
        ...ticket,
        workflowId: ticket.workflowId ?? workflowId,
        updatedAt: request.createdAt,
        comments: ticket.comments ?? [],
        reopenRequests: [...(ticket.reopenRequests ?? []), request],
        history: ticket.history ?? [],
      };
      appendHistory(updated, 'ticket.reopen_requested', tenant.userId, {
        requestId: request.id,
        fromStatus: request.fromStatus,
        toStatus: request.toStatus,
        reason: request.reason,
      });
      records[records.indexOf(ticket)] = updated;
      await this.writeRecords(records);
      return [updated, request];
    });
  }

  async approveReopen(
    tenant: TenantContext,
    ticketId: string,
    requestId: string,
    actorId: string,
  ): Promise<[TicketRecord, TicketReopenRequest] | null> {
    return this.withLock(async () => {
      const records = await this.readRecords();
      const ticket = records.find(
        (record) =>
          record.id === ticketId &&
          record.organisationId === tenant.organisationId,
      );
      if (!ticket) {
        return null;
      }
      const reopenRequests = ticket.reopenRequests ?? [];
      const requestIndex = reopenRequests.findIndex(
        (item) => item.id === requestId,
      );
      if (requestIndex === -1) {
        return null;
      }
      const reopenRequest = reopenRequests[requestIndex];
      if (!reopenRequest) {
        return null;
      }
      if (
        reopenRequest.status !== 'pending' ||
        normalizeStatus(ticket.status) !==
          normalizeStatus(reopenRequest.fromStatus)
      ) {
        throw new TicketConflictError(
          'The reopen request is no longer valid for the ticket status.',
        );
      }

      const now = new Date().toISOString();
      const approvedRequest: TicketReopenRequest = {
        ...reopenRequest,
        status: 'approved',
        reviewedBy: actorId,
        reviewedAt: now,
      };
      reopenRequests[requestIndex] = approvedRequest;
      const updated: TicketRecord = {
        ...ticket,
        status: reopenRequest.toStatus,
        updatedAt: now,
        comments: ticket.comments ?? [],
        reopenRequests: [...reopenRequests],
        history: ticket.history ?? [],
      };
      appendHistory(updated, 'ticket.status_changed', actorId, {
        status: {
          before: ticket.status ?? null,
          after: reopenRequest.toStatus,
        },
        requestId,
        reason: reopenRequest.reason,
      });
      records[records.indexOf(ticket)] = updated;
      await this.writeRecords(records);
      return [updated, approvedRequest];
    });
  }

  async addComment(
    tenant: TenantContext,
    ticketId: string,
    comment: Omit<TicketComment, 'id' | 'createdAt'>,
    recordAsSlaAcknowledgement = false,
  ): Promise<[TicketRecord, TicketComment] | null> {
    return this.withLock(async () => {
      const records = await this.readRecords();
      const ticket = records.find(
        (record) =>
          record.id === ticketId &&
          record.organisationId === tenant.organisationId,
      );
      if (!ticket) {
        return null;
      }

      const storedComment: TicketComment = {
        id: `comment_${randomUUID().replace(/-/g, '')}`,
        ...comment,
        createdAt: new Date().toISOString(),
      };
      const updated: TicketRecord = {
        ...ticket,
        updatedAt: storedComment.createdAt,
        comments: [...(ticket.comments ?? []), storedComment],
        history: [...(ticket.history ?? [])],
      };
      appendHistory(
        updated,
        'ticket.comment_added',
        tenant.userId,
        {
          commentId: storedComment.id,
          visibility: comment.visibility,
        },
        storedComment.createdAt,
      );
      if (
        recordAsSlaAcknowledgement &&
        !(ticket.history ?? []).some(
          (event) => event.action === SLA_EVIDENCE_ACTIONS.acknowledgement,
        )
      ) {
        appendHistory(
          updated,
          SLA_EVIDENCE_ACTIONS.acknowledgement,
          tenant.userId,
          { commentId: storedComment.id },
          storedComment.createdAt,
        );
      }
      records[records.indexOf(ticket)] = updated;
      await this.writeRecords(records);
      return [updated, storedComment];
    });
  }

  async recordSlaEvidence(
    tenant: TenantContext,
    ticketId: string,
    evidence: SlaEvidenceWrite,
  ): Promise<[TicketRecord, TicketHistoryEvent] | null> {
    return this.withLock(async () => {
      const records = await this.readRecords();
      const ticket = records.find(
        (record) =>
          record.id === ticketId &&
          record.organisationId === tenant.organisationId,
      );
      if (!ticket) {
        return null;
      }
      const history = ticket.history ?? [];
      let action: string;
      let changes: Record<string, JsonValue>;
      if (evidence.type === 'assessment_completed') {
        if (
          history.some(
            (event) => event.action === SLA_EVIDENCE_ACTIONS.assessment,
          )
        ) {
          throw new TicketConflictError(
            'Initial assessment evidence has already been recorded.',
          );
        }
        action = SLA_EVIDENCE_ACTIONS.assessment;
        changes = { evidence: evidence.evidence };
      } else if (evidence.type === 'exclusion_started') {
        const activePause = findActiveSlaInterval(
          history,
          SLA_EVIDENCE_ACTIONS.pauseStarted,
          SLA_EVIDENCE_ACTIONS.pauseEnded,
        );
        const activeExclusion = findActiveSlaInterval(
          history,
          SLA_EVIDENCE_ACTIONS.exclusionStarted,
          SLA_EVIDENCE_ACTIONS.exclusionEnded,
        );
        if (activePause || activeExclusion) {
          throw new TicketConflictError(
            'An SLA pause or exclusion interval is already active.',
          );
        }
        action = SLA_EVIDENCE_ACTIONS.exclusionStarted;
        changes = {
          intervalId: evidence.intervalId,
          reasonCode: evidence.reasonCode,
          evidence: evidence.evidence,
          contractReference: evidence.contractReference,
        };
      } else {
        const activeExclusion = findActiveSlaInterval(
          history,
          SLA_EVIDENCE_ACTIONS.exclusionStarted,
          SLA_EVIDENCE_ACTIONS.exclusionEnded,
        );
        if (!activeExclusion || activeExclusion.intervalId !== evidence.intervalId) {
          throw new TicketConflictError(
            'The specified SLA exclusion is not active.',
          );
        }
        action = SLA_EVIDENCE_ACTIONS.exclusionEnded;
        changes = { intervalId: evidence.intervalId };
      }
      const now = new Date().toISOString();
      const updated: TicketRecord = {
        ...ticket,
        updatedAt: now,
        comments: ticket.comments ?? [],
        history: [...history],
      };
      const event = appendHistory(updated, action, tenant.userId, changes, now);
      records[records.indexOf(ticket)] = updated;
      await this.writeRecords(records);
      return [updated, event];
    });
  }

  async addAttachment(
    tenant: TenantContext,
    ticketId: string,
    attachment: Omit<TicketAttachment, 'createdAt'>,
  ): Promise<[TicketRecord, TicketAttachment] | null> {
    if (!attachment.id || !attachment.storageKey || !attachment.fileName) {
      throw new TicketStoreError('Ticket attachment metadata is incomplete.');
    }

    return this.withLock(async () => {
      const records = await this.readRecords();
      const ticket = records.find(
        (record) =>
          record.id === ticketId &&
          record.organisationId === tenant.organisationId,
      );
      if (!ticket) {
        return null;
      }

      const storedAttachment: TicketAttachment = {
        ...attachment,
        createdAt: new Date().toISOString(),
      };
      const updated: TicketRecord = {
        ...ticket,
        updatedAt: storedAttachment.createdAt,
        attachments: [...(ticket.attachments ?? []), storedAttachment],
        comments: [...(ticket.comments ?? [])],
        history: [...(ticket.history ?? [])],
      };
      appendHistory(updated, 'ticket.attachment_added', tenant.userId, {
        attachmentId: storedAttachment.id,
        fileName: storedAttachment.fileName,
        fileSizeBytes: storedAttachment.fileSizeBytes,
      });
      records[records.indexOf(ticket)] = updated;
      await this.writeRecords(records);
      return [updated, storedAttachment];
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => Promise<void>) | undefined;
    try {
      await mkdir(this.dataDirectory, { recursive: true });
      const directory = await open(this.lockPath, 'a');
      await directory.close();
      release = await lockfile.lock(this.lockPath, {
        retries: { retries: 10, factor: 1.2, minTimeout: 50, maxTimeout: 250 },
        stale: 30_000,
        update: 10_000,
      });
      return await operation();
    } catch (error) {
      if (error instanceof TicketConflictError || error instanceof TicketStoreError) {
        throw error;
      }
      throw new TicketStoreError('Ticket storage could not be accessed.', {
        cause: error,
      });
    } finally {
      if (release) {
        try {
          await release();
        } catch (error) {
          throw new TicketStoreError('Ticket storage lock could not be released.', {
            cause: error,
          });
        }
      }
    }
  }

  private async readRecords(): Promise<TicketRecord[]> {
    let document: unknown;
    try {
      document = JSON.parse(await readFile(this.ticketsPath, 'utf8'));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }
      throw new TicketStoreError(
        'Ticket storage could not be read as valid JSON.',
        { cause: error },
      );
    }

    if (
      !isRecord(document) ||
      document.schemaVersion !== 1 ||
      !Array.isArray(document.records) ||
      document.records.some((record) => !isTicketRecord(record))
    ) {
      throw new TicketStoreError(
        'Ticket storage does not match the supported schema.',
      );
    }
    return document.records.map(normalizeTicketRecordPriority);
  }

  private async writeRecords(records: TicketRecord[]): Promise<void> {
    const temporaryPath = `${this.ticketsPath}.${randomUUID().replace(/-/g, '')}.tmp`;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(temporaryPath, 'wx');
      await file.writeFile(
        `${JSON.stringify({ schemaVersion: 1, records })}`,
        'utf8',
      );
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporaryPath, this.ticketsPath);
    } catch (error) {
      if (file) {
        await file.close();
      }
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
          throw new TicketStoreError(
            'Ticket storage temporary file could not be removed.',
            { cause: cleanupError },
          );
        }
      }
      throw new TicketStoreError(
        'Ticket storage could not be written safely.',
        { cause: error },
      );
    }
  }
}

function normalizeTicketRecordPriority<T extends { priority?: string | null }>(
  ticket: T,
): T {
  if (typeof ticket.priority !== 'string') return ticket;
  const priority = normalizeStoredTicketPriority(ticket.priority);
  return priority === ticket.priority ? ticket : { ...ticket, priority };
}

function changedValues(
  existing: TicketRecord,
  changes: Partial<TicketRecord>,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(changes)) {
    const before = existing[key as keyof TicketRecord] ?? null;
    const after = value ?? null;
    if (!isDeepStrictEqual(before, after)) {
      result[key] = { before: before as JsonValue, after: after as JsonValue };
    }
  }
  return result;
}

function appendHistory(
  ticket: TicketRecord,
  action: string,
  actorId: string,
  changes: Record<string, JsonValue>,
  createdAt = new Date().toISOString(),
): TicketHistoryEvent {
  const event: TicketHistoryEvent = {
    id: `history_${randomUUID().replace(/-/g, '')}`,
    action,
    actorId,
    createdAt,
    changes,
  };
  ticket.history = [...(ticket.history ?? []), event];
  return event;
}

function findActiveSlaInterval(
  history: TicketHistoryEvent[],
  startAction: string,
  endAction: string,
): { intervalId: string } | null {
  let active: { intervalId: string } | null = null;
  for (const event of history) {
    if (event.action === startAction) {
      const intervalId = event.changes.intervalId;
      if (typeof intervalId !== 'string' || !intervalId) {
        throw new TicketStoreError(
          'SLA interval history is missing its interval identifier.',
        );
      }
      if (active) {
        throw new TicketStoreError('SLA interval history contains overlapping intervals.');
      }
      active = { intervalId };
    } else if (event.action === endAction) {
      const intervalId = event.changes.intervalId;
      if (!active || intervalId !== active.intervalId) {
        throw new TicketStoreError(
          'SLA interval history contains an unmatched end event.',
        );
      }
      active = null;
    }
  }
  return active;
}

function isTicketRecord(value: unknown): value is TicketRecord {
  if (
    !isRecord(value) ||
    !['id', 'organisationId', 'requesterId', 'title', 'createdAt', 'updatedAt'].every(
      (field) => typeof value[field] === 'string' && value[field],
    )
  ) {
    return false;
  }

  if (value.source !== undefined) {
    const source = value.source;
    if (
      !isRecord(source) ||
      source.system !== 'jira' ||
      !['issueId', 'issueKey', 'projectKey'].every(
        (field) => typeof source[field] === 'string' && source[field],
      ) ||
      !['status', 'priority'].every(
        (field) => source[field] === undefined || typeof source[field] === 'string',
      )
    ) {
      return false;
    }
  }

  if (value.description !== undefined && !isJsonValue(value.description)) {
    return false;
  }
  if (
    (value.workflowId !== undefined &&
      (typeof value.workflowId !== 'string' || !value.workflowId)) ||
    (value.reopenRequests !== undefined &&
      (!Array.isArray(value.reopenRequests) ||
        value.reopenRequests.some((request) => !isReopenRequest(request)))) ||
    !['teamId', 'status', 'priority', 'product', 'affectedService'].every(
      (field) =>
        value[field] === undefined ||
        value[field] === null ||
        typeof value[field] === 'string',
    )
  ) {
    return false;
  }
  if (
    value.comments !== undefined &&
    (!Array.isArray(value.comments) || value.comments.some((comment) => !isComment(comment)))
  ) {
    return false;
  }
  if (
    value.attachments !== undefined &&
    (!Array.isArray(value.attachments) ||
      value.attachments.some((attachment) => !isAttachment(attachment)))
  ) {
    return false;
  }
  if (
    value.history !== undefined &&
    (!Array.isArray(value.history) ||
      value.history.some((event) => !isHistoryEvent(event)))
  ) {
    return false;
  }
  return true;
}

function isReopenRequest(value: unknown): value is TicketReopenRequest {
  return (
    isRecord(value) &&
    ['id', 'requestedBy', 'fromStatus', 'toStatus', 'reason', 'createdAt'].every(
      (field) => typeof value[field] === 'string' && value[field],
    ) &&
    ['pending', 'approved'].includes(String(value.status)) &&
    (value.reviewedBy === undefined || typeof value.reviewedBy === 'string') &&
    (value.reviewedAt === undefined || typeof value.reviewedAt === 'string')
  );
}

function normalizeStatus(status: string | undefined): string | undefined {
  return status?.toUpperCase();
}

function isAttachment(value: unknown): value is TicketAttachment {
  return (
    isRecord(value) &&
    ['id', 'fileName', 'mimeType', 'storageKey', 'checksumSha256', 'uploadedBy', 'createdAt'].every(
      (field) => typeof value[field] === 'string' && value[field],
    ) &&
    typeof value.fileSizeBytes === 'number' &&
    Number.isSafeInteger(value.fileSizeBytes) &&
    value.fileSizeBytes > 0
  );
}

function isComment(value: unknown): value is TicketComment {
  return (
    isRecord(value) &&
    ['id', 'authorId', 'body', 'createdAt'].every(
      (field) => typeof value[field] === 'string' && value[field],
    ) &&
    (value.visibility === 'internal' || value.visibility === 'public')
  );
}

function isHistoryEvent(value: unknown): value is TicketHistoryEvent {
  return (
    isRecord(value) &&
    ['id', 'action', 'actorId', 'createdAt'].every(
      (field) => typeof value[field] === 'string' && value[field],
    ) &&
    isJsonValue(value.changes ?? {})
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, item]) => Boolean(key) && isJsonValue(item))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
