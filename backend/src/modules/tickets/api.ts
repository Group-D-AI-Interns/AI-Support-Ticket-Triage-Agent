import { randomUUID } from 'node:crypto';
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import multer from 'multer';

import {
  createLocalPrivateStorageAdapter,
  type DocumentStorageAdapter,
} from '../documents/storage/document-storage.js';
import { MAX_DOCUMENT_SIZE_BYTES } from '../documents/validators/document-validation.js';
import {
  ConfigurationError,
  jiraSettingsFromEnvironment,
  type JiraSettings,
} from './config.js';
import {
  JsonTicketReadService,
  type TicketReadModel,
  type TicketReadService,
} from './application/ticket-read.service.js';
import {
  developmentPrincipalFromEnvironment,
  DevelopmentAuthConfigurationError,
  secureStringEqual,
  type DevelopmentPrincipal,
} from './development-auth.js';
import type {
  JsonValue,
  TicketAttachment,
  TicketRecord,
  TicketSource,
} from './domain/ticket.js';
import type {
  TicketReopenRequest,
  TicketWorkflowConfig,
  TicketWorkflowRecord,
} from './domain/ticket-workflow.js';
import {
  JsonTicketStore,
  TicketConflictError,
  TicketStoreError,
} from './repositories/json-ticket.store.js';
import {
  JsonTicketWorkflowStore,
  TicketWorkflowConflictError,
  TicketWorkflowStoreError,
} from './repositories/json-ticket-workflow.store.js';
import {
  TicketAttachmentService,
  TicketAttachmentValidationError,
} from './services/ticket-attachment.service.js';
import {
  parseTicketWorkflowConfig,
  TicketWorkflowValidationError,
} from './services/ticket-workflow-validation.js';

type ApiErrorField = { field: string; message: string };

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly fields: ApiErrorField[] = [],
  ) {
    super(message);
  }
}

export type TicketAppOptions = {
  settings?: JiraSettings;
  ticketStore?: JsonTicketStore;
  ticketWorkflowStore?: JsonTicketWorkflowStore;
  ticketReadService?: TicketReadService;
  developmentPrincipal?: DevelopmentPrincipal | null;
  attachmentStorage?: DocumentStorageAdapter;
};

