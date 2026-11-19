import { randomUUID } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import { isTicketJsonValue, type TicketJsonValue, type TicketRecord } from './ticket-contracts.js';
import {
  matchesBearerToken,
  type DevelopmentPrincipal,
  type TicketRole,
} from './development-auth.js';
import type { JiraSettings } from './jira-config.js';
import {
  TicketConflictError,
  TicketJsonStore,
  TicketStoreError,
  type NewTicketRecord,
} from './ticket-json-store.js';

const maximumRequestBodyBytes = 1024 * 1024;

export type TicketApiDependencies = {
  store: TicketJsonStore;
  jiraSettings: JiraSettings;
  developmentPrincipal: DevelopmentPrincipal | null;
};

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly fields: Array<{ field: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function createTicketApi(dependencies: TicketApiDependencies): RequestListener {
  return (request, response) => {
    const requestId = `req_${randomUUID().replace(/-/g, '')}`;
    response.setHeader('X-Request-ID', requestId);
    void dispatch(request, response, dependencies, requestId).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof ApiError) {
        sendJson(response, error.statusCode, {
          error: {
            code: error.code,
            message: error.message,
            requestId,
            fields: error.fields,
          },
        });
        return;
      }
      if (error instanceof TicketConflictError) {
        sendJson(response, 409, {
          error: {
            code: 'CONFLICT',
            message: error.message,
            requestId,
            fields: [],
          },
        });
        return;
      }
      if (error instanceof TicketStoreError) {
        sendJson(response, 500, {
          error: {
            code: 'STORAGE_ERROR',
            message: error.message,
            requestId,
            fields: [],
          },
        });
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The request could not be completed.',
          requestId,
          fields: [],
        },
      });
    });
  };
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: TicketApiDependencies,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean).map(decodePathSegment);

  if (
    segments.length === 6
    && segments[0] === 'api'
    && segments[1] === 'v1'
    && segments[2] === 'tickets'
    && segments[3] === 'ingest'
    && segments[4] === 'jira'
  ) {
    requireMethod(request, 'POST');
    await ingestJiraTicket(
      request,
      response,
      dependencies,
      requestId,
      segments[5],
    );
    return;
  }

  if (
    segments.length < 3
    || segments[0] !== 'api'
    || segments[1] !== 'v1'
    || segments[2] !== 'tickets'
  ) {
    throw new ApiError(404, 'NOT_FOUND', 'Resource not found.');
  }

  if (segments.length === 3) {
    if (request.method === 'POST') {
      await createTicket(request, response, dependencies, requestId);
      return;
    }
    if (request.method === 'GET') {
      await listTickets(request, response, dependencies, requestId, url);
      return;
    }
    throw methodNotAllowed();
  }

  if (segments.length === 4) {
    const ticketId = segments[3];
    if (request.method === 'GET') {
      await getTicket(request, response, dependencies, requestId, ticketId);
      return;
    }
    if (request.method === 'PATCH') {
      await updateTicket(request, response, dependencies, requestId, ticketId);
      return;
    }
    throw methodNotAllowed();
  }

  if (segments.length === 5 && segments[4] === 'comments') {
    const ticketId = segments[3];
    if (request.method === 'GET') {
      await listComments(request, response, dependencies, requestId, ticketId);
      return;
    }
    if (request.method === 'POST') {
      await addComment(request, response, dependencies, requestId, ticketId);
      return;
    }
    throw methodNotAllowed();
  }

  if (segments.length === 5 && segments[4] === 'audit' && request.method === 'GET') {
    await getAudit(request, response, dependencies, requestId, segments[3]);
    return;
  }

  throw new ApiError(404, 'NOT_FOUND', 'Resource not found.');
}

async function createTicket(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: TicketApiDependencies,
  requestId: string,
): Promise<void> {
  const principal = authenticate(request, dependencies.developmentPrincipal);
  const body = await readJsonBody(request);
  const input = parseCreateTicketBody(body);
  const ticket = await dependencies.store.createTicket({
    organisationId: principal.organisationId,
    requesterId: principal.userId,
    ...input,
    status: 'new',
  }, principal.userId);

  sendJson(response, 201, { data: ticketResponse(ticket), requestId });
}

