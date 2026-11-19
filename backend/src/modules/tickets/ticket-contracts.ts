export type TicketJsonValue =
  | string
  | number
  | boolean
  | null
  | TicketJsonValue[]
  | { [key: string]: TicketJsonValue };

export type JiraTicketSource = {
  system: 'jira';
  issueId: string;
  issueKey: string;
  projectKey: string;
  status?: string | null;
  priority?: string | null;
};

export type TicketComment = {
  id: string;
  authorId: string;
  body: string;
  visibility: 'internal' | 'public';
  createdAt: string;
};

export type TicketHistoryEvent = {
  id: string;
  action: string;
  actorId: string;
  createdAt: string;
  changes?: TicketJsonValue;
};

export type TicketRecord = {
  id: string;
  organisationId: string;
  requesterId: string;
  title: string;
  description?: TicketJsonValue;
  product?: string | null;
  affectedService?: string | null;
  teamId?: string | null;
  status?: string | null;
  priority?: string | null;
  source?: JiraTicketSource;
  comments?: TicketComment[] | null;
  history?: TicketHistoryEvent[] | null;
  createdAt: string;
  updatedAt: string;
};

export type TicketCollection = {
  schemaVersion: 1;
  records: TicketRecord[];
};

export type CreateTicketRequest = {
  title: string;
  description: string;
  product?: string | null;
  affectedService?: string | null;
};

export type PatchTicketRequest = {
  title?: string | null;
  description?: string | null;
  product?: string | null;
  affectedService?: string | null;
  teamId?: string | null;
};

export type CreateTicketCommentRequest = {
  body: string;
  visibility: 'internal' | 'public';
};

export type TicketListQuery = {
  q?: string;
  status?: string;
  priority?: string;
  teamId?: string;
  requesterId?: string;
  limit: number;
  offset: number;
};

export function isTicketRecord(value: unknown): value is TicketRecord {
  if (!isRecord(value)) {
    return false;
  }
  if (!hasNonEmptyStrings(value, [
    'id',
    'organisationId',
    'requesterId',
    'title',
    'createdAt',
    'updatedAt',
  ])) {
    return false;
  }

  if (
    (value.description !== undefined && !isTicketJsonValue(value.description))
    || !isOptionalString(value.teamId)
    || !isOptionalString(value.status)
    || !isOptionalString(value.priority)
    || !isOptionalString(value.product)
    || !isOptionalString(value.affectedService)
    || (value.source !== undefined && !isJiraTicketSource(value.source))
    || (value.comments !== undefined
      && value.comments !== null
      && !isTicketCommentArray(value.comments))
    || (value.history !== undefined
      && value.history !== null
      && !isTicketHistoryArray(value.history))
  ) {
    return false;
  }

  return true;
}

export function isTicketJsonValue(value: unknown): value is TicketJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isTicketJsonValue);
  }
  if (isRecord(value)) {
    return Object.entries(value).every(
      ([key, entry]) => typeof key === 'string' && isTicketJsonValue(entry),
    );
  }
  return false;
}

function isJiraTicketSource(value: unknown): value is JiraTicketSource {
  if (!isRecord(value)) {
    return false;
  }
  return value.system === 'jira'
    && hasNonEmptyStrings(value, ['issueId', 'issueKey', 'projectKey'])
    && isOptionalString(value.status)
    && isOptionalString(value.priority);
}

function isTicketCommentArray(value: unknown): value is TicketComment[] {
  return Array.isArray(value) && value.every((comment) => (
    isRecord(comment)
    && hasNonEmptyStrings(comment, ['id', 'authorId', 'body', 'visibility', 'createdAt'])
    && (comment.visibility === 'internal' || comment.visibility === 'public')
  ));
}

function isTicketHistoryArray(value: unknown): value is TicketHistoryEvent[] {
  return Array.isArray(value) && value.every((event) => (
    isRecord(event)
    && hasNonEmptyStrings(event, ['id', 'action', 'actorId', 'createdAt'])
    && isTicketJsonValue(event.changes ?? {})
  ));
}

function hasNonEmptyStrings(
  value: Record<string, unknown>,
  fields: string[],
): boolean {
  return fields.every((field) => (
    typeof value[field] === 'string' && value[field].length > 0
  ));
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