export function createTicketApp(options: TicketAppOptions = {}) {
  const settings = options.settings ?? jiraSettingsFromEnvironment();
  const store = options.ticketStore ?? new JsonTicketStore(settings.dataDirectory);
  const workflowStore =
    options.ticketWorkflowStore ??
    new JsonTicketWorkflowStore(settings.dataDirectory);
  const ticketReadService =
    options.ticketReadService ?? new JsonTicketReadService(store);
  const attachmentStorage =
    options.attachmentStorage ??
    createLocalPrivateStorageAdapter(settings.dataDirectory);
  const attachmentService = new TicketAttachmentService(
    store,
    attachmentStorage,
  );
  const principal = Object.prototype.hasOwnProperty.call(
    options,
    'developmentPrincipal',
  )
    ? options.developmentPrincipal ?? null
    : developmentPrincipalFromEnvironment();

  const app = express();
  const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_DOCUMENT_SIZE_BYTES,
      files: 1,
      fields: 0,
      parts: 1,
    },
  });
  app.use((request, response, next) => {
    const requestId = `req_${randomUUID().replace(/-/g, '')}`;
    response.locals.requestId = requestId;
    response.setHeader('X-Request-ID', requestId);
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.post('/api/v1/ticket-workflows', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated);
    const body = parseObjectBody(request.body, ['config']);
    const config = parseTicketWorkflowConfig(body.config);
    const workflow = await workflowStore.createDraft(
      authenticated,
      config,
      authenticated.userId,
    );
    response.status(201).json({
      data: workflowResponse(workflow),
      requestId: requestId(response),
    });
  });

  app.get('/api/v1/ticket-workflows', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated);
    response.json({
      data: (await workflowStore.list(authenticated)).map(workflowResponse),
      requestId: requestId(response),
    });
  });

  app.get('/api/v1/ticket-workflows/active', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    const workflow = await workflowStore.getActive(authenticated);
    if (!workflow) {
      throw new ApiError(
        404,
        'NOT_FOUND',
        'No active ticket workflow is configured.',
      );
    }
    response.json({
      data: workflowResponse(workflow),
      requestId: requestId(response),
    });
  });

  app.post(
    '/api/v1/ticket-workflows/:workflowId/approve',
    async (request, response) => {
      const authenticated = authenticatedPrincipal(request, principal);
      requireOrganisationAdmin(authenticated);
      parseObjectBody(request.body ?? {}, []);
      const workflow = await workflowStore.approve(
        authenticated,
        routeParam(request, 'workflowId'),
        authenticated.userId,
      );
      if (!workflow) {
        throw new ApiError(
          404,
          'NOT_FOUND',
          'Ticket workflow not found.',
        );
      }
      response.json({
        data: workflowResponse(workflow),
        requestId: requestId(response),
      });
    },
  );

  app.post('/api/v1/tickets', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    const body = parseObjectBody(request.body, [
      'title',
      'description',
      'product',
      'affectedService',
    ]);
    const title = requiredText(body, 'title');
    const description = requiredText(body, 'description');
    const product = optionalText(body, 'product');
    const affectedService = optionalText(body, 'affectedService');
    const activeWorkflow = await workflowStore.getActive(authenticated);
    const ticket = await store.createTicket(
      {
        organisationId: authenticated.organisationId,
        requesterId: authenticated.userId,
        ...(activeWorkflow
          ? {
              workflowId: activeWorkflow.id,
              status: activeWorkflow.config.initialStatus,
            }
          : { status: 'new' }),
        title: title.trim(),
        description,
        ...(product !== undefined ? { product } : {}),
        ...(affectedService !== undefined ? { affectedService } : {}),
      },
      authenticated,
    );
    response.status(201).json({
      data: ticketResponse(ticket),
      requestId: requestId(response),
    });
  });

  app.get('/api/v1/tickets', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    const limit = queryInteger(request, 'limit', 20, 1, 100);
    const offset = queryInteger(request, 'offset', 0, 0);
    const filters = {
      q: queryString(request, 'q'),
      status: queryString(request, 'status'),
      priority: queryString(request, 'priority'),
      teamId: queryString(request, 'teamId'),
      requesterId: queryString(request, 'requesterId'),
    };
    const tickets = await ticketReadService.listTickets(authenticated);
    const filtered = tickets
      .filter((ticket) => canAccessTicket(authenticated, ticket))
      .filter((ticket) => matchesTicketFilters(ticket, filters))
      .sort((left, right) => {
        const byCreated = right.createdAt.localeCompare(left.createdAt);
        return byCreated || right.id.localeCompare(left.id);
      });

    response.json({
      data: filtered.slice(offset, offset + limit).map(ticketResponse),
      pagination: { limit, offset, total: filtered.length },
      requestId: requestId(response),
    });
  });

  app.get('/api/v1/tickets/:ticketId', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    const ticket = await findAccessibleTicket(
      store,
      authenticated,
      routeParam(request, 'ticketId'),
    );
    response.json({
      data: {
        ...ticketResponse(ticket),
        comments: visibleComments(authenticated, ticket),
        attachments: (ticket.attachments ?? []).map(publicAttachment),
        reopenRequests: ticket.reopenRequests ?? [],
      },
      requestId: requestId(response),
    });
  });

  app.post(
    '/api/v1/tickets/:ticketId/attachments',
    requireTicketPrincipal(principal),
    attachmentUpload.single('file'),
    async (request, response) => {
      const authenticated = response.locals.ticketPrincipal as DevelopmentPrincipal;
      const ticket = await findAccessibleTicket(
        store,
        authenticated,
        routeParam(request, 'ticketId'),
      );
      if (!request.file) {
        throw validationError('file', 'A file is required.');
      }

      const attachment = await attachmentService.upload(
        authenticated,
        ticket.id,
        {
          fileName: request.file.originalname,
          mimeType: request.file.mimetype,
          content: request.file.buffer,
        },
      );
      if (!attachment) {
        throw ticketNotFound();
      }
      response.status(201).json({
        data: publicAttachment(attachment),
        requestId: requestId(response),
      });
    },
  );

  app.get(
    '/api/v1/tickets/:ticketId/attachments/:attachmentId',
    async (request, response) => {
      const authenticated = authenticatedPrincipal(request, principal);
      const ticket = await findAccessibleTicket(
        store,
        authenticated,
        routeParam(request, 'ticketId'),
      );
      const download = await attachmentService.download(
        authenticated,
        ticket.id,
        routeParam(request, 'attachmentId'),
      );
      if (!download) {
        throw ticketNotFound();
      }

      const safeFileName = download.attachment.fileName.replace(
        /[^a-zA-Z0-9._-]/g,
        '_',
      );
      response.setHeader('Content-Type', download.attachment.mimeType);
      response.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);
      response.setHeader('Content-Length', download.content.length);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.send(download.content);
    },
  );

  app.patch('/api/v1/tickets/:ticketId/status', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    const ticket = await findAccessibleTicket(
      store,
      authenticated,
      routeParam(request, 'ticketId'),
    );
    const body = parseObjectBody(request.body, ['status', 'reason']);
    const requestedStatus = requiredText(body, 'status');
    const reason = optionalText(body, 'reason');
    const workflow = await workflowForTicket(
      workflowStore,
      authenticated,
      ticket,
    );
    const currentStatus = canonicalStatus(
      workflow.config,
      ticket.status ?? workflow.config.initialStatus,
    );
    const nextStatus = canonicalStatus(workflow.config, requestedStatus);
    if (!currentStatus || !nextStatus) {
      throw new ApiError(
        409,
        'WORKFLOW_STATUS_INVALID',
        'The ticket status is not present in its approved workflow.',
      );
    }
    if (!workflow.config.transitions[currentStatus]?.includes(nextStatus)) {
      throw new ApiError(
        409,
        'INVALID_STATUS_TRANSITION',
        `Transition from ${currentStatus} to ${nextStatus} is not permitted.`,
      );
    }
    authorizeStatusChange(authenticated, workflow.config, currentStatus, nextStatus);
    if (
      nextStatus === workflow.config.reopenStatus &&
      (!reason || !reason.trim())
    ) {
      throw validationError(
        'reason',
        'A reason is required when reopening a ticket.',
      );
    }

    const updated = await store.changeStatus(
      authenticated,
      ticket.id,
      ticket.status ?? currentStatus,
      nextStatus,
      reason?.trim(),
      workflow.id,
    );
    if (!updated) {
      throw ticketNotFound();
    }
    response.json({
      data: ticketResponse(updated),
      requestId: requestId(response),
    });
  });

  app.post(
    '/api/v1/tickets/:ticketId/reopen-requests',
    async (request, response) => {
      const authenticated = authenticatedPrincipal(request, principal);
      const ticket = await findAccessibleTicket(
        store,
        authenticated,
        routeParam(request, 'ticketId'),
      );
      const body = parseObjectBody(request.body, ['reason']);
      const reason = requiredText(body, 'reason').trim();
      const workflow = await workflowForTicket(
        workflowStore,
        authenticated,
        ticket,
      );
      if (
        !hasAnyRole(
          authenticated,
          workflow.config.permissions.reopenRequestRoles,
        ) ||
        !authenticated.roles.includes('requester') ||
        ticket.requesterId !== authenticated.userId
      ) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'The authenticated role cannot request a ticket reopening.',
        );
      }

      const currentStatus = canonicalStatus(workflow.config, ticket.status);
      if (
        !currentStatus ||
        !workflow.config.requestableReopenFrom.includes(currentStatus) ||
        !workflow.config.transitions[currentStatus]?.includes(
          workflow.config.reopenStatus,
        )
      ) {
        throw new ApiError(
          409,
          'REOPEN_NOT_ALLOWED',
          'A reopen request is not allowed from the current ticket status.',
        );
      }

      const reopenRequest: TicketReopenRequest = {
        id: `reopen_${randomUUID().replace(/-/g, '')}`,
        requestedBy: authenticated.userId,
        fromStatus: currentStatus,
        toStatus: workflow.config.reopenStatus,
        reason,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      const result = await store.requestReopen(
        authenticated,
        ticket.id,
        ticket.status ?? currentStatus,
        reopenRequest,
        workflow.id,
      );
      if (!result) {
        throw ticketNotFound();
      }
      response.status(201).json({
        data: result[1],
        requestId: requestId(response),
      });
    },
  );

  app.post(
    '/api/v1/tickets/:ticketId/reopen-requests/:requestId/approve',
    async (request, response) => {
      const authenticated = authenticatedPrincipal(request, principal);
      const ticket = await findAccessibleTicket(
        store,
        authenticated,
        routeParam(request, 'ticketId'),
      );
      parseObjectBody(request.body ?? {}, []);
      const workflow = await workflowForTicket(
        workflowStore,
        authenticated,
        ticket,
      );
      if (
        !hasAnyRole(
          authenticated,
          workflow.config.permissions.reopenApprovalRoles,
        )
      ) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'The authenticated role cannot approve reopen requests.',
        );
      }
      const currentStatus = canonicalStatus(workflow.config, ticket.status);
      if (
        !currentStatus ||
        !workflow.config.transitions[currentStatus]?.includes(
          workflow.config.reopenStatus,
        )
      ) {
        throw new ApiError(
          409,
          'REOPEN_NOT_ALLOWED',
          'The ticket cannot be reopened from its current status.',
        );
      }
      const result = await store.approveReopen(
        authenticated,
        ticket.id,
        routeParam(request, 'requestId'),
        authenticated.userId,
      );
      if (!result) {
        throw new ApiError(
          404,
          'NOT_FOUND',
          'Reopen request not found.',
        );
      }
      response.json({
        data: {
          ticket: ticketResponse(result[0]),
          reopenRequest: result[1],
        },
        requestId: requestId(response),
      });
    },
  );

  app.patch('/api/v1/tickets/:ticketId', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    if (!isSupportStaff(authenticated)) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only support staff can update tickets.',
      );
    }

    const ticket = await findAccessibleTicket(
      store,
      authenticated,
      routeParam(request, 'ticketId'),
    );
    const body = parseObjectBody(request.body, [
      'title',
      'description',
      'product',
      'affectedService',
      'teamId',
    ]);
    if (Object.keys(body).length === 0) {
      throw validationError(
        'body',
        'At least one permitted field must be provided.',
      );
    }

    const changes: Partial<
      Pick<
        TicketRecord,
        'title' | 'description' | 'product' | 'affectedService' | 'teamId'
      >
    > = {};
    for (const [field, value] of Object.entries(body)) {
      if (field === 'title') {
        if (typeof value !== 'string' || !value.trim()) {
          throw validationError(field, 'This field must not be empty.');
        }
        changes.title = value.trim();
      } else if (field === 'description') {
        if (value !== null && (typeof value !== 'string' || !value.trim())) {
          throw validationError(field, 'This field must not be empty.');
        }
        changes.description = value;
      } else if (field === 'teamId') {
        if (value !== null && typeof value !== 'string') {
          throw validationError(field, 'This field must be a string or null.');
        }
        if (!authenticated.roles.includes('support_lead')) {
          throw new ApiError(
            403,
            'FORBIDDEN',
            'Only a support lead can assign a ticket team.',
          );
        }
        if (value !== null && !authenticated.teamIds.includes(value)) {
          throw new ApiError(
            403,
            'TEAM_SCOPE_FORBIDDEN',
            "The requested team is outside the authenticated user's team scope.",
          );
        }
        changes.teamId = value;
      } else {
        if (value !== null && typeof value !== 'string') {
          throw validationError(field, 'This field must be a string or null.');
        }
        changes[field as 'product' | 'affectedService'] = value;
      }
    }

    const updated = await store.updateTicket(
      authenticated,
      ticket.id,
      changes,
    );
    if (!updated) {
      throw ticketNotFound();
    }
    response.json({
      data: ticketResponse(updated),
      requestId: requestId(response),
    });
  });

  app.post('/api/v1/tickets/:ticketId/comments', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    const ticket = await findAccessibleTicket(
      store,
      authenticated,
      routeParam(request, 'ticketId'),
    );
    const body = parseObjectBody(request.body, ['body', 'visibility']);
    const commentBody = requiredText(body, 'body');
    if (body.visibility !== 'internal' && body.visibility !== 'public') {
      throw validationError(
        'visibility',
        'Visibility must be internal or public.',
      );
    }
    if (body.visibility === 'internal' && !isSupportStaff(authenticated)) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Requesters cannot add internal comments.',
      );
    }

    const result = await store.addComment(authenticated, ticket.id, {
      authorId: authenticated.userId,
      body: commentBody.trim(),
      visibility: body.visibility,
    });
    if (!result) {
      throw ticketNotFound();
    }
    response.status(201).json({
      data: result[1],
      requestId: requestId(response),
    });
  });

  app.get('/api/v1/tickets/:ticketId/comments', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    const ticket = await findAccessibleTicket(
      store,
      authenticated,
      routeParam(request, 'ticketId'),
    );
    response.json({
      data: visibleComments(authenticated, ticket),
      requestId: requestId(response),
    });
  });

  app.get('/api/v1/tickets/:ticketId/audit', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    if (!isSupportStaff(authenticated)) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Ticket audit is restricted to support staff.',
      );
    }
    const ticket = await findAccessibleTicket(
      store,
      authenticated,
      routeParam(request, 'ticketId'),
    );
    response.json({
      data: ticket.history ?? [],
      requestId: requestId(response),
    });
  });

  app.post(
    '/api/v1/tickets/ingest/jira/:webhookSecret',
    async (request, response) => {
      const body = parseJiraBody(request.body);
      const fields = body.issue.fields;
      const project = isRecord(fields.project) ? fields.project : undefined;
      const projectKey = project?.key;
      if (typeof projectKey !== 'string' || !projectKey) {
        throw validationError(
          'issue.fields.project.key',
          'Project key is required.',
        );
      }

      const organisationId = settings.projectMappings[projectKey];
      if (!organisationId) {
        throw jiraUnauthorized();
      }
      const organisationConfig = settings.organisations[organisationId];
      if (
        !secureStringEqual(
          routeParam(request, 'webhookSecret'),
          organisationConfig.webhookSecret,
        )
      ) {
        throw jiraUnauthorized();
      }

      const mappedTicket = mapJiraIssue(
        body.webhookEvent,
        body.issue,
        fields,
        projectKey,
        organisationId,
        organisationConfig.reporterMappings,
      );
      const workflow = await workflowStore.getActive({
        organisationId,
        userId: mappedTicket.requesterId,
        roles: [],
      });
      const ticket = workflow
        ? {
            ...mappedTicket,
            workflowId: workflow.id,
            status: workflow.config.initialStatus,
          }
        : mappedTicket;
      const [stored, outcome] = await store.upsertJiraTicket(ticket);
      response.status(outcome === 'created' ? 201 : 200).json({
        data: {
          id: stored.id,
          sourceIssueKey: stored.source?.issueKey,
          outcome,
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
        },
        requestId: requestId(response),
      });
    },
  );

  app.use((request, response) => {
    response.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found.',
        requestId: requestId(response),
        fields: [],
      },
    });
  });

  app.use(errorHandler);
  return app;
}