async function listTickets(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: TicketApiDependencies,
  requestId: string,
  url: URL,
): Promise<void> {
  const principal = authenticate(request, dependencies.developmentPrincipal);
  const filters = parseListQuery(url);
  const visible = (await dependencies.store.listTickets(principal.organisationId))
    .filter((ticket) => canAccessTicket(principal, ticket))
    .filter((ticket) => matchesFilters(ticket, filters))
    .sort((left, right) => (
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
    ));
  const data = visible
    .slice(filters.offset, filters.offset + filters.limit)
    .map(ticketResponse);

  sendJson(response, 200, {
    data,
    pagination: {
      limit: filters.limit,
      offset: filters.offset,
      total: visible.length,
    },
    requestId,
  });
}

async function getTicket(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: TicketApiDependencies,
  requestId: string,
  ticketId: string,
): Promise<void> {
  const principal = authenticate(request, dependencies.developmentPrincipal);
  const ticket = await findAccessibleTicket(dependencies.store, principal, ticketId);
  sendJson(response, 200, {
    data: {
      ...ticketResponse(ticket),
      comments: visibleComments(principal, ticket),
    },
    requestId,
  });
}

async function updateTicket(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: TicketApiDependencies,
  requestId: string,
  ticketId: string,
): Promise<void> {
  const principal = authenticate(request, dependencies.developmentPrincipal);
  if (!hasSupportRole(principal)) {
    throw new ApiError(403, 'FORBIDDEN', 'Only support staff can update tickets.');
  }
  const ticket = await findAccessibleTicket(dependencies.store, principal, ticketId);
  const changes = parsePatchTicketBody(await readJsonBody(request));
  if (Object.keys(changes).length === 0) {
    throw validationError('body', 'At least one permitted field must be provided.');
  }
  if (Object.hasOwn(changes, 'teamId')) {
    if (!principal.roles.has('support_lead')) {
      throw new ApiError(403, 'FORBIDDEN', 'Only a support lead can assign a ticket team.');
    }
    if (
      changes.teamId !== null
      && changes.teamId !== undefined
      && !principal.teamIds.has(changes.teamId)
    ) {
      throw new ApiError(
        403,
        'TEAM_SCOPE_FORBIDDEN',
        'The requested team is outside the authenticated user team scope.',
      );
    }
  }
  if (changes.title !== undefined && changes.title !== null) {
    changes.title = changes.title.trim();
  }

  const updated = await dependencies.store.updateTicket(
    principal.organisationId,
    ticket.id,
    changes,
    principal.userId,
  );
  if (!updated) {
    throw ticketNotFound();
  }
  sendJson(response, 200, { data: ticketResponse(updated), requestId });
}

async function addComment(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: TicketApiDependencies,
  requestId: string,
  ticketId: string,
): Promise<void> {
  const principal = authenticate(request, dependencies.developmentPrincipal);
  const ticket = await findAccessibleTicket(dependencies.store, principal, ticketId);
  const comment = parseCreateCommentBody(await readJsonBody(request));
  if (comment.visibility === 'internal' && !hasSupportRole(principal)) {
    throw new ApiError(403, 'FORBIDDEN', 'Requesters cannot add internal comments.');
  }
  const created = await dependencies.store.addComment(
    principal.organisationId,
    ticket.id,
    { ...comment, authorId: principal.userId },
    principal.userId,
  );
  if (!created) {
    throw ticketNotFound();
  }
  sendJson(response, 201, { data: created.comment, requestId });
}

async function listComments(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: TicketApiDependencies,
  requestId: string,
  ticketId: string,
): Promise<void> {
  const principal = authenticate(request, dependencies.developmentPrincipal);
  const ticket = await findAccessibleTicket(dependencies.store, principal, ticketId);
  sendJson(response, 200, {
    data: visibleComments(principal, ticket),
    requestId,
  });
}

