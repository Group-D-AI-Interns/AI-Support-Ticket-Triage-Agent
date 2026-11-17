import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  isTicketJsonValue,
  isTicketRecord,
  type TicketComment,
  type TicketHistoryEvent,
  type TicketJsonValue,
  type TicketRecord,
} from './ticket-contracts.js';

const writeQueues = new Map<string, Promise<void>>();

export class TicketStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketStoreError';
  }
}

export class TicketConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketConflictError';
  }
}

export type NewTicketRecord = Omit<
  TicketRecord,
  'id' | 'createdAt' | 'updatedAt' | 'comments' | 'history'
>;

export type NewJiraTicketRecord = NewTicketRecord & {
  source: NonNullable<TicketRecord['source']>;
};

export type TicketCommentInput = Omit<TicketComment, 'id' | 'createdAt'>;

export class TicketJsonStore {
  private readonly ticketsPath: string;
  private readonly dataDirectory: string;

  constructor(dataDirectory: string) {
    this.dataDirectory = resolve(dataDirectory);
    this.ticketsPath = join(this.dataDirectory, 'tickets.json');
  }

  async listTickets(organisationId: string): Promise<TicketRecord[]> {
    return (await this.readRecords())
      .filter((record) => record.organisationId === organisationId);
  }

  async findTicket(organisationId: string, ticketId: string): Promise<TicketRecord | null> {
    const records = await this.readRecords();
    return records.find(
      (record) => record.organisationId === organisationId && record.id === ticketId,
    ) ?? null;
  }

  async createTicket(ticket: NewTicketRecord, actorId: string): Promise<TicketRecord> {
    return this.withWriteLock(async () => {
      const records = await this.readRecords();
      const timestamp = utcTimestamp();
      const created: TicketRecord = {
        id: `ticket_${randomUUID().replace(/-/g, '')}`,
        ...ticket,
        createdAt: timestamp,
        updatedAt: timestamp,
        comments: [],
        history: [],
      };
      appendHistory(created, 'ticket.created', actorId, {});
      records.push(created);
      await this.writeRecords(records);
      return created;
    });
  }

  async updateTicket(
    organisationId: string,
    ticketId: string,
    changes: Partial<Pick<
      TicketRecord,
      'title' | 'description' | 'product' | 'affectedService' | 'teamId'
    >>,
    actorId: string,
  ): Promise<TicketRecord | null> {
    return this.withWriteLock(async () => {
      const records = await this.readRecords();
      const index = records.findIndex(
        (record) => record.organisationId === organisationId && record.id === ticketId,
      );
      if (index === -1) {
        return null;
      }

      const existing = records[index];
      const changedValues: Record<string, TicketJsonValue> = {};
      for (const [key, value] of Object.entries(changes)) {
        if (value !== undefined && !jsonValuesEqual(existing[key as keyof TicketRecord], value)) {
          changedValues[key] = {
            before: toJsonValue(existing[key as keyof TicketRecord]),
            after: value,
          };
        }
      }
      if (Object.keys(changedValues).length === 0) {
        return existing;
      }

      const updated: TicketRecord = {
        ...existing,
        ...changes,
        updatedAt: utcTimestamp(),
      };
      appendHistory(updated, 'ticket.updated', actorId, changedValues);
      records[index] = updated;
      await this.writeRecords(records);
      return updated;
    });
  }

  async addComment(
    organisationId: string,
    ticketId: string,
    comment: TicketCommentInput,
    actorId: string,
  ): Promise<{ ticket: TicketRecord; comment: TicketComment } | null> {
    return this.withWriteLock(async () => {
      const records = await this.readRecords();
      const index = records.findIndex(
        (record) => record.organisationId === organisationId && record.id === ticketId,
      );
      if (index === -1) {
        return null;
      }

      const timestamp = utcTimestamp();
      const storedComment: TicketComment = {
        id: `comment_${randomUUID().replace(/-/g, '')}`,
        ...comment,
        createdAt: timestamp,
      };
      const updated: TicketRecord = {
        ...records[index],
        updatedAt: timestamp,
        comments: [...(records[index].comments ?? []), storedComment],
        history: [...(records[index].history ?? [])],
      };
      appendHistory(updated, 'ticket.comment_added', actorId, {
        commentId: storedComment.id,
        visibility: storedComment.visibility,
      });
      records[index] = updated;
      await this.writeRecords(records);
      return { ticket: updated, comment: storedComment };
    });
  }