function authenticatedPrincipal(
  request: Request,
  principal: DevelopmentPrincipal | null,
): DevelopmentPrincipal {
  if (!principal) {
    throw new ApiError(
      503,
      'AUTHENTICATION_NOT_CONFIGURED',
      'Ticket API authentication is unavailable until an approved identity provider is configured.',
    );
  }
  const authorization = request.header('authorization');
  if (!authorization) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'A bearer token is required.');
  }
  const [scheme, token, ...extra] = authorization.split(' ');
  if (
    scheme?.toLowerCase() !== 'bearer' ||
    !token ||
    extra.length > 0 ||
    !secureStringEqual(token, principal.bearerToken)
  ) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'The bearer token is invalid.');
  }
  return principal;
}

function canAccessTicket(
  principal: DevelopmentPrincipal,
  ticket: TicketRecord,
): boolean {
  if (ticket.organisationId !== principal.organisationId) {
    return false;
  }
  if (principal.roles.includes('organisation_admin')) {
    return true;
  }
  if (
    principal.roles.includes('requester') &&
    ticket.requesterId === principal.userId
  ) {
    return true;
  }
  if (
    principal.roles.includes('support_lead') &&
    ticket.teamId == null
  ) {
    return true;
  }
  return (
    isSupportStaff(principal) &&
    ticket.teamId != null &&
    principal.teamIds.includes(ticket.teamId)
  );
}