async function getAudit(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: TicketApiDependencies,
  requestId: string,
  ticketId: string,
): Promise<void> {
  const principal = authenticate(request, dependencies.developmentPrincipal);
  if (!hasSupportRole(principal)) {
    throw new ApiError(403, 'FORBIDDEN', 'Ticket audit is restricted to support staff.');
  }
  const ticket = await findAccessibleTicket(dependencies.store, principal, ticketId);
  sendJson(response, 200, {
    data: ticket.history ?? [],
    requestId,
  });
}

async function ingestJiraTicket(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: TicketApiDependencies,
  requestId: string,
  webhookSecret: string,
): Promise<void> {
  const body = await readJsonBody(request);
  if (!isRecord(body) || typeof body.webhookEvent !== 'string' || !isRecord(body.issue)) {
    throw validationError('body', 'A Jira webhook event and issue object are required.');
  }
  const fields = body.issue.fields;
  const project = isRecord(fields) && isRecord(fields.project) ? fields.project : null;
  const projectKey = project?.key;
  if (typeof projectKey !== 'string' || !projectKey) {
    throw validationError('issue.fields.project.key', 'Project key is required.');
  }

  const organisationId = dependencies.jiraSettings.projectMappings.get(projectKey);
  if (!organisationId) {
    throw new ApiError(
      401,
      'JIRA_WEBHOOK_UNAUTHORIZED',
      'Jira webhook authentication failed.',
    );
  }

  const organisation = dependencies.jiraSettings.organisations.get(organisationId);
  if (!organisation || !constantTimeSecretMatches(webhookSecret, organisation.webhookSecret)) {
    throw new ApiError(
      401,
      'JIRA_WEBHOOK_UNAUTHORIZED',
      'Jira webhook authentication failed.',
    );
  }

  const ticket = mapJiraIssue(
    body.webhookEvent,
    body.issue,
    fields,
    projectKey,
    organisationId,
    organisation.reporterMappings,
  );
  const result = await dependencies.store.upsertJiraTicket(ticket);
  sendJson(response, result.outcome === 'created' ? 201 : 200, {
    data: {
      id: result.ticket.id,
      sourceIssueKey: result.ticket.source?.issueKey,
      outcome: result.outcome,
      createdAt: result.ticket.createdAt,
      updatedAt: result.ticket.updatedAt,
    },
    requestId,
  });
}

function mapJiraIssue(
  webhookEvent: string,
  issue: Record<string, unknown>,
  fields: unknown,
  projectKey: string,
  organisationId: string,
  reporterMappings: ReadonlyMap<string, string>,
): NewTicketRecord & { source: NonNullable<TicketRecord['source']> } {
  if (webhookEvent !== 'jira:issue_created' && webhookEvent !== 'jira:issue_updated') {
    throw new ApiError(
      400,
      'UNSUPPORTED_JIRA_EVENT',
      'Only Jira issue-created and issue-updated events are supported.',
    );
  }
  if (!isRecord(fields)) {
    throw validationError('issue.fields', 'Issue fields are required.');
  }

  const issueId = issue.id;
  const issueKey = issue.key;
  if (typeof issueId !== 'string' || !issueId) {
    throw validationError('issue.id', 'Jira issue ID is required.');
  }
  if (
    typeof issueKey !== 'string'
    || !issueKey.startsWith(`${projectKey}-`)
    || !/^\d+$/.test(issueKey.slice(projectKey.length + 1))
  ) {
    throw validationError('issue.key', 'Issue key must match the configured Jira project.');
  }

  const reporter = isRecord(fields.reporter) ? fields.reporter : null;
  const accountId = reporter?.accountId;
  if (typeof accountId !== 'string' || !accountId) {
    throw validationError(
      'issue.fields.reporter.accountId',
      'Jira reporter account ID is required.',
    );
  }
  const requesterId = reporterMappings.get(accountId);
  if (!requesterId) {
    throw new ApiError(
      403,
      'JIRA_REPORTER_UNMAPPED',
      'The Jira reporter has no configured internal user mapping.',
    );
  }

  const title = fields.summary;
  if (typeof title !== 'string' || !title.trim()) {
    throw validationError('issue.fields.summary', 'Issue summary is required.');
  }
  const description = fields.description;
  if (description !== undefined && description !== null && !isTicketJsonValue(description)) {
    throw validationError(
      'issue.fields.description',
      'Description must be JSON-compatible.',
    );
  }

  return {
    organisationId,
    requesterId,
    title,
    description: description ?? null,
    source: {
      system: 'jira',
      issueId,
      issueKey,
      projectKey,
      status: optionalName(fields, 'status'),
      priority: optionalName(fields, 'priority'),
    },
  };
}