  async upsertJiraTicket(
    ticket: NewJiraTicketRecord,
  ): Promise<{ ticket: TicketRecord; outcome: 'created' | 'updated' | 'duplicate' }> {
    return this.withWriteLock(async () => {
      const records = await this.readRecords();
      const existing = records.find(
        (record) => record.organisationId === ticket.organisationId
          && record.source?.system === 'jira'
          && record.source.issueId === ticket.source.issueId,
      );
      const issueKeyCollision = records.some(
        (record) => record.organisationId === ticket.organisationId
          && record.source?.system === 'jira'
          && record.source.issueKey === ticket.source.issueKey
          && record.source.issueId !== ticket.source.issueId,
      );
      if (issueKeyCollision) {
        throw new TicketConflictError('A different Jira issue already uses this issue key.');
      }

      if (existing) {
        if (Object.entries(ticket).every(([key, value]) => (
          jsonValuesEqual(existing[key as keyof TicketRecord], value)
        ))) {
          return { ticket: existing, outcome: 'duplicate' };
        }

        const changes: Record<string, TicketJsonValue> = {};
        for (const [key, value] of Object.entries(ticket)) {
          if (!jsonValuesEqual(existing[key as keyof TicketRecord], value)) {
            changes[key] = {
              before: toJsonValue(existing[key as keyof TicketRecord]),
              after: value,
            };
          }
        }
        const updated: TicketRecord = {
          ...existing,
          ...ticket,
          updatedAt: utcTimestamp(),
          comments: existing.comments ?? [],
          history: [...(existing.history ?? [])],
        };
        appendHistory(updated, 'jira.issue_updated', 'jira_webhook', changes);
        records[records.indexOf(existing)] = updated;
        await this.writeRecords(records);
        return { ticket: updated, outcome: 'updated' };
      }

      const timestamp = utcTimestamp();
      const created: TicketRecord = {
        id: `ticket_${randomUUID().replace(/-/g, '')}`,
        ...ticket,
        createdAt: timestamp,
        updatedAt: timestamp,
        comments: [],
        history: [],
      };
      appendHistory(created, 'jira.issue_created', 'jira_webhook', {});
      records.push(created);
      await this.writeRecords(records);
      return { ticket: created, outcome: 'created' };
    });
  }

  private async readRecords(): Promise<TicketRecord[]> {
    let text: string;
    try {
      text = await readFile(this.ticketsPath, 'utf8');
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        return [];
      }
      throw new TicketStoreError('Ticket storage could not be accessed.');
    }

    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw new TicketStoreError('Ticket storage could not be read as valid JSON.');
    }

    if (
      !isRecord(document)
      || document.schemaVersion !== 1
      || !Array.isArray(document.records)
      || !document.records.every(isTicketRecord)
    ) {
      throw new TicketStoreError('Ticket storage does not match the supported schema.');
    }
    return document.records;
  }

  private async writeRecords(records: TicketRecord[]): Promise<void> {
    if (!records.every(isTicketRecord)) {
      throw new TicketStoreError('Ticket storage contains an invalid ticket record.');
    }
    await mkdir(this.dataDirectory, { recursive: true });
    const temporaryPath = join(
      this.dataDirectory,
      `tickets.json.${randomUUID().replace(/-/g, '')}.tmp`,
    );
    const payload = `${JSON.stringify({ schemaVersion: 1, records })}\n`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      handle = await open(temporaryPath, 'wx');
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.ticketsPath);
    } catch {
      if (handle) {
        await handle.close();
      }
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) {
          throw new TicketStoreError('Temporary ticket data could not be cleaned up.');
        }
      }
      throw new TicketStoreError('Ticket storage could not be written safely.');
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = writeQueues.get(this.ticketsPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    writeQueues.set(this.ticketsPath, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (writeQueues.get(this.ticketsPath) === current) {
        writeQueues.delete(this.ticketsPath);
      }
    }
  }
}

function appendHistory(
  ticket: TicketRecord,
  action: string,
  actorId: string,
  changes: Record<string, TicketJsonValue>,
): void {
  const event: TicketHistoryEvent = {
    id: `history_${randomUUID().replace(/-/g, '')}`,
    action,
    actorId,
    createdAt: utcTimestamp(),
    changes,
  };
  ticket.history = [...(ticket.history ?? []), event];
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index]
        && jsonValuesEqual(left[key], right[key]));
  }
  return false;
}

function toJsonValue(value: unknown): TicketJsonValue {
  return isTicketJsonValue(value) ? value : null;
}

function isErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utcTimestamp(): string {
  return new Date().toISOString();
}
