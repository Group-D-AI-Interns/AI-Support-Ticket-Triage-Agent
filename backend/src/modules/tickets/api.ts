import { createHash, randomUUID } from 'node:crypto';
import express, {
  type Express,
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import multer from 'multer';
import type { AuthenticationProvider, TenantContext, TenantResolver } from '../../shared/auth/authentication.js';
import { applicationAuthorization, type Permission, type RolePermissionPolicy } from '../../shared/auth/authorization.js';
import {
  AiExecutionError,
  type AiExecutionRunner,
} from '../ai/ai-execution-runner.js';
import { TicketAiAnalysisError } from '../ai/ticket-ai-analysis.service.js';
import type { TicketAiView } from '../ai/contracts.js';
import type {
  AiAnalysisRepository,
  AuthorizedTicketAnalysisSource,
} from '../ai/ports.js';
import { PriorityRecommender } from '../ai/components/priority-recommender.js';
import { PriorityRecommendationService } from '../ai/priority-recommendation.service.js';
import {
  priorityPreviewFromEnvironment,
  type PriorityPreviewConfiguration,
} from '../ai/priority-preview-config.js';
import {
  createLocalDemoTicketAiRuntime,
  TicketAiDemoConfigurationError,
  ticketAiDemoConfigurationFromEnvironment,
  type TicketAiDemoConfiguration,
} from '../ai/local-demo-runtime.js';
import {
  createLiveTicketAiRuntime,
  LiveTicketAiConfigurationError,
  liveTicketAiConfigurationFromEnvironment,
  type LiveTicketAiConfiguration,
} from '../ai/live-ticket-ai-runtime.js';
import {
  KnowledgeRetriever,
  type AuthorizedKnowledgeSource,
} from '../knowledge/retrieval.js';
import { ResolutionRecommendationService } from '../ai/resolution-recommendation.service.js';
import type { AuthorizedRoutingSource, VerifiedSlaInsightSource } from '../ai/team-capability-ports.js';
import { AiOperationsStore } from '../ai/operations-store.js';
import { AiOperationsService, AiOperationsError } from '../ai/operations-service.js';
import { operationsApi } from '../ai/operations-api.js';
import { TriageJobs, automationFromEnvironment, type AutomationConfiguration } from '../ai/triage-jobs.js';
import { createTriageWorker } from '../ai/triage-worker.js';
import { aiDocumentation } from '../ai/ai-documentation.js';
import { JsonTeamRepository } from '../teams/repositories.js';
import { JsonFileStore } from '../../infrastructure/persistence/json/json-file-store.js';
import { FreshVerifiedSlaSource } from '../ai/verified-sla-source.js';
import { ProviderDocumentExtractionAdapter, type ApprovedExtractionSchemas } from '../ai/provider-document-extraction.adapter.js';
import { documentExtractionSchemas } from '../ai/document-extraction-schemas.js';
import { GovernedKnowledgeSource } from '../knowledge/published-knowledge.js';
import type { ExtractionAdapter } from '../documents/services/extraction-adapter.js';
import { ProvisionalExtractionAdapter } from '../documents/services/provisional-extraction-adapter.js';
import { DocumentKnowledgeService, DocumentKnowledgeError } from '../documents/services/document-knowledge.service.js';
import { JsonStorageError } from '../../infrastructure/persistence/json/json-file-store.js';

import {
  createLocalPrivateStorageAdapter,
  type DocumentStorageAdapter,
} from '../documents/storage/document-storage.js';
import { JsonDocumentRepository } from '../documents/repositories/json-document.repository.js';
import { DocumentLifecycleService } from '../documents/services/document-lifecycle.service.js';
import {
  DocumentProcessingError,
  DocumentProcessingService,
} from '../documents/services/document-processing.service.js';
import {
  DocumentValidationError,
  MAX_DOCUMENT_SIZE_BYTES,
} from '../documents/validators/document-validation.js';
import { createJsonTenantStore, type JsonTenantStore } from '../../infrastructure/persistence/json/json-store.js';
import type { PolicyRepository } from '../policies/repositories/policy.repository.js';
import { JsonPolicyRepository } from '../policies/repositories/json-policy.repository.js';
import { OperationalReportingService } from '../reporting/services/operational-reporting.service.js';
import type { SlaEvaluationRepository } from '../sla/repositories/sla-evaluation.repository.js';
import { JsonSlaEvaluationRepository } from '../sla/repositories/sla-evaluation.repository.js';
import { SlaEvaluationService } from '../sla/services/sla-evaluation.service.js';
import {
  SlaEvaluationWorker,
  type SlaEvaluationWorkerOptions,
} from '../sla/services/sla-evaluation-worker.js';
import { RepositorySlaPolicyResolver } from '../sla/services/sla-policy-resolver.js';
import { parseSlaPolicy, SlaPolicyValidationError } from '../sla/domain/sla-policy.js';
import {
  SLA_EXCLUSION_REASON_CODES,
  SLA_PAUSE_REASON_CODES,
  type SlaEvidenceWrite,
  type SlaPauseEvidence,
  type SlaResolutionEvidence,
} from '../sla/domain/sla-evidence.js';
import type { OperationalReport } from '../reporting/domain/operational-report.js';
import type { SlaEvaluationService as SlaEvaluationServiceType } from '../sla/services/sla-evaluation.service.js';
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
import { normalizeTicketPriority } from './domain/priority.js';
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
const ticketAppDisposers = new WeakMap<Express, () => void>();

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
  authenticator?: AuthenticationProvider;
  tenantResolver?: TenantResolver;
  listTeamIdsForUser?: (tenant: TenantContext, userId: string) => Promise<string[]>;
  authorization?: RolePermissionPolicy;
  tenantStore?: JsonTenantStore;
  attachmentStorage?: DocumentStorageAdapter;
  policyRepository?: PolicyRepository;
  slaEvaluationRepository?: SlaEvaluationRepository;
  slaEvaluationService?: SlaEvaluationServiceType;
  slaEvaluationWorker?: SlaEvaluationWorkerOptions;
  analysisRepository?: AiAnalysisRepository;
  ticketAiDemo?: TicketAiDemoConfiguration | null;
  ticketAiLive?: LiveTicketAiConfiguration | null;
  priorityPreview?: PriorityPreviewConfiguration | null;
  resolutionRunner?: AiExecutionRunner;
  aiAutomation?: AutomationConfiguration;
  knowledgeSource?: AuthorizedKnowledgeSource;
  routingSource?: AuthorizedRoutingSource;
  slaInsightSource?: VerifiedSlaInsightSource;
  documentExtractionAdapter?: ExtractionAdapter;
  documentExtractionSchemas?: ApprovedExtractionSchemas;
};

export function stopTicketApp(app: Express): void {
  ticketAppDisposers.get(app)?.();
  ticketAppDisposers.delete(app);
}