function optionalName(
  fields: Record<string, unknown>,
  field: string,
): string | null {
  const value = fields[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value) || typeof value.name !== 'string') {
    throw validationError(
      `issue.fields.${field}`,
      `${field[0].toUpperCase()}${field.slice(1)} must contain a name.`,
    );
  }
  return value.name;
}

function authenticate(
  request: IncomingMessage,
  principal: DevelopmentPrincipal | null,
): DevelopmentPrincipal {
  if (!principal) {
    throw new ApiError(
      503,
      'AUTHENTICATION_NOT_CONFIGURED',
      'Ticket API authentication is unavailable until an approved identity provider is configured.',
    );
  }
  const authorization = request.headers.authorization;
  if (!authorization) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'A bearer token is required.');
  }
  const [scheme, token, ...extra] = authorization.split(' ');
  if (
    scheme?.toLowerCase() !== 'bearer'
    || !token
    || extra.length > 0
    || !matchesBearerToken(principal.bearerToken, token)
  ) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'The bearer token is invalid.');
  }
  return principal;
}

async function findAccessibleTicket(
  store: TicketJsonStore,
  principal: DevelopmentPrincipal,
  ticketId: string,
): Promise<TicketRecord> {
  const ticket = await store.findTicket(principal.organisationId, ticketId);
  if (!ticket || !canAccessTicket(principal, ticket)) {
    throw ticketNotFound();
  }
  return ticket;
}

function canAccessTicket(principal: DevelopmentPrincipal, ticket: TicketRecord): boolean {
  if (ticket.organisationId !== principal.organisationId) {
    return false;
  }
  if (principal.roles.has('requester') && ticket.requesterId === principal.userId) {
    return true;
  }
  const ticketTeam = ticket.teamId;
  if (principal.roles.has('support_lead') && ticketTeam == null) {
    return true;
  }
  return hasSupportRole(principal)
    && ticketTeam != null
    && principal.teamIds.has(ticketTeam);
}

function hasSupportRole(principal: DevelopmentPrincipal): boolean {
  return principal.roles.has('support_agent') || principal.roles.has('support_lead');
}

function visibleComments(
  principal: DevelopmentPrincipal,
  ticket: TicketRecord,
): NonNullable<TicketRecord['comments']> {
  const comments = ticket.comments ?? [];
  return hasSupportRole(principal)
    ? comments
    : comments.filter((comment) => comment.visibility === 'public');
}

type ListFilters = {
  q?: string;
  status?: string;
  priority?: string;
  teamId?: string;
  requesterId?: string;
  limit: number;
  offset: number;
};

function parseListQuery(url: URL): ListFilters {
  const limitValue = url.searchParams.get('limit');
  const offsetValue = url.searchParams.get('offset');
  const limit = limitValue === null ? 20 : Number(limitValue);
  const offset = offsetValue === null ? 0 : Number(offsetValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw validationError('limit', 'Limit must be an integer between 1 and 100.');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw validationError('offset', 'Offset must be a non-negative integer.');
  }
  return {
    q: url.searchParams.get('q') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    priority: url.searchParams.get('priority') ?? undefined,
    teamId: url.searchParams.get('teamId') ?? undefined,
    requesterId: url.searchParams.get('requesterId') ?? undefined,
    limit,
    offset,
  };
}