async function findAccessibleTicket(
  store: JsonTicketStore,
  principal: DevelopmentPrincipal,
  ticketId: string,
): Promise<TicketRecord> {
  const ticket = await store.findTicket(principal, ticketId);
  if (!ticket || !canAccessTicket(principal, ticket)) {
    throw ticketNotFound();
  }
  return ticket;
}

function visibleComments(
  principal: DevelopmentPrincipal,
  ticket: TicketRecord,
) {
  const comments = ticket.comments ?? [];
  return isSupportStaff(principal)
    ? comments
    : comments.filter((comment) => comment.visibility === 'public');
}

function matchesTicketFilters(
  ticket: TicketRecord,
  filters: {
    q?: string;
    status?: string;
    priority?: string;
    teamId?: string;
    requesterId?: string;
  },
): boolean {
  const effectiveStatus = ticket.status ?? ticket.source?.status;
  const effectivePriority = ticket.priority ?? ticket.source?.priority;
  if (
    filters.status !== undefined &&
    effectiveStatus?.toLowerCase() !== filters.status.toLowerCase()
  ) {
    return false;
  }
  if (
    filters.priority !== undefined &&
    effectivePriority?.toLowerCase() !== filters.priority.toLowerCase()
  ) {
    return false;
  }
  if (filters.teamId !== undefined && ticket.teamId !== filters.teamId) {
    return false;
  }
  if (
    filters.requesterId !== undefined &&
    ticket.requesterId !== filters.requesterId
  ) {
    return false;
  }
  if (filters.q !== undefined) {
    const searchText = [
      ticket.title,
      stringifyDescription(ticket.description),
      ticket.product ?? '',
      ticket.affectedService ?? '',
    ]
      .join(' ')
      .toLowerCase();
    if (!searchText.includes(filters.q.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function ticketResponse(
  ticket: TicketRecord | TicketReadModel,
): Omit<TicketRecord, 'comments' | 'history' | 'attachments'> {
  return {
    id: ticket.id,
    organisationId: ticket.organisationId,
    requesterId: ticket.requesterId,
    title: ticket.title,
    ...(ticket.description !== undefined
      ? { description: ticket.description }
      : {}),
    ...(ticket.product !== undefined ? { product: ticket.product } : {}),
    ...(ticket.affectedService !== undefined
      ? { affectedService: ticket.affectedService }
      : {}),
    ...(ticket.teamId !== undefined ? { teamId: ticket.teamId } : {}),
    ...(ticket.status !== undefined ? { status: ticket.status } : {}),
    ...(ticket.priority !== undefined ? { priority: ticket.priority } : {}),
    ...(ticket.source !== undefined ? { source: ticket.source } : {}),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

function publicAttachment(attachment: TicketAttachment) {
  const {
    storageKey: _storageKey,
    ...publicMetadata
  } = attachment;
  return publicMetadata;
}

function parseJiraBody(value: unknown): {
  webhookEvent: string;
  issue: Record<string, unknown> & { fields: Record<string, unknown> };
} {
  if (!isRecord(value)) {
    throw validationError('body', 'The request body must be an object.');
  }
  if (typeof value.webhookEvent !== 'string' || !value.webhookEvent) {
    throw validationError('webhookEvent', 'Webhook event is required.');
  }
  if (!isRecord(value.issue) || !isRecord(value.issue.fields)) {
    throw validationError('issue.fields', 'Issue fields are required.');
  }
  return {
    webhookEvent: value.webhookEvent,
    issue: value.issue as Record<string, unknown> & {
      fields: Record<string, unknown>;
    },
  };
}

function mapJiraIssue(
  webhookEvent: string,
  issue: Record<string, unknown>,
  fields: Record<string, unknown>,
  projectKey: string,
  organisationId: string,
  reporterMappings: Record<string, string>,
) {
  if (
    webhookEvent !== 'jira:issue_created' &&
    webhookEvent !== 'jira:issue_updated'
  ) {
    throw new ApiError(
      400,
      'UNSUPPORTED_JIRA_EVENT',
      'Only Jira issue-created and issue-updated events are supported.',
    );
  }
  if (typeof issue.id !== 'string' || !issue.id) {
    throw validationError('issue.id', 'Jira issue ID is required.');
  }
  if (
    typeof issue.key !== 'string' ||
    !new RegExp(`^${escapeRegExp(projectKey)}-\\d+$`).test(issue.key)
  ) {
    throw validationError(
      'issue.key',
      'Issue key must match the configured Jira project.',
    );
  }

  const reporter = isRecord(fields.reporter) ? fields.reporter : undefined;
  const accountId = reporter?.accountId;
  if (typeof accountId !== 'string' || !accountId) {
    throw validationError(
      'issue.fields.reporter.accountId',
      'Jira reporter account ID is required.',
    );
  }
  const requesterId = reporterMappings[accountId];
  if (!requesterId) {
    throw new ApiError(
      403,
      'JIRA_REPORTER_UNMAPPED',
      'The Jira reporter has no configured internal user mapping.',
    );
  }
  if (typeof fields.summary !== 'string' || !fields.summary.trim()) {
    throw validationError(
      'issue.fields.summary',
      'Issue summary is required.',
    );
  }
  const description = fields.description;
  if (description !== undefined && !isJsonValue(description)) {
    throw validationError(
      'issue.fields.description',
      'Description must be JSON-compatible.',
    );
  }

  const source: TicketSource = {
    system: 'jira',
    issueId: issue.id,
    issueKey: issue.key,
    projectKey,
    ...optionalName(fields, 'status'),
    ...optionalName(fields, 'priority'),
  };
  return {
    organisationId,
    requesterId,
    title: fields.summary,
    ...(description !== undefined ? { description } : {}),
    source,
  };
}

function optionalName(
  fields: Record<string, unknown>,
  field: 'status' | 'priority',
): Partial<Pick<TicketSource, 'status' | 'priority'>> {
  const value = fields[field];
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value) || typeof value.name !== 'string') {
    throw validationError(
      `issue.fields.${field}`,
      `${field[0].toUpperCase()}${field.slice(1)} must contain a name.`,
    );
  }
  return { [field]: value.name };
}

function parseObjectBody(
  value: unknown,
  allowedFields: string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw validationError('body', 'The request body must be an object.');
  }
  const unsupportedField = Object.keys(value).find(
    (field) => !allowedFields.includes(field),
  );
  if (unsupportedField) {
    throw validationError(
      unsupportedField,
      'This field is not permitted.',
    );
  }
  return value;
}

function requiredText(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError(field, 'This field must not be empty.');
  }
  return value;
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
    throw validationError(field, 'This field must be a string or null.');
  }
  return value;
}

function queryString(request: Request, key: string): string | undefined {
  const value = request.query[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw validationError(key, 'Query parameter must be a single string.');
  }
  return value;
}

function routeParam(request: Request, key: string): string {
  const value = request.params[key];
  if (typeof value !== 'string' || !value) {
    throw validationError(key, 'Route parameter is invalid.');
  }
  return value;
}

function queryInteger(
  request: Request,
  key: string,
  defaultValue: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = request.query[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (
    typeof value !== 'string' ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw validationError(
      key,
      `Query parameter must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return Number(value);
}

function isSupportStaff(principal: DevelopmentPrincipal): boolean {
  return (
    principal.roles.includes('support_agent') ||
    principal.roles.includes('support_lead') ||
    principal.roles.includes('organisation_admin')
  );
}

function requireOrganisationAdmin(
  principal: DevelopmentPrincipal,
): void {
  if (!principal.roles.includes('organisation_admin')) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Only an organisation administrator can manage ticket workflows.',
    );
  }
}

function hasAnyRole(
  principal: DevelopmentPrincipal,
  allowedRoles: string[],
): boolean {
  return principal.roles.some((role) => allowedRoles.includes(role));
}

function authorizeStatusChange(
  principal: DevelopmentPrincipal,
  workflow: TicketWorkflowConfig,
  currentStatus: string,
  nextStatus: string,
): void {
  if (
    nextStatus === workflow.reopenStatus &&
    workflow.restrictedReopenFrom.includes(currentStatus)
  ) {
    if (!hasAnyRole(principal, workflow.permissions.closedReopenRoles)) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only an authorised supervisor or administrator can reopen this ticket.',
      );
    }
    return;
  }
  if (
    !hasAnyRole(principal, workflow.permissions.directStatusChangeRoles) &&
    !hasAnyRole(principal, workflow.permissions.administratorOverrideRoles)
  ) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'The authenticated role cannot change ticket status.',
    );
  }
}

async function workflowForTicket(
  workflows: JsonTicketWorkflowStore,
  principal: DevelopmentPrincipal,
  ticket: TicketRecord,
): Promise<TicketWorkflowRecord> {
  const workflow = ticket.workflowId
    ? await workflows.find(principal, ticket.workflowId)
    : await workflows.getActive(principal);
  if (!workflow || workflow.status === 'draft') {
    throw new ApiError(
      409,
      'WORKFLOW_NOT_ACTIVE',
      'No approved ticket workflow is available for this ticket.',
    );
  }
  return workflow;
}

function canonicalStatus(
  workflow: TicketWorkflowConfig,
  status: string | undefined,
): string | null {
  if (status === undefined) {
    return null;
  }
  return (
    workflow.statuses.find(
      (candidate) => candidate.toLowerCase() === status.toLowerCase(),
    ) ?? null
  );
}

function workflowResponse(workflow: TicketWorkflowRecord) {
  return {
    id: workflow.id,
    organisationId: workflow.organisationId,
    sourceReference: workflow.config.sourceReference,
    initialStatus: workflow.config.initialStatus,
    reopenStatus: workflow.config.reopenStatus,
    statuses: workflow.config.statuses,
    transitions: workflow.config.transitions,
    requestableReopenFrom: workflow.config.requestableReopenFrom,
    restrictedReopenFrom: workflow.config.restrictedReopenFrom,
    permissions: workflow.config.permissions,
    status: workflow.status,
    createdBy: workflow.createdBy,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    ...(workflow.approvedBy !== undefined
      ? { approvedBy: workflow.approvedBy }
      : {}),
    ...(workflow.approvedAt !== undefined
      ? { approvedAt: workflow.approvedAt }
      : {}),
  };
}

function stringifyDescription(value: JsonValue | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  return value === undefined ? '' : JSON.stringify(value);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validationError(field: string, message: string): ApiError {
  return new ApiError(400, 'VALIDATION_ERROR', 'The request is invalid.', [
    { field, message },
  ]);
}

function jiraUnauthorized(): ApiError {
  return new ApiError(
    401,
    'JIRA_WEBHOOK_UNAUTHORIZED',
    'Jira webhook authentication failed.',
  );
}

function ticketNotFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Ticket not found.');
}

function requestId(response: Response): string {
  return response.locals.requestId as string;
}

const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  _next,
) => {
  const id = requestId(response);
  if (error instanceof ApiError) {
    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        requestId: id,
        fields: error.fields,
      },
    });
    return;
  }
  if (error instanceof ConfigurationError || error instanceof DevelopmentAuthConfigurationError) {
    console.error('Ticket API configuration error', error);
    response.status(500).json({
      error: {
        code: 'CONFIGURATION_ERROR',
        message: error.message,
        requestId: id,
        fields: [],
      },
    });
    return;
  }
  if (error instanceof TicketConflictError) {
    response.status(409).json({
      error: {
        code: 'CONFLICT',
        message: error.message,
        requestId: id,
        fields: [],
      },
    });
    return;
  }
  if (error instanceof TicketWorkflowConflictError) {
    response.status(409).json({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: error.message,
        requestId: id,
        fields: [],
      },
    });
    return;
  }
  if (error instanceof TicketStoreError) {
    console.error('Ticket storage error', error);
    response.status(500).json({
      error: {
        code: 'STORAGE_ERROR',
        message: error.message,
        requestId: id,
        fields: [],
      },
    });
    return;
  }
  if (error instanceof TicketWorkflowStoreError) {
    console.error('Ticket workflow storage error', error);
    response.status(500).json({
      error: {
        code: 'STORAGE_ERROR',
        message: error.message,
        requestId: id,
        fields: [],
      },
    });
    return;
  }
  if (error instanceof TicketWorkflowValidationError) {
    response.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request is invalid.',
        requestId: id,
        fields: [{ field: error.field, message: error.message }],
      },
    });
    return;
  }
  if (error instanceof TicketAttachmentValidationError) {
    response.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request is invalid.',
        requestId: id,
        fields: [{ field: 'file', message: error.message }],
      },
    });
    return;
  }
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    response.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR',
        message: tooLarge
          ? 'The uploaded file exceeds the 25 MB limit.'
          : 'The multipart request must contain one file in the "file" field only.',
        requestId: id,
        fields: [],
      },
    });
    return;
  }
  if (error instanceof SyntaxError && 'body' in error) {
    response.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request is invalid.',
        requestId: id,
        fields: [{ field: 'body', message: 'Request body must be valid JSON.' }],
      },
    });
    return;
  }
  if (isRecord(error) && error.type === 'entity.too.large') {
    response.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'The request body exceeds the allowed size.',
        requestId: id,
        fields: [],
      },
    });
    return;
  }

  console.error('Unhandled ticket API error', error);
  response.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      requestId: id,
      fields: [],
    },
  });
};

function requireTicketPrincipal(
  principal: DevelopmentPrincipal | null,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    try {
      response.locals.ticketPrincipal = authenticatedPrincipal(
        request,
        principal,
      );
      next();
    } catch (error) {
      next(error);
    }
  };
}