export function createTicketApp(options: TicketAppOptions = {}) {
  const settings = options.settings ?? jiraSettingsFromEnvironment();
  const store = options.ticketStore ?? new JsonTicketStore(settings.dataDirectory);
  const workflowStore =
    options.ticketWorkflowStore ??
    new JsonTicketWorkflowStore(settings.dataDirectory);
  const ticketReadService =
    options.ticketReadService ?? new JsonTicketReadService(store);
  const tenantStore = options.tenantStore ?? createJsonTenantStore(settings.dataDirectory);
  const policyRepository =
    options.policyRepository ?? new JsonPolicyRepository(tenantStore);
  const documentRepository = new JsonDocumentRepository(tenantStore);
  const parseSlaDocumentSource = async (
    body: Record<string, unknown>,
    tenant: TenantContext,
  ): Promise<{
    sourceDocumentId?: string;
    sourceDocumentVersionId?: string;
  }> => {
    const hasDocumentId = body.sourceDocumentId !== undefined;
    const hasVersionId = body.sourceDocumentVersionId !== undefined;
    if (!hasDocumentId && !hasVersionId) {
      return {};
    }
    if (!hasDocumentId || !hasVersionId) {
      throw validationError(
        hasDocumentId ? 'sourceDocumentVersionId' : 'sourceDocumentId',
        'Both source document fields must be provided together.',
      );
    }

    const sourceDocumentId = requiredText(body, 'sourceDocumentId');
    const sourceDocumentVersionId = requiredText(
      body,
      'sourceDocumentVersionId',
    );
    const sourceDocument = await documentRepository.getById(
      tenant,
      sourceDocumentId,
    );
    if (
      !sourceDocument ||
      sourceDocument.status !== 'processed' ||
      sourceDocument.processingStatus !== 'completed'
    ) {
      throw new ApiError(
        422,
        'SOURCE_DOCUMENT_NOT_READY',
        'The source document must be processed and belong to this organisation.',
      );
    }
    const sourceVersions = await tenantStore.readCollection<{
      id: string;
      documentId: string;
      organisationId: string;
    }>('documentVersions');
    if (
      !sourceVersions.some(
        (version) =>
          version.id === sourceDocumentVersionId &&
          version.documentId === sourceDocumentId &&
          version.organisationId === tenant.organisationId,
      )
    ) {
      throw validationError(
        'sourceDocumentVersionId',
        'The source version must belong to the selected tenant document.',
      );
    }
    return { sourceDocumentId, sourceDocumentVersionId };
  };
  const validateStoredSlaDocumentSource = async (
    version: {
      sourceDocumentId?: string;
      sourceDocumentVersionId?: string;
    },
    tenant: TenantContext,
  ): Promise<void> => {
    const { sourceDocumentId, sourceDocumentVersionId } = version;
    if (sourceDocumentId === undefined && sourceDocumentVersionId === undefined) {
      return;
    }
    if (!sourceDocumentId || !sourceDocumentVersionId) {
      throw new ApiError(
        409,
        'SOURCE_DOCUMENT_VERSION_NOT_FOUND',
        'The SLA policy must reference both a source document and version.',
      );
    }
    const sourceDocument = await documentRepository.getById(
      tenant,
      sourceDocumentId,
    );
    if (
      !sourceDocument ||
      sourceDocument.status !== 'processed' ||
      sourceDocument.processingStatus !== 'completed'
    ) {
      throw new ApiError(
        409,
        'SOURCE_DOCUMENT_NOT_READY',
        'The SLA source document must remain processed and tenant-scoped.',
      );
    }
    const sourceVersions = await tenantStore.readCollection<{
      id: string;
      documentId: string;
      organisationId: string;
    }>('documentVersions');
    if (
      !sourceVersions.some(
        (sourceVersion) =>
          sourceVersion.id === sourceDocumentVersionId &&
          sourceVersion.documentId === sourceDocumentId &&
          sourceVersion.organisationId === tenant.organisationId,
      )
    ) {
      throw new ApiError(
        409,
        'SOURCE_DOCUMENT_VERSION_NOT_FOUND',
        'The referenced source document version is no longer available.',
      );
    }
  };
  const slaEvaluationRepository =
    options.slaEvaluationRepository ??
    new JsonSlaEvaluationRepository(tenantStore);
  const slaEvaluationService =
    options.slaEvaluationService ??
    new SlaEvaluationService(
      store,
      new RepositorySlaPolicyResolver(policyRepository),
      slaEvaluationRepository,
    );
  const operationalReportingService = new OperationalReportingService(
    store,
    slaEvaluationRepository,
  );
  const attachmentStorage =
    options.attachmentStorage ??
    createLocalPrivateStorageAdapter(settings.dataDirectory);
  const documentLifecycle = new DocumentLifecycleService(tenantStore, attachmentStorage);
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
  const authorization = options.authorization ?? applicationAuthorization;
  const ticketAiDemo = options.ticketAiDemo === undefined
    ? ticketAiDemoConfigurationFromEnvironment()
    : options.ticketAiDemo;
  const ticketAiLive = options.ticketAiLive === undefined
    ? liveTicketAiConfigurationFromEnvironment()
    : options.ticketAiLive;
  if (ticketAiDemo && ticketAiLive) {
    throw new TicketAiDemoConfigurationError(
      'Enable either local demo mode or live ticket AI, not both.',
    );
  }
  const ticketAiSource: AuthorizedTicketAnalysisSource = {
    async getAuthorizedTicket(
      tenant: TenantContext,
      ticketId: string,
    ): Promise<TicketAiView | null> {
      const ticket = await store.findTicket(tenant as DevelopmentPrincipal, ticketId);
      const caller = tenant as DevelopmentPrincipal;
      if (!ticket || !Array.isArray(caller.teamIds) || !canAccessTicket(caller, ticket)) {
        return null;
      }
      return {
        id: ticket.id,
        organisationId: ticket.organisationId,
        title: ticket.title,
        description: descriptionText(ticket.description),
      };
    },
  };
  const ticketAiRuntime = ticketAiLive
    ? createLiveTicketAiRuntime(
      ticketAiSource,
      ticketAiLive,
      process.env,
      undefined,
      options.analysisRepository,
    )
    : ticketAiDemo
      ? createLocalDemoTicketAiRuntime(ticketAiSource, options.analysisRepository)
      : null;
  const ticketAiCategories = ticketAiLive?.categories ?? ticketAiDemo?.categories;
  const priorityConfig = options.priorityPreview === undefined
    ? priorityPreviewFromEnvironment()
    : options.priorityPreview;
  const priorityRunner = priorityConfig?.runner ?? ticketAiRuntime?.priorityRunner;
  const priorityService = priorityConfig && priorityRunner
    ? new PriorityRecommendationService(
      ticketAiSource,
      new PriorityRecommender(
        priorityRunner,
        priorityConfig.candidate,
        priorityConfig.minimumConfidence,
      ),
    )
    : null;
  const resolutionRunner = options.resolutionRunner ?? ticketAiRuntime?.priorityRunner;
  const baseKnowledge = options.knowledgeSource ?? new GovernedKnowledgeSource(policyRepository, tenantStore, authorization);
  let operations: AiOperationsService;
  const knowledgeSource: AuthorizedKnowledgeSource = { async listAuthorizedDocuments(tenant) {
    return [...await baseKnowledge.listAuthorizedDocuments(tenant), ...await operations.listAuthorizedDocuments(tenant)];
  } };
  const resolutionService = resolutionRunner
    ? new ResolutionRecommendationService(
      ticketAiSource,
      new KnowledgeRetriever(
        knowledgeSource,
      ),
      resolutionRunner,
    )
    : null;

  const slaInsightSource = options.slaInsightSource ?? new FreshVerifiedSlaSource(slaEvaluationService,
    async (tenant, ticketId) => {
      const caller = tenant as DevelopmentPrincipal;
      const ticket = await store.findTicket(tenant, ticketId);
      if (!ticket || !Array.isArray(caller.teamIds) || !canAccessTicket(caller, ticket)) return null;
      return { ticket: { id: ticket.id, organisationId: ticket.organisationId, title: ticket.title, description: descriptionText(ticket.description) },
        revision: createHash('sha256').update(JSON.stringify(ticket)).digest('hex'),
        domain: { createdAt: ticket.createdAt, ...(ticket.priority === undefined ? {} : { priority: ticket.priority }), ...(ticket.teamId === undefined ? {} : { teamId: ticket.teamId }) } };
    }, tenant => authorization.permissionsFor(tenant.roles).has('configuration.manage'));
  const triageService = ticketAiRuntime?.createTriageService({ knowledge: knowledgeSource, sla: slaInsightSource,
    ...(resolutionRunner ? { resolutionRunner } : {}),
    ...(priorityConfig && priorityRunner ? { priority: new PriorityRecommender(priorityRunner, priorityConfig.candidate, priorityConfig.minimumConfidence) } : {}),
    routing: options.routingSource ?? { getAuthorizedRoutingContext: (tenant, ticket) => operations.getAuthorizedRoutingContext(tenant, ticket) },
  });
  const operationFiles = new JsonFileStore(settings.dataDirectory);
  const operationTeams = new JsonTeamRepository(operationFiles);
  const canRunAi = (tenant: TenantContext) => ['tickets.ai.review', 'tickets.resolution.review'].every(permission =>
    authorization.permissionsFor(tenant.roles).has(permission as Permission));
  const resolveAiActor = async (organisationId: string, userId: string): Promise<TenantContext | null> => {
    const tenant = options.tenantResolver ? await options.tenantResolver.resolve(userId, organisationId) :
      principal?.organisationId === organisationId && principal.userId === userId ? principal : null;
    if (!tenant || !canRunAi(tenant)) return null;
    const teamIds = options.tenantResolver ? await options.listTeamIdsForUser?.(tenant, userId) ?? [] : principal?.teamIds ?? [];
    return { ...tenant, teamIds } as DevelopmentPrincipal;
  };
  operations = new AiOperationsService(new AiOperationsStore(operationFiles), {
    async ticket(tenant, id) {
      const ticket = await store.findTicket(tenant, id);
      const caller = tenant as DevelopmentPrincipal;
      return ticket && Array.isArray(caller.teamIds) && canAccessTicket(caller, ticket) ? ticket : null;
    },
    project: ticket => ({ id: ticket.id, organisationId: ticket.organisationId, title: ticket.title, description: descriptionText(ticket.description) }),
    teams: tenant => operationTeams.listTeams(tenant),
    can: (tenant, permission) => authorization.permissionsFor(tenant.roles).has(permission),
    teamIds: tenant => (tenant as DevelopmentPrincipal).teamIds ?? [],
    async isResolved(tenant, ticket) {
      const policy = await slaEvaluationService.resolvePolicyForTicket(tenant, ticket);
      return typeof ticket.status === 'string' && (policy?.resolvedStatuses.includes(ticket.status) ?? false);
    },
    categories: () => ticketAiCategories ?? [], knowledge: baseKnowledge,
    ...(options.routingSource ? { routing: options.routingSource } : {}),
    async triage(tenant, ticketId) {
      if (!triageService || !ticketAiCategories) throw new AiOperationsError(503, 'TICKET_AI_NOT_CONFIGURED', 'Ticket AI is not enabled.');
      return triageService.analyze({ tenant, ticketId, categories: ticketAiCategories });
    },
  });
  const triageJobs = new TriageJobs(operations, resolveAiActor);
  const worker = createTriageWorker(options.aiAutomation ?? automationFromEnvironment(), triageJobs, resolveAiActor, tenant => store.listTickets(tenant));
  const notifyIntake = async (organisationId: string, ticketId: string, createdAt: string) => {
    try { await worker.intake(organisationId, ticketId, createdAt); }
    catch { console.warn('AI intake enqueue failed; background reconciliation will retry.'); }
  };
  const documentExtractionAdapter = options.documentExtractionAdapter ?? (
    ticketAiLive && ticketAiRuntime
      ? new ProviderDocumentExtractionAdapter(
          ticketAiRuntime.priorityRunner,
          options.documentExtractionSchemas ?? documentExtractionSchemas,
        )
      : new ProvisionalExtractionAdapter()
  );
  const documentProcessing = new DocumentProcessingService(
    tenantStore,
    documentLifecycle,
    attachmentStorage,
    documentExtractionAdapter,
  );
  const documentKnowledge = new DocumentKnowledgeService(
    tenantStore,
    policyRepository,
    attachmentStorage,
    documentExtractionAdapter,
  );

  const app = express();
  app.locals.aiWorker = worker;
  app.use(aiDocumentation());
  const slaEvaluationWorker = options.slaEvaluationWorker
    ? new SlaEvaluationWorker(
        slaEvaluationService,
        store,
        options.slaEvaluationWorker,
      )
    : undefined;
  const fallbackRequestId = () => `req_${randomUUID().replace(/-/g, '')}`;
  const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_DOCUMENT_SIZE_BYTES,
      files: 1,
      fields: 0,
      parts: 1,
    },
  });
  const documentUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_DOCUMENT_SIZE_BYTES,
      files: 1,
      fields: 1,
      parts: 2,
    },
  });
  const requireDocumentManager = (
    request: Request,
    _response: Response,
    next: NextFunction,
  ) => {
    try {
      requireSharedPermission(authenticatedPrincipal(request, principal), authorization, 'documents.manage');
      next();
    } catch (error) {
      next(error);
    }
  };
  app.use((request, response, next) => {
    const inheritedRequestId = response.getHeader('x-request-id');
    const requestId = typeof inheritedRequestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(inheritedRequestId)
      ? inheritedRequestId
      : fallbackRequestId();
    response.locals.requestId = requestId;
    response.setHeader('X-Request-ID', requestId);
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  if (options.authenticator && options.tenantResolver) {
    app.use(async (request, _response, next) => {
      if (request.path.startsWith('/api/v1/tickets/ingest/jira/')) {
        next();
        return;
      }
      try {
        let authenticated;
        try {
          authenticated = await options.authenticator!.authenticate(request);
        } catch {
          throw new ApiError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Authentication is temporarily unavailable.');
        }
        if (!authenticated) {
          throw new ApiError(401, 'UNAUTHENTICATED', 'A valid bearer access token is required.');
        }
        const selectedOrganisation = request.header('x-organisation-id') ?? request.query.organisationId;
        if (typeof selectedOrganisation !== 'string' || !selectedOrganisation.trim()) {
          throw new ApiError(400, 'ORGANISATION_REQUIRED', 'Select an organisation using the X-Organisation-ID header.');
        }
        const tenant = await options.tenantResolver!.resolve(authenticated.userId, selectedOrganisation);
        if (!tenant) {
          throw new ApiError(403, 'ORGANISATION_ACCESS_DENIED', 'You do not have an active membership in this organisation.');
        }
        const teamIds = await options.listTeamIdsForUser?.(tenant, authenticated.userId) ?? [];
        (request as Request & { integratedPrincipal?: DevelopmentPrincipal }).integratedPrincipal = {
          ...tenant,
          bearerToken: '',
          teamIds,
          permissions: [...authorization.permissionsFor(tenant.roles)],
        };
        next();
      } catch (error) {
        next(error);
      }
    });
  }

  app.use('/api/v1', operationsApi(operations, triageJobs, (request, permissions) => {
    const caller = authenticatedPrincipal(request, principal);
    for (const permission of permissions) requireSharedPermission(caller, authorization, permission);
    return caller;
  }, ticketAiRuntime?.evaluateSample));

  app.get('/api/v1/documents', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireSharedPermission(authenticated, authorization, 'documents.read');
    const documents = await documentLifecycle.listDocuments(authenticated);
    const data = await Promise.all(
      documents.map(async (document) => {
        const { storageKey: _storageKey, ...safeDocument } = document;
        return {
          ...safeDocument,
          extraction: await documentProcessing.getExtraction(
            authenticated,
            document.id,
          ),
        };
      }),
    );
    response.json({ data, requestId: requestId(response) });
  });

  app.post(
    '/api/v1/documents',
    requireDocumentManager,
    documentUpload.single('file'),
    async (request, response) => {
      const authenticated = authenticatedPrincipal(request, principal);
      const body = parseObjectBody(request.body, ['title']);
      const file = request.file;
      if (!file) {
        throw validationError('file', 'A document file is required.');
      }

      const uploaded = await documentLifecycle.uploadDocument({
        tenant: authenticated,
        title: requiredText(body, 'title'),
        fileName: file.originalname,
        mimeType: file.mimetype,
        content: file.buffer,
        createdBy: authenticated.userId,
      });
      const { storageKey: _documentStorageKey, ...document } = uploaded.document;
      const { storageKey: _versionStorageKey, ...version } = uploaded.version;
      response.status(201).json({
        data: {
          document,
          version,
        },
        requestId: requestId(response),
      });
    },
  );

  app.get('/api/v1/documents/:documentId', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireSharedPermission(authenticated, authorization, 'documents.read');
    const documentId = routeParam(request, 'documentId');
    const document = await documentLifecycle.getDocument(
      authenticated,
      documentId,
    );
    if (!document) {
      throw new ApiError(404, 'NOT_FOUND', 'Document not found.');
    }
    const versions = (
      await tenantStore.readCollection<{
        id: string;
        documentId: string;
        organisationId: string;
        version: number;
        storageKey?: string;
      }>('documentVersions')
    )
      .filter(
        (version) =>
          version.documentId === documentId &&
          version.organisationId === authenticated.organisationId,
      )
      .map(({ storageKey: _storageKey, ...version }) => version);
    const { storageKey: _storageKey, ...safeDocument } = document;
    response.json({
      data: {
        document: safeDocument,
        versions,
        extraction: await documentProcessing.getExtraction(
          authenticated,
          documentId,
        ),
      },
      requestId: requestId(response),
    });
  });

  app.post(
    '/api/v1/documents/:documentId/process',
    async (request, response) => {
      const authenticated = authenticatedPrincipal(request, principal);
      requireSharedPermission(authenticated, authorization, 'documents.manage');
      parseObjectBody(request.body ?? {}, []);
      const processed = await documentProcessing.processDocument(
        authenticated,
        routeParam(request, 'documentId'),
      );
      if (!processed) {
        throw new ApiError(404, 'NOT_FOUND', 'Document not found.');
      }
      const { storageKey: _storageKey, ...document } = processed.document;
      response.json({
        data: { document, extraction: processed.extraction },
        requestId: requestId(response),
      });
    },
  );

  app.post('/api/v1/documents/:documentId/extract-rules', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated, authorization);
    const body = parseObjectBody(request.body ?? {}, ['retry']);
    if (body.retry !== undefined && typeof body.retry !== 'boolean') throw validationError('retry', 'retry must be a boolean.');
    const result = await documentKnowledge.extract(authenticated, routeParam(request, 'documentId'), body.retry === true);
    response.setHeader('Cache-Control', 'no-store');
    if (result.job.status === 'failed') throw new DocumentKnowledgeError(502, 'DOCUMENT_EXTRACTION_FAILED', 'Extraction failed; inspect document extraction history before an explicit retry.');
    response.status(result.job.status === 'succeeded' ? 200 : 202).json({ data: result, requestId: requestId(response) });
  });
  app.get('/api/v1/documents/:documentId/extractions', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated, authorization);
    response.setHeader('Cache-Control', 'no-store');
    response.json({ data: await documentKnowledge.history(authenticated, routeParam(request, 'documentId')), requestId: requestId(response) });
  });
  app.post('/api/v1/documents/:documentId/publish-knowledge', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated, authorization);
    const body = parseObjectBody(request.body, ['ruleIds', 'reason', 'effectiveFrom', 'effectiveTo', 'visibility']);
    if (!Array.isArray(body.ruleIds) || !body.ruleIds.length || body.ruleIds.some(id => typeof id !== 'string' || !id.trim())) throw validationError('ruleIds', 'Select approved rule IDs.');
    if (body.visibility !== 'administrators' && body.visibility !== 'support_staff') throw validationError('visibility', 'Choose administrators or support_staff explicitly.');
    const result = await documentKnowledge.publish(authenticated, routeParam(request, 'documentId'), {
      ruleIds: body.ruleIds as string[], reason: requiredText(body, 'reason'), effectiveFrom: requiredText(body, 'effectiveFrom'),
      effectiveTo: optionalText(body, 'effectiveTo') ?? null, visibility: body.visibility,
    });
    response.setHeader('Cache-Control', 'no-store');
    response.json({ data: result, requestId: requestId(response) });
  });

  app.post(
    '/api/v1/documents/:documentId/download-token',
    async (request, response) => {
      const authenticated = authenticatedPrincipal(request, principal);
      requireSharedPermission(authenticated, authorization, 'documents.read');
      parseObjectBody(request.body ?? {}, []);
      const token = await documentLifecycle.createDownloadToken(
        authenticated,
        routeParam(request, 'documentId'),
      );
      if (!token) {
        throw new ApiError(404, 'NOT_FOUND', 'Document not found.');
      }
      response.status(201).json({
        data: {
          token,
          downloadPath: `/api/v1/documents/download/${token}`,
          expiresInSeconds: 300,
        },
        requestId: requestId(response),
      });
    },
  );

  app.get('/api/v1/documents/download/:token', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireSharedPermission(authenticated, authorization, 'documents.read');
    const token = routeParam(request, 'token');
    const validated = await documentLifecycle.validateDownloadToken(
      authenticated,
      token,
    );
    if (!validated) {
      throw new ApiError(404, 'NOT_FOUND', 'Document download token is invalid or expired.');
    }
    const document = await documentLifecycle.getDocument(
      authenticated,
      validated.documentId,
    );
    const content = await documentLifecycle.downloadDocument(
      authenticated,
      token,
    );
    if (!document || !content) {
      throw new ApiError(404, 'NOT_FOUND', 'Document not found.');
    }
    response
      .type(document.mimeType)
      .setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
      )
      .send(content);
  });

  app.get('/api/v1/sla-policies', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireSharedPermission(authenticated, authorization, 'policies.read');
    const policies = (await policyRepository.listPolicies(authenticated)).filter(
      (policy) => policy.policyType === 'sla',
    );
    const data = await Promise.all(
      policies.map(async (policy) => ({
        ...policy,
        versions: await policyRepository.listVersionsForPolicy(
          authenticated,
          policy.id,
        ),
      })),
    );
    response.json({ data, requestId: requestId(response) });
  });

  app.post('/api/v1/sla-policies', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireSharedPermission(authenticated, authorization, 'policies.manage');
    const body = parseObjectBody(request.body, [
      'description',
      'sourceDocumentId',
      'sourceDocumentVersionId',
      'effectiveFrom',
      'effectiveTo',
      'payload',
    ]);
    const source = await parseSlaDocumentSource(body, authenticated);
    const description = requiredText(body, 'description');
    const effectiveFrom = requiredText(body, 'effectiveFrom');
    const effectiveTo =
      body.effectiveTo === undefined || body.effectiveTo === null
        ? null
        : requiredText(body, 'effectiveTo');
    const now = new Date().toISOString();
    const policyId = `policy_${randomUUID().replace(/-/g, '')}`;
    const versionId = `policy_version_${randomUUID().replace(/-/g, '')}`;
    let payload: ReturnType<typeof parseSlaPolicy>;
    try {
      payload = parseSlaPolicy(body.payload, {
        id: policyId,
        versionId,
        version: 1,
        organisationId: authenticated.organisationId,
        effectiveFrom,
        effectiveTo,
      });
    } catch (error) {
      if (error instanceof SlaPolicyValidationError) {
        throw validationError(error.field, error.message);
      }
      throw error;
    }
    const {
      id: _policyId,
      versionId: _versionId,
      version: _version,
      organisationId: _organisationId,
      effectiveFrom: _effectiveFrom,
      effectiveTo: _effectiveTo,
      ...policyPayload
    } = payload;
    const policy = await policyRepository.createPolicy(
      {
        id: policyId,
        organisationId: authenticated.organisationId,
        policyType: 'sla',
        ownerId: authenticated.userId,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        version: 1,
        description,
      },
      authenticated,
    );
    const version = await policyRepository.createVersion(
      policy.id,
      {
        id: versionId,
        organisationId: authenticated.organisationId,
        policyId: policy.id,
        version: 1,
        status: 'pending_approval',
        effectiveFrom,
        effectiveTo,
        payload: policyPayload,
        ...source,
        createdAt: now,
        updatedAt: now,
      },
      authenticated,
    );
    response.status(201).json({
      data: { policy, version },
      requestId: requestId(response),
    });
  });

  app.post(
    '/api/v1/sla-policies/:policyId/versions',
    async (request, response) => {
      const authenticated = authenticatedPrincipal(request, principal);
      requireOrganisationAdmin(authenticated, authorization);
      const policy = await policyRepository.getPolicyById(
        authenticated,
        routeParam(request, 'policyId'),
      );
      if (!policy || policy.policyType !== 'sla') {
        throw new ApiError(404, 'NOT_FOUND', 'SLA policy not found.');
      }
      const body = parseObjectBody(request.body, [
        'sourceDocumentId',
        'sourceDocumentVersionId',
        'effectiveFrom',
        'effectiveTo',
        'payload',
      ]);
      const source = await parseSlaDocumentSource(body, authenticated);
      const effectiveFrom = requiredText(body, 'effectiveFrom');
      const effectiveTo =
        body.effectiveTo === undefined || body.effectiveTo === null
          ? null
          : requiredText(body, 'effectiveTo');
      const versions = await policyRepository.listVersionsForPolicy(
        authenticated,
        policy.id,
      );
      const versionNumber =
        versions.reduce(
          (maximum, version) => Math.max(maximum, version.version),
          0,
        ) + 1;
      const versionId = `policy_version_${randomUUID().replace(/-/g, '')}`;
      let payload: ReturnType<typeof parseSlaPolicy>;
      try {
        payload = parseSlaPolicy(body.payload, {
          id: policy.id,
          versionId,
          version: versionNumber,
          organisationId: authenticated.organisationId,
          effectiveFrom,
          effectiveTo,
        });
      } catch (error) {
        if (error instanceof SlaPolicyValidationError) {
          throw validationError(error.field, error.message);
        }
        throw error;
      }
      const {
        id: _policyId,
        versionId: _versionId,
        version: _version,
        organisationId: _organisationId,
        effectiveFrom: _effectiveFrom,
        effectiveTo: _effectiveTo,
        ...policyPayload
      } = payload;
      const now = new Date().toISOString();
      const version = await policyRepository.createVersion(
        policy.id,
        {
          id: versionId,
          organisationId: authenticated.organisationId,
          policyId: policy.id,
          version: versionNumber,
          status: 'pending_approval',
          effectiveFrom,
          effectiveTo,
          payload: policyPayload,
          ...source,
          createdAt: now,
          updatedAt: now,
        },
        authenticated,
      );
      response.status(201).json({
        data: { policy, version },
        requestId: requestId(response),
      });
    },
  );

  app.post(
    '/api/v1/sla-policies/:policyId/versions/:versionId/approve',
    async (request, response) => {
      const authenticated = authenticatedPrincipal(request, principal);
      requireSharedPermission(authenticated, authorization, 'policies.approve');
      const body = parseObjectBody(request.body ?? {}, ['reason']);
      const reason = requiredText(body, 'reason');
      const policy = await policyRepository.getPolicyById(
        authenticated,
        routeParam(request, 'policyId'),
      );
      const version = await policyRepository.getVersionById(
        authenticated,
        routeParam(request, 'versionId'),
      );
      if (
        !policy ||
        policy.policyType !== 'sla' ||
        !version ||
        version.policyId !== policy.id
      ) {
        throw new ApiError(404, 'NOT_FOUND', 'SLA policy version not found.');
      }
      await validateStoredSlaDocumentSource(version, authenticated);
      const approvalRecords =
        await tenantStore.readCollection<{
          policyVersionId: string;
          organisationId: string;
          decision: string;
        }>('policyApprovals');
      const existingApproval = approvalRecords.some(
        (record) =>
          record.policyVersionId === version.id &&
          record.organisationId === authenticated.organisationId &&
          record.decision === 'approved',
      );
      if (version.status === 'approved') {
        response.json({
          data: {
            version,
            approval:
              approvalRecords.find(
                (record) =>
                  record.policyVersionId === version.id &&
                  record.organisationId === authenticated.organisationId &&
                  record.decision === 'approved',
              ) ?? null,
          },
          requestId: requestId(response),
        });
        return;
      }
      if (version.status !== 'pending_approval') {
        throw new ApiError(
          409,
          'INVALID_POLICY_STATE',
          'Only a pending SLA policy version can be approved.',
        );
      }
      const approval = existingApproval
        ? null
        : await policyRepository.addApproval(
          {
          id: `approval_${randomUUID().replace(/-/g, '')}`,
          organisationId: authenticated.organisationId,
          policyVersionId: version.id,
          reviewerId: authenticated.userId,
          decision: 'approved',
          reason,
          createdAt: new Date().toISOString(),
          },
          authenticated,
        );
      const afterApproval = await policyRepository.getVersionById(authenticated, version.id);
      const updated = afterApproval?.status === 'approved'
        ? afterApproval
        : await policyRepository.transitionVersionStatus(
          authenticated,
          version.id,
          'approved',
        );
      if (!updated) {
        throw new ApiError(404, 'NOT_FOUND', 'SLA policy version not found.');
      }
      response.json({
        data: { version: updated, approval },
        requestId: requestId(response),
      });
    },
  );

  app.post(
    '/api/v1/sla-policies/:policyId/versions/:versionId/activate',
    async (request, response) => {
      const authenticated = authenticatedPrincipal(request, principal);
      requireSharedPermission(authenticated, authorization, 'policies.activate');
      parseObjectBody(request.body ?? {}, []);
      const policy = await policyRepository.getPolicyById(
        authenticated,
        routeParam(request, 'policyId'),
      );
      const version = await policyRepository.getVersionById(
        authenticated,
        routeParam(request, 'versionId'),
      );
      if (
        !policy ||
        policy.policyType !== 'sla' ||
        !version ||
        version.policyId !== policy.id
      ) {
        throw new ApiError(404, 'NOT_FOUND', 'SLA policy version not found.');
      }
      if (version.status === 'active') {
        response.json({
          data: { policy, version },
          requestId: requestId(response),
        });
        return;
      }
      if (version.status !== 'approved') {
        throw new ApiError(
          409,
          'INVALID_POLICY_STATE',
          'An approved SLA version must have a later effective date than the current active version.',
        );
      }
      const approvals =
        await tenantStore.readCollection<{
          policyVersionId: string;
          organisationId: string;
          decision: string;
        }>('policyApprovals');
      if (
        !approvals.some(
          (approval) =>
            approval.policyVersionId === version.id &&
            approval.organisationId === authenticated.organisationId &&
            approval.decision === 'approved',
        )
      ) {
        throw new ApiError(
          409,
          'POLICY_APPROVAL_REQUIRED',
          'An approval record is required before activation.',
        );
      }
      await validateStoredSlaDocumentSource(version, authenticated);
      const activeVersion = await policyRepository.activateVersion(
        authenticated,
        policy.id,
        version.id,
      );
      if (!activeVersion) {
        throw new ApiError(
          409,
          'INVALID_POLICY_STATE',
          'Only an approved SLA policy version can be activated.',
        );
      }
      response.json({
        data: { policy, version: activeVersion },
        requestId: requestId(response),
      });
    },
  );

  app.get('/api/v1/sla/evaluations', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated, authorization);
    const ticketId = queryString(request, 'ticketId');
    const evaluations = await slaEvaluationRepository.list(
      authenticated,
      ticketId,
    );
    response.json({ data: evaluations, requestId: requestId(response) });
  });

  app.post('/api/v1/sla/evaluations/run', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated, authorization);
    parseObjectBody(request.body ?? {}, []);
    const evaluations =
      await slaEvaluationService.evaluateTenantTickets(authenticated);
    response.json({ data: evaluations, requestId: requestId(response) });
  });

  app.get('/api/v1/reports', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    const permissions = authorization.permissionsFor(authenticated.roles);
    const canReadAll = permissions.has('reports.read.all');
    const canReadTeam = permissions.has('reports.read.team');
    if (!canReadAll && !canReadTeam) {
      requireSharedPermission(authenticated, authorization, 'reports.read.all');
    }
    const from = queryString(request, 'from');
    const to = queryString(request, 'to');
    if (!from || !to) {
      throw validationError(
        'period',
        'Both from and to ISO timestamps are required.',
      );
    }
    let report: OperationalReport;
    try {
      report = await operationalReportingService.getSummary(
        authenticated,
        from,
        to,
        canReadAll ? undefined : authenticated.teamIds ?? [],
      );
    } catch (error) {
      if (error instanceof RangeError) {
        throw validationError('period', error.message);
      }
      throw error;
    }
    response.json({ data: report, requestId: requestId(response) });
  });

  app.post('/api/v1/ticket-workflows', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated, authorization);
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
    requireOrganisationAdmin(authenticated, authorization);
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
      requireOrganisationAdmin(authenticated, authorization);
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
    requireSharedPermission(authenticated, authorization, 'tickets.create.own');
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
    await notifyIntake(ticket.organisationId, ticket.id, ticket.createdAt);
    response.status(201).json({
      data: ticketResponse(ticket),
      requestId: requestId(response),
    });
  });

  app.get(
    ['/api/v1/tickets/:ticketId/evidence', '/api/v1/tickets/:ticketId/similar'],
    async (request, response) => {
      const authenticated = authenticatedPrincipal(request, principal);
      requireSharedPermission(authenticated, authorization, 'tickets.resolution.review');
      response.setHeader('Cache-Control', 'no-store');
      if (!resolutionService) {
        throw new ApiError(
          503,
          'RESOLUTION_NOT_CONFIGURED',
          'Enable an AI runtime to use resolution retrieval.',
        );
      }
      try {
        const evidence = await resolutionService.retrieve(
          authenticated,
          routeParam(request, 'ticketId'),
          request.path.endsWith('/similar'),
        );
        response.json({
          data: evidence,
          retrieval: { method: 'lexical', persistedIndex: false },
          requestId: requestId(response),
        });
      } catch (error) {
        throw ticketAiApiError(error);
      }
    },
  );

  app.post('/api/v1/tickets/:ticketId/recommend-resolution', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireSharedPermission(authenticated, authorization, 'tickets.resolution.review');
    parseObjectBody(request.body ?? {}, []);
    response.setHeader('Cache-Control', 'no-store');
    if (!resolutionService) {
      throw new ApiError(
        503,
        'RESOLUTION_NOT_CONFIGURED',
        'Enable an AI runtime to recommend resolutions.',
      );
    }
    try {
      const result = await resolutionService.recommend(
        authenticated,
        routeParam(request, 'ticketId'),
      );
      response.json({ data: result, requestId: requestId(response) });
    } catch (error) {
      throw ticketAiApiError(error);
    }
  });

  app.post('/api/v1/tickets/:ticketId/recommend-priority', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireSharedPermission(authenticated, authorization, 'tickets.ai.review');
    parseObjectBody(request.body ?? {}, []);
    if (!priorityService) {
      throw new ApiError(
        503,
        'PRIORITY_PREVIEW_DISABLED',
        'Draft priority preview is not configured.',
      );
    }
    try {
      const recommendation = await priorityService.recommend(
        authenticated,
        routeParam(request, 'ticketId'),
      );
      response.json({ data: recommendation, requestId: requestId(response) });
    } catch (error) {
      throw ticketAiApiError(error);
    }
  });

  app.post('/api/v1/tickets/:ticketId/triage', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireSharedPermission(authenticated, authorization, 'tickets.ai.review');
    requireSharedPermission(authenticated, authorization, 'tickets.resolution.review');
    parseObjectBody(request.body ?? {}, []);
    if (!triageService || !ticketAiCategories) throw new ApiError(503, 'TICKET_AI_NOT_CONFIGURED', 'Ticket AI is not enabled.');
    try {
      const report = await operations.run(authenticated, routeParam(request, 'ticketId'));
      const result = { ...(report.data.result as Record<string, unknown>), triageId: report.id };
      response.setHeader('Cache-Control', 'no-store');
      response.json({ data: result, requestId: requestId(response) });
    } catch (error) { throw ticketAiApiError(error); }
  });
  app.get('/api/v1/tickets/:ticketId/ai-runs', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireSharedPermission(authenticated, authorization, 'tickets.ai.review');
    if (!ticketAiRuntime) throw new ApiError(503, 'TICKET_AI_NOT_CONFIGURED', 'Ticket AI is not enabled.');
    try {
      const runs = await ticketAiRuntime.service.listWorkflowRuns(authenticated, routeParam(request, 'ticketId'));
      response.setHeader('Cache-Control', 'no-store');
      response.json({ data: runs, requestId: requestId(response) });
    } catch (error) { throw ticketAiApiError(error); }
  });

  app.post('/api/v1/tickets/:ticketId/analyze', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireSharedPermission(authenticated, authorization, 'tickets.ai.review');
    parseObjectBody(request.body ?? {}, []);
    if (!ticketAiRuntime || !ticketAiCategories) {
      throw new ApiError(
        503,
        'TICKET_AI_NOT_CONFIGURED',
        'Ticket analysis is not enabled.',
      );
    }
    try {
      const analysis = await ticketAiRuntime.service.analyze({
        tenant: authenticated,
        ticketId: routeParam(request, 'ticketId'),
        categories: ticketAiCategories,
      });
      response.setHeader('Cache-Control', 'no-store');
      response.json({ data: analysis, requestId: requestId(response) });
    } catch (error) {
      throw ticketAiApiError(error);
    }
  });

  app.get('/api/v1/tickets/:ticketId/analyses', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireSharedPermission(authenticated, authorization, 'tickets.ai.review');
    if (!ticketAiRuntime) {
      throw new ApiError(
        503,
        'TICKET_AI_NOT_CONFIGURED',
        'Ticket analysis is not enabled.',
      );
    }
    try {
      const analyses = await ticketAiRuntime.service.listAnalyses(
        authenticated,
        routeParam(request, 'ticketId'),
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json({ data: analyses, requestId: requestId(response) });
    } catch (error) {
      throw ticketAiApiError(error);
    }
  });

  app.get('/api/v1/tickets', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    const limit = queryInteger(request, 'limit', 20, 1, 100);
    const offset = queryInteger(request, 'offset', 0, 0);
    const q = queryString(request, 'q');
    const status = queryString(request, 'status');
    const priority = queryString(request, 'priority');
    const teamId = queryString(request, 'teamId');
    const requesterId = queryString(request, 'requesterId');
    const filters = {
      ...(q === undefined ? {} : { q }),
      ...(status === undefined ? {} : { status }),
      ...(priority === undefined ? {} : { priority }),
      ...(teamId === undefined ? {} : { teamId }),
      ...(requesterId === undefined ? {} : { requesterId }),
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

  app.post('/api/v1/tickets/:ticketId/sla-events', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    const ticket = await findAccessibleTicket(
      store,
      authenticated,
      routeParam(request, 'ticketId'),
    );
    const body = parseObjectBody(request.body, [
      'type',
      'evidence',
      'reasonCode',
      'contractReference',
      'intervalId',
    ]);
    const type = requiredText(body, 'type');
    let evidence: SlaEvidenceWrite;
    if (type === 'assessment_completed') {
      if (!isSupportStaff(authenticated)) {
        throw forbiddenSlaEvidence();
      }
      evidence = {
        type,
        evidence: requiredText(body, 'evidence').trim(),
      };
    } else if (type === 'exclusion_started') {
      requireSlaEvidenceManager(authenticated);
      const reasonCode = SLA_EXCLUSION_REASON_CODES.find(
        (candidate) => candidate === body.reasonCode,
      );
      if (!reasonCode) {
        throw validationError(
          'reasonCode',
          'A supported SLA exclusion reason code is required.',
        );
      }
      evidence = {
        type,
        intervalId: `sla_exclusion_${randomUUID().replace(/-/g, '')}`,
        reasonCode,
        evidence: requiredText(body, 'evidence').trim(),
        contractReference: requiredText(body, 'contractReference').trim(),
      };
    } else if (type === 'exclusion_ended') {
      requireSlaEvidenceManager(authenticated);
      evidence = {
        type,
        intervalId: requiredText(body, 'intervalId').trim(),
      };
    } else {
      throw validationError(
        'type',
        'Type must be assessment_completed, exclusion_started, or exclusion_ended.',
      );
    }

    const result = await store.recordSlaEvidence(
      authenticated,
      ticket.id,
      evidence,
    );
    if (!result) {
      throw ticketNotFound();
    }
    response.status(201).json({
      data: result[1],
      requestId: requestId(response),
    });
  });

  app.patch('/api/v1/tickets/:ticketId/status', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    const ticket = await findAccessibleTicket(
      store,
      authenticated,
      routeParam(request, 'ticketId'),
    );
    const body = parseObjectBody(request.body, [
      'status',
      'reason',
      'pauseEvidence',
      'resolutionEvidence',
    ]);
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
    const slaPolicy = await slaEvaluationService.resolvePolicyForTicket(
      authenticated,
      ticket,
    );
    const wasPaused =
      slaPolicy?.pausedStatuses.includes(currentStatus) ?? false;
    const willBePaused =
      slaPolicy?.pausedStatuses.includes(nextStatus) ?? false;
    const enteringResolved =
      (slaPolicy?.resolvedStatuses.includes(nextStatus) ?? false) &&
      !(slaPolicy?.resolvedStatuses.includes(currentStatus) ?? false);
    const pauseEvidence = body.pauseEvidence === undefined
      ? undefined
      : parseSlaPauseEvidence(body.pauseEvidence);
    const resolutionEvidence = body.resolutionEvidence === undefined
      ? undefined
      : parseSlaResolutionEvidence(body.resolutionEvidence);
    if (pauseEvidence && (!willBePaused || wasPaused)) {
      throw validationError(
        'pauseEvidence',
        'Pause evidence is accepted only when entering a configured paused status.',
      );
    }
    if (willBePaused && !wasPaused) {
      requireSlaEvidenceManager(authenticated);
      if (!pauseEvidence) {
        throw validationError(
          'pauseEvidence',
          'Pause reason, evidence, and contract reference are required.',
        );
      }
    }
    if (wasPaused && !willBePaused) {
      requireSlaEvidenceManager(authenticated);
    }
    if (resolutionEvidence && !enteringResolved) {
      throw validationError(
        'resolutionEvidence',
        'Resolution evidence is accepted only when entering a configured resolved status.',
      );
    }
    if (enteringResolved) {
      if (!isSupportStaff(authenticated)) {
        throw forbiddenSlaEvidence();
      }
      if (!resolutionEvidence) {
        throw validationError(
          'resolutionEvidence',
          'Resolution outcome and documentation are required.',
        );
      }
    }
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
      {
        ...(pauseEvidence === undefined ? {} : { pauseStart: pauseEvidence }),
        ...(wasPaused && !willBePaused ? { pauseEnd: true } : {}),
        ...(resolutionEvidence === undefined
          ? {}
          : { resolution: resolutionEvidence }),
      },
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
        !hasSharedPermission(authenticated, 'tickets.read.own') ||
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
      requireSharedPermission(authenticated, authorization, 'tickets.approve');
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
      'priority',
      'priorityOverride',
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
        'title' | 'description' | 'product' | 'affectedService' | 'teamId' | 'priority'
      >
    > = {};
    let priorityOverride:
      | { reason: string; businessJustification: string }
      | undefined;
    for (const [field, value] of Object.entries(body)) {
      if (field === 'priorityOverride') continue;
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
        if (!hasSharedPermission(authenticated, 'tickets.routing.manage')) {
          throw new ApiError(
            403,
            'FORBIDDEN',
            'Only a support lead can assign a ticket team.',
          );
        }
        if (value !== null) {
          const targetTeams = await operationTeams.listTeams(authenticated);
          if (!targetTeams.some((team) => team.id === value)) {
            throw new ApiError(404, 'NOT_FOUND', 'The requested support team was not found.');
          }
          if (
            !authorization.permissionsFor(authenticated.roles).has('teams.manage') &&
            !authenticated.teamIds.includes(value)
          ) {
            throw new ApiError(
              403,
              'TEAM_SCOPE_FORBIDDEN',
              "The requested team is outside the authenticated user's team scope.",
            );
          }
        }
        changes.teamId = value;
      } else if (field === 'priority') {
        requireSharedPermission(authenticated, authorization, 'tickets.priority.manage');
        const newPriority = typeof value === 'string'
          ? normalizeTicketPriority(value)
          : null;
        if (!newPriority) {
          throw validationError(field, 'Priority must be P1, P2, P3, or P4.');
        }
        changes.priority = newPriority;
        if (newPriority !== ticket.priority) {
          const override = parseObjectBody(body.priorityOverride, [
            'reason',
            'businessJustification',
          ]);
          priorityOverride = {
            reason: requiredText(override, 'reason'),
            businessJustification: requiredText(
              override,
              'businessJustification',
            ),
          };
        } else if (body.priorityOverride !== undefined) {
          throw validationError(
            'priorityOverride',
            'Override evidence is only accepted when the priority changes.',
          );
        }
      } else {
        if (value !== null && typeof value !== 'string') {
          throw validationError(field, 'This field must be a string or null.');
        }
        changes[field as 'product' | 'affectedService'] = value;
      }
    }
    if (body.priorityOverride !== undefined && body.priority === undefined) {
      throw validationError(
        'priorityOverride',
        'Override evidence requires a priority change.',
      );
    }

    const updated = await store.updateTicket(
      authenticated,
      ticket.id,
      changes,
      priorityOverride,
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
    }, isSupportStaff(authenticated) && body.visibility === 'public');
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
    requireSharedPermission(authenticated, authorization, 'tickets.audit.read');
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
        !organisationConfig ||
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
      if (outcome === 'created') await notifyIntake(organisationId, stored.id, stored.createdAt);
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

  app.get('/api/v1/extracted-rules', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated, authorization);
    const policyVersionId = typeof request.query.policyVersionId === 'string'
      ? request.query.policyVersionId
      : undefined;
    const rules = await policyRepository.listExtractedRules(
      authenticated,
      policyVersionId,
    );
    response.json({ data: rules, requestId: requestId(response) });
  });

  app.get('/api/v1/extracted-rules/:ruleId', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated, authorization);
    const rule = await policyRepository.getExtractedRuleById(
      authenticated,
      routeParam(request, 'ruleId'),
    );
    if (!rule) {
      throw new ApiError(404, 'NOT_FOUND', 'Extracted rule not found.');
    }
    response.json({ data: rule, requestId: requestId(response) });
  });

  app.post('/api/v1/extracted-rules/:ruleId/approve', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated, authorization);
    const body = parseObjectBody(request.body, ['reason', 'effectiveFrom']);
    const reason = requiredText(body, 'reason');
    const effectiveFrom = optionalText(body, 'effectiveFrom');
    if (effectiveFrom && Number.isNaN(Date.parse(effectiveFrom))) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'effectiveFrom must be a valid timestamp.', [
        { field: 'effectiveFrom', message: 'effectiveFrom must be a valid timestamp.' },
      ]);
    }
    try {
      const rule = await policyRepository.reviewExtractedRule(
        authenticated,
        routeParam(request, 'ruleId'),
        'approved',
        reason,
        effectiveFrom ?? undefined,
      );
      response.json({ data: rule, requestId: requestId(response) });
    } catch (error) {
      throw mapCandidateReviewError(error);
    }
  });

  app.post('/api/v1/extracted-rules/:ruleId/reject', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated, authorization);
    const body = parseObjectBody(request.body, ['reason']);
    const reason = requiredText(body, 'reason');
    try {
      const rule = await policyRepository.reviewExtractedRule(
        authenticated,
        routeParam(request, 'ruleId'),
        'rejected',
        reason,
      );
      response.json({ data: rule, requestId: requestId(response) });
    } catch (error) {
      throw mapCandidateReviewError(error);
    }
  });

  app.post('/api/v1/extracted-rules/:ruleId/request-changes', async (request, response) => {
    const authenticated = authenticatedPrincipal(request, principal);
    requireOrganisationAdmin(authenticated, authorization);
    const body = parseObjectBody(request.body, ['reason']);
    const reason = requiredText(body, 'reason');
    try {
      const rule = await policyRepository.reviewExtractedRule(
        authenticated,
        routeParam(request, 'ruleId'),
        'changes_requested',
        reason,
      );
      response.json({ data: rule, requestId: requestId(response) });
    } catch (error) {
      throw mapCandidateReviewError(error);
    }
  });

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
  if (slaEvaluationWorker) {
    const unsubscribe = store.subscribeToTicketChanges(({ organisationId, ticketId }) => {
      slaEvaluationWorker.enqueue(organisationId, ticketId);
    });
    slaEvaluationWorker.start();
    ticketAppDisposers.set(app, () => {
      unsubscribe();
      slaEvaluationWorker.stop();
    });
  }
  return app;
}