function matchesFilters(ticket: TicketRecord, filters: ListFilters): boolean {
  const effectiveStatus = ticket.status !== undefined ? ticket.status : ticket.source?.status;
  const effectivePriority = ticket.priority !== undefined
    ? ticket.priority
    : ticket.source?.priority;
  if (
    filters.status !== undefined
    && effectiveStatus?.toLowerCase() !== filters.status.toLowerCase()
  ) {
    return false;
  }
  if (
    filters.priority !== undefined
    && effectivePriority?.toLowerCase() !== filters.priority.toLowerCase()
  ) {
    return false;
  }
  if (filters.teamId !== undefined && ticket.teamId !== filters.teamId) {
    return false;
  }
  if (filters.requesterId !== undefined && ticket.requesterId !== filters.requesterId) {
    return false;
  }
  if (filters.q !== undefined) {
    const text = [
      ticket.title,
      searchableDescription(ticket.description),
      ticket.product ?? '',
      ticket.affectedService ?? '',
    ].join(' ').toLowerCase();
    if (!text.includes(filters.q.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function searchableDescription(value: TicketJsonValue | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  return JSON.stringify(value);
}

function ticketResponse(ticket: TicketRecord): Record<string, unknown> {
  const { comments: _comments, history: _history, ...response } = ticket;
  return response;
}

function parseCreateTicketBody(value: unknown): Omit<NewTicketRecord, 'organisationId' | 'requesterId' | 'status'> {
  const body = requireObjectWithFields(
    value,
    ['title', 'description'],
    ['product', 'affectedService'],
  );
  const title = requiredText(body.title, 'title');
  const description = body.description;
  if (typeof description !== 'string' || !description.trim()) {
    throw validationError('description', 'description must be a non-empty string.');
  }
  return {
    title,
    description,
    product: optionalText(body, 'product') ?? null,
    affectedService: optionalText(body, 'affectedService') ?? null,
  };
}

function parsePatchTicketBody(
  value: unknown,
): Partial<Pick<TicketRecord, 'title' | 'description' | 'product' | 'affectedService' | 'teamId'>> {
  const body = requireObjectWithFields(
    value,
    [],
    ['title', 'description', 'product', 'affectedService', 'teamId'],
  );
  const changes: Partial<Pick<
    TicketRecord,
    'title' | 'description' | 'product' | 'affectedService' | 'teamId'
  >> = {};
  if (Object.hasOwn(body, 'title')) {
    changes.title = requiredText(body.title, 'title');
  }
  if (Object.hasOwn(body, 'description')) {
    changes.description = optionalText(body, 'description');
  }
  if (Object.hasOwn(body, 'product')) {
    changes.product = optionalText(body, 'product');
  }
  if (Object.hasOwn(body, 'affectedService')) {
    changes.affectedService = optionalText(body, 'affectedService');
  }
  if (Object.hasOwn(body, 'teamId')) {
    changes.teamId = optionalText(body, 'teamId');
  }
  return changes;
}

function parseCreateCommentBody(
  value: unknown,
): { body: string; visibility: 'internal' | 'public' } {
  const input = requireObjectWithFields(value, ['body', 'visibility'], []);
  const body = requiredText(input.body, 'body');
  if (input.visibility !== 'internal' && input.visibility !== 'public') {
    throw validationError('visibility', 'Visibility must be internal or public.');
  }
  return { body, visibility: input.visibility };
}

function requireObjectWithFields(
  value: unknown,
  required: string[],
  optional: string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw validationError('body', 'The request body must be an object.');
  }
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((field) => !Object.hasOwn(value, field))
    || Object.keys(value).some((field) => !allowed.has(field))
  ) {
    throw validationError('body', 'The request body contains missing or unsupported fields.');
  }
  return value;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError(field, `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== 'string') {
    throw validationError(field, `${field} must be a string or null.`);
  }
  return value;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumRequestBodyBytes) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the allowed size.');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw validationError('body', 'The request body must contain valid JSON.');
  }
}

function requireMethod(request: IncomingMessage, method: string): void {
  if (request.method !== method) {
    throw methodNotAllowed();
  }
}

function methodNotAllowed(): ApiError {
  return new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw validationError('path', 'Path contains invalid encoding.');
  }
}

function constantTimeSecretMatches(provided: string, expected: string): boolean {
  return matchesBearerToken(expected, provided);
}

function ticketNotFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(
    400,
    'VALIDATION_ERROR',
    'The request is invalid.',
    [{ field, message }],
  );
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