function authenticatedPrincipal(
  request: Request,
  principal: DevelopmentPrincipal | null,
): DevelopmentPrincipal {
  const integratedPrincipal = (request as Request & { integratedPrincipal?: DevelopmentPrincipal }).integratedPrincipal;
  if (integratedPrincipal) return integratedPrincipal;
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
  if (hasSharedPermission(principal, 'tickets.read.all')) {
    return true;
  }
  if (
    hasSharedPermission(principal, 'tickets.read.own') &&
    ticket.requesterId === principal.userId
  ) {
    return true;
  }
  if (
    hasSharedPermission(principal, 'tickets.read.team') &&
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
  const internalPriority = ticket.priority;
  const sourcePriority = ticket.source?.priority;
  if (
    filters.status !== undefined &&
    effectiveStatus?.toLowerCase() !== filters.status.toLowerCase()
  ) {
    return false;
  }
  if (
    filters.priority !== undefined &&
    !(
      (internalPriority !== undefined &&
        (normalizeTicketPriority(internalPriority) ?? internalPriority).toLowerCase() ===
          (normalizeTicketPriority(filters.priority) ?? filters.priority).toLowerCase()) ||
      sourcePriority?.toLowerCase() === filters.priority.toLowerCase()
    )
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
      `${field === 'status' ? 'Status' : 'Priority'} must contain a name.`,
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

function parseSlaPauseEvidence(value: unknown): SlaPauseEvidence {
  const body = parseObjectBody(value, [
    'reasonCode',
    'evidence',
    'contractReference',
  ]);
  const reasonCode = SLA_PAUSE_REASON_CODES.find(
    (candidate) => candidate === body.reasonCode,
  );
  if (!reasonCode) {
    throw validationError(
      'pauseEvidence.reasonCode',
      'A supported SLA pause reason code is required.',
    );
  }
  return {
    reasonCode,
    evidence: requiredText(body, 'evidence').trim(),
    contractReference: requiredText(body, 'contractReference').trim(),
  };
}

function parseSlaResolutionEvidence(value: unknown): SlaResolutionEvidence {
  const body = parseObjectBody(value, [
    'outcome',
    'note',
    'customerConfirmation',
    'customerConfirmationEvidence',
  ]);
  if (body.outcome !== 'service_restored' && body.outcome !== 'agreed_solution') {
    throw validationError(
      'resolutionEvidence.outcome',
      'Outcome must be service_restored or agreed_solution.',
    );
  }
  if (
    body.customerConfirmation !== 'received' &&
    body.customerConfirmation !== 'not_applicable'
  ) {
    throw validationError(
      'resolutionEvidence.customerConfirmation',
      'Customer confirmation must be received or not_applicable.',
    );
  }
  return {
    outcome: body.outcome,
    note: requiredText(body, 'note').trim(),
    customerConfirmation: body.customerConfirmation,
    customerConfirmationEvidence: requiredText(
      body,
      'customerConfirmationEvidence',
    ).trim(),
  };
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
  return hasSharedPermission(principal, 'tickets.read.assigned') ||
    hasSharedPermission(principal, 'tickets.read.team') ||
    hasSharedPermission(principal, 'tickets.read.all');
}

function hasSharedPermission(principal: DevelopmentPrincipal, permission: Permission): boolean {
  const permissions = principal.permissions
    ? new Set(principal.permissions)
    : applicationAuthorization.permissionsFor(principal.roles);
  return permissions.has(permission);
}

function requireOrganisationAdmin(
  principal: DevelopmentPrincipal,
  authorization: RolePermissionPolicy = applicationAuthorization,
): void {
  requireSharedPermission(principal, authorization, 'configuration.manage');
}

function forbiddenSlaEvidence(): ApiError {
  return new ApiError(
    403,
    'FORBIDDEN',
    'You do not have permission to record this SLA evidence.',
  );
}

function requireSlaEvidenceManager(principal: DevelopmentPrincipal): void {
  if (
    !principal.roles.includes('support_lead') &&
    !principal.roles.includes('organisation_admin')
  ) {
    throw forbiddenSlaEvidence();
  }
}

function requireSharedPermission(
  principal: DevelopmentPrincipal,
  authorization: RolePermissionPolicy,
  permission: Permission,
): void {
  const permissions = principal.permissions
    ? new Set(principal.permissions)
    : authorization.permissionsFor(principal.roles);
  if (!permissions.has(permission)) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'You do not have permission to perform this action.',
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

function ticketAiApiError(error: unknown): unknown {
  if (error instanceof AiOperationsError) return new ApiError(error.status, error.code, error.message);
  if (error instanceof TicketAiAnalysisError && error.code === 'TICKET_NOT_FOUND') {
    return ticketNotFound();
  }
  if (error instanceof AiExecutionError) {
    console.warn('Ticket AI execution failed', {
      executionId: error.executionId,
      task: error.task,
      code: error.code,
    });
    return new ApiError(
      502,
      'AI_ANALYSIS_FAILED',
      'Ticket AI processing could not be completed.',
    );
  }
  if (error instanceof TicketAiAnalysisError) {
    console.error('Ticket AI analysis failed', { code: error.code });
    return new ApiError(
      500,
      'AI_ANALYSIS_FAILED',
      'Ticket AI processing could not be completed.',
    );
  }
  return error;
}

function descriptionText(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(descriptionText).filter(Boolean).join(' ');
  if (value === null || typeof value !== 'object') return '';
  const text = typeof value.text === 'string' ? value.text : '';
  const content = Array.isArray(value.content)
    ? value.content.map(descriptionText).filter(Boolean).join(' ')
    : '';
  return [text, content].filter(Boolean).join(' ');
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
  if (error instanceof JsonStorageError) {
    console.error('Application data storage error', { code: error.code });
    response.status(503).json({
      error: {
        code: error.code,
        message: 'The application data store is temporarily unavailable.',
        requestId: id,
        fields: [],
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
  if (error instanceof DocumentValidationError) {
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
  if (error instanceof DocumentKnowledgeError) {
    response.status(error.statusCode).json({ error: { code: error.code, message: error.message, requestId: id, fields: [] } });
    return;
  }
  if (error instanceof DocumentProcessingError) {
    const statusCode =
      error.code === 'DOCUMENT_NOT_READY' ? 409 : 422;
    response.status(statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        requestId: id,
        fields: [],
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
          : 'The multipart request must contain one file in the "file" field and a title.',
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

function mapCandidateReviewError(error: unknown): ApiError {
  if (!(error instanceof Error)) {
    return new ApiError(500, 'INTERNAL_ERROR', 'The request could not be completed.');
  }
  if (/does not exist|not found/i.test(error.message)) {
    return new ApiError(404, 'NOT_FOUND', error.message);
  }
  if (/immutable|already exists/i.test(error.message)) {
    return new ApiError(409, 'CONFLICT', error.message);
  }
  if (/reason|timestamp|review/i.test(error.message)) {
    return new ApiError(400, 'VALIDATION_ERROR', error.message);
  }
  return new ApiError(500, 'INTERNAL_ERROR', 'The request could not be completed.');
}
