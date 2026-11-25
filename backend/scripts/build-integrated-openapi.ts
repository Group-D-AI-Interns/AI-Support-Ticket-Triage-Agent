import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiDirectory = join(repositoryRoot, 'docs', 'api');
const [ticket, ai] = await Promise.all(['ticket-openapi.json', 'ai-openapi.json'].map(async name =>
  JSON.parse(await readFile(join(apiDirectory, name), 'utf8')) as OpenApiDocument));

type Operation = Record<string, unknown>;
type PathItem = Record<string, Operation | unknown>;
type OpenApiDocument = {
  openapi: string;
  info: Record<string, unknown>;
  servers?: unknown[];
  tags?: Array<Record<string, unknown>>;
  paths: Record<string, PathItem>;
  components?: Record<string, Record<string, unknown>>;
  security?: unknown[];
};

const document: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'AI Support Ticket Triage API',
    version: '1.0.0',
    description: 'Integrated API contract for the implemented foundation, ticket, document, policy, AI, SLA, and reporting routes. Tenant and permission checks are enforced by the backend. Draft or review-only behavior is called out in the operation descriptions.',
  },
  servers: [{ url: '/api/v1', description: 'Integrated API base path' }],
  security: [{ bearerAuth: [], organisationContext: [] }],
  tags: [
    { name: 'Health' }, { name: 'Identity and organisation' }, { name: 'Teams' },
    { name: 'Documents and knowledge' }, { name: 'Policies and extracted rules' },
    { name: 'SLA and reports' }, { name: 'Tickets' }, { name: 'Ticket workflows' },
    { name: 'SLA evidence' }, { name: 'AI triage' }, { name: 'AI operations' },
    { name: 'Configuration' },
  ],
  paths: {},
  components: { schemas: {}, parameters: {}, responses: {}, securitySchemes: {} },
};

// Keep the ticket-domain contract as the source for shared schemas and lifecycle operations.
for (const source of [ticket, ai]) {
  for (const [path, pathItem] of Object.entries(source.paths)) {
    const target = document.paths[path] ?? (document.paths[path] = {});
    for (const [method, operation] of Object.entries(pathItem)) {
      if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'].includes(method) && !(method in target)) {
        const normalized = { ...(operation as Operation) };
        if (typeof normalized.operationId !== 'string' || !normalized.operationId) {
          normalized.operationId = operationId(method, path);
        }
        target[method] = normalized;
      }
    }
  }
  for (const [section, definitions] of Object.entries(source.components ?? {})) {
    const target = document.components![section] ?? (document.components![section] = {});
    for (const [name, definition] of Object.entries(definitions)) target[name] ??= definition;
  }
  for (const tag of source.tags ?? []) {
    if (!document.tags!.some(existing => existing.name === tag.name)) document.tags!.push(tag);
  }
}

document.components!.securitySchemes = {
  ...document.components!.securitySchemes,
  bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Keycloak access token.' },
  organisationContext: { type: 'apiKey', in: 'header', name: 'X-Organisation-ID', description: 'Active organisation ID. The backend verifies active membership and permissions.' },
};
document.components!.schemas = {
  ...document.components!.schemas,
  IntegratedSuccessEnvelope: {
    type: 'object', required: ['data', 'requestId'], properties: {
      data: {}, requestId: { type: 'string' },
    }, additionalProperties: false,
  },
  IntegratedErrorEnvelope: {
    type: 'object', required: ['error'], properties: {
      error: { type: 'object', required: ['code', 'message', 'requestId'], properties: {
        code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' },
        fields: { type: 'array', items: { type: 'object' } },
      } },
    }, additionalProperties: false,
  },
  TicketClassificationEvidence: {
    type: 'object', required: ['categoryId', 'field', 'start', 'end', 'excerpt'], additionalProperties: false,
    properties: { categoryId: { type: 'string' }, field: { type: 'string', enum: ['title', 'description'] }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 }, excerpt: { type: 'string', minLength: 1 } },
  },
  TicketClassification: {
    type: 'object', required: ['categories', 'reason', 'confidence', 'evidence', 'requiresHumanReview', 'warnings'], additionalProperties: false,
    properties: { categories: { type: 'array', uniqueItems: true, items: { type: 'string' }, description: 'One or more configured category IDs; empty means uncertain and requires human review.' },
      reason: { type: 'string', minLength: 1 }, confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
      evidence: { type: 'array', items: { $ref: '#/components/schemas/TicketClassificationEvidence' }, description: 'Every selected category must have exact matching evidence in the authorized ticket snapshot.' },
      requiresHumanReview: { type: 'boolean' }, warnings: { type: 'array', items: { type: 'string' } } },
  },
};

type ExtraRoute = {
  path: string; method: string; tag: string; summary: string; description: string;
  status?: number; fields?: Array<{ name: string; schema?: Record<string, unknown>; required?: boolean; description?: string }>;
  query?: Array<{ name: string; required?: boolean; schema?: Record<string, unknown>; description?: string }>;
  multipart?: boolean; public?: boolean; responseDescription?: string;
};

const extraRoutes: ExtraRoute[] = [
  { path: '/configuration/categories', method: 'get', tag: 'Configuration', summary: 'List effective ticket categories', description: 'Requires `configuration.manage`. Returns organisation categories when configured, otherwise the legacy environment fallback.' },
  { path: '/configuration/categories', method: 'post', tag: 'Configuration', summary: 'Create an organisation ticket category', description: 'Requires `configuration.manage`. The tenant category set replaces fallback categories once created; category creation is audited.', status: 201, fields: [{ name: 'id', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$', maxLength: 80 } }, { name: 'name', required: true, schema: { type: 'string', maxLength: 120 } }, { name: 'description', schema: { type: 'string', maxLength: 500 } }] },
  { path: '/configuration/categories/{id}/disable', method: 'post', tag: 'Configuration', summary: 'Disable an organisation ticket category', description: 'Requires `configuration.manage` and a reason. Cannot disable a category referenced by an approved routing rule.', fields: [{ name: 'reason', required: true }] },
  { path: '/configuration/categories/{id}/enable', method: 'post', tag: 'Configuration', summary: 'Enable an organisation ticket category', description: 'Requires `configuration.manage` and an audit reason.', fields: [{ name: 'reason', required: true }] },
  { path: '/configuration/priority-rules', method: 'get', tag: 'Configuration', summary: 'List versioned tenant priority policies', description: 'Requires `configuration.manage`. Only an explicitly approved and activated version is used for recommendations.' },
  { path: '/configuration/priority-rules', method: 'post', tag: 'Configuration', summary: 'Create a tenant priority policy draft', description: 'Requires `configuration.manage`. The cited processed document version must belong to the active organisation. Drafts do not affect recommendations.', status: 201, fields: [{ name: 'sourceDocumentId', required: true }, { name: 'sourceDocumentVersionId', required: true }, { name: 'reason', required: true }, { name: 'matrix', required: true, schema: { type: 'object', description: 'Complete 3×3 impact/urgency matrix; each cell is P1, P2, P3 or P4.' } }] },
  { path: '/configuration/priority-rules/{id}/approve', method: 'post', tag: 'Configuration', summary: 'Approve a priority policy draft', description: 'Requires `configuration.manage`. Requires a reason; approval does not activate the version.', fields: [{ name: 'reason', required: true }] },
  { path: '/configuration/priority-rules/{id}/activate', method: 'post', tag: 'Configuration', summary: 'Activate an approved priority policy version', description: 'Requires `configuration.manage` and a reason. Revalidates source checksum and archives the previously active version atomically.', fields: [{ name: 'reason', required: true }] },
  { path: '/health/live', method: 'get', tag: 'Health', summary: 'Check process liveness', description: 'Public process liveness probe.', public: true, responseDescription: 'Process is running.' },
  { path: '/health/ready', method: 'get', tag: 'Health', summary: 'Check service readiness', description: 'Public readiness probe. Checks configured persistence readiness.', public: true, responseDescription: 'Service is ready.' },
  { path: '/health', method: 'get', tag: 'Health', summary: 'Get API health and version', description: 'Public versioned API health check.', public: true, responseDescription: 'API is healthy.' },
  { path: '/me', method: 'get', tag: 'Identity and organisation', summary: 'Get the authenticated user and memberships', description: 'Returns organisations and role-derived permissions for the authenticated user.', query: [{ name: 'organisationId', description: 'Optionally select an organisation context.' }] },
  { path: '/roles', method: 'get', tag: 'Identity and organisation', summary: 'List role capabilities', description: 'Requires `users.manage`. Returns the canonical role capability catalogue.', query: [{ name: 'organisationId', required: true }] },
  { path: '/organisations', method: 'get', tag: 'Identity and organisation', summary: 'List organisations for the authenticated user', description: 'Returns only active organisations where the user has an active membership.', query: [{ name: 'page', schema: { type: 'integer', minimum: 1 } }, { name: 'pageSize', schema: { type: 'integer', minimum: 1, maximum: 100 } }] },
  { path: '/organisations', method: 'post', tag: 'Identity and organisation', summary: 'Create an organisation', description: 'Requires the approved platform organisation-creation permission. The creator receives an active administrator membership.', status: 201, fields: [{ name: 'name', required: true }] },
  { path: '/organisations/{organisationId}', method: 'get', tag: 'Identity and organisation', summary: 'Get an organisation', description: 'Requires active membership and `organisation.read`.' },
  { path: '/organisations/{organisationId}', method: 'patch', tag: 'Identity and organisation', summary: 'Update organisation settings', description: 'Requires organisation management permission. Only supported fields can be updated.', fields: [{ name: 'name' }, { name: 'settings', schema: { type: 'object', additionalProperties: true } }, { name: 'status', schema: { type: 'string', enum: ['active', 'inactive', 'suspended'] } }] },
  { path: '/users', method: 'get', tag: 'Identity and organisation', summary: 'List active organisation users', description: 'Requires `users.read`; returns membership roles and permissions.', query: [{ name: 'organisationId', required: true }, { name: 'page', schema: { type: 'integer', minimum: 1 } }, { name: 'pageSize', schema: { type: 'integer', minimum: 1, maximum: 100 } }] },
  { path: '/users', method: 'post', tag: 'Identity and organisation', summary: 'Invite an organisation user', description: 'Requires `users.manage`. Creates or links an application user and an organisation membership.', status: 201, fields: [{ name: 'email', required: true }, { name: 'displayName', required: true }, { name: 'roles', required: true, schema: { type: 'array', items: { type: 'string' } } }] },
  { path: '/users/{userId}', method: 'get', tag: 'Identity and organisation', summary: 'Get an organisation member', description: 'Requires `users.read` and active membership in the selected organisation.' },
  { path: '/users/{userId}', method: 'patch', tag: 'Identity and organisation', summary: 'Update a member display name', description: 'Requires `users.manage`. Updates the identity provider profile when configured.', fields: [{ name: 'displayName', required: true }] },
  { path: '/users/{userId}/memberships', method: 'put', tag: 'Identity and organisation', summary: 'Update an organisation membership', description: 'Requires `users.manage`; updates membership status and assigned roles.', fields: [{ name: 'status', required: true, schema: { type: 'string', enum: ['active', 'inactive', 'suspended'] } }, { name: 'roles', required: true, schema: { type: 'array', items: { type: 'string' } } }] },
  { path: '/departments', method: 'get', tag: 'Teams', summary: 'List departments', description: 'Requires `teams.read` and an active organisation context.', query: [{ name: 'organisationId', required: true }, { name: 'page', schema: { type: 'integer', minimum: 1 } }, { name: 'pageSize', schema: { type: 'integer', minimum: 1, maximum: 100 } }] },
  { path: '/departments', method: 'post', tag: 'Teams', summary: 'Create a department', description: 'Requires `teams.manage`.', status: 201, fields: [{ name: 'name', required: true }] },
  { path: '/teams', method: 'get', tag: 'Teams', summary: 'List support teams', description: 'Requires `teams.read` and an active organisation context.', query: [{ name: 'organisationId', required: true }, { name: 'page', schema: { type: 'integer', minimum: 1 } }, { name: 'pageSize', schema: { type: 'integer', minimum: 1, maximum: 100 } }] },
  { path: '/teams', method: 'post', tag: 'Teams', summary: 'Create a support team', description: 'Requires `teams.manage`.', status: 201, fields: [{ name: 'name', required: true }, { name: 'departmentId', schema: { type: ['string', 'null'] } }] },
  { path: '/teams/{teamId}', method: 'patch', tag: 'Teams', summary: 'Update a support team', description: 'Requires `teams.manage`; the department must belong to the active organisation.', fields: [{ name: 'name' }, { name: 'departmentId', schema: { type: ['string', 'null'] } }] },
  { path: '/teams/{teamId}/members', method: 'get', tag: 'Teams', summary: 'List team members', description: 'Requires `teams.members.read`.', query: [{ name: 'organisationId', required: true }, { name: 'page', schema: { type: 'integer', minimum: 1 } }, { name: 'pageSize', schema: { type: 'integer', minimum: 1, maximum: 100 } }] },
  { path: '/teams/{teamId}/members', method: 'put', tag: 'Teams', summary: 'Set team membership', description: 'Requires `teams.manage`; the user must be an active organisation member.', fields: [{ name: 'userId', required: true }, { name: 'role', required: true, schema: { type: 'string', enum: ['support_lead', 'support_agent', 'requester'] } }, { name: 'status', required: true, schema: { type: 'string', enum: ['active', 'inactive', 'suspended'] } }] },
  { path: '/documents', method: 'get', tag: 'Documents and knowledge', summary: 'List organisation documents', description: 'Requires `documents.read`. Storage keys are omitted; each document includes extraction status.' },
  { path: '/documents', method: 'post', tag: 'Documents and knowledge', summary: 'Upload a document', description: 'Requires `documents.manage`. Document bytes remain private; upload accepts the supported document formats and enforces the configured upload size.', status: 201, multipart: true, fields: [{ name: 'file', required: true, schema: { type: 'string', format: 'binary' } }, { name: 'title', required: true }] },
  { path: '/documents/{documentId}', method: 'get', tag: 'Documents and knowledge', summary: 'Get document metadata and extraction', description: 'Requires `documents.read`; storage keys are omitted.' },
  { path: '/documents/{documentId}/process', method: 'post', tag: 'Documents and knowledge', summary: 'Process a document', description: 'Requires `documents.manage`; provider and review behavior follows server configuration.' },
  { path: '/documents/{documentId}/extract-rules', method: 'post', tag: 'Documents and knowledge', summary: 'Extract candidate policy rules', description: 'Organisation administrators only. Output remains a draft requiring human review. Explicit retry is optional.', fields: [{ name: 'retry', schema: { type: 'boolean' } }] },
  { path: '/documents/{documentId}/extractions', method: 'get', tag: 'Documents and knowledge', summary: 'List document extraction history', description: 'Organisation administrators only.' },
  { path: '/documents/{documentId}/publish-knowledge', method: 'post', tag: 'Documents and knowledge', summary: 'Publish approved knowledge', description: 'Organisation administrators only. Only approved extracted rules can be published.', fields: [{ name: 'ruleIds', required: true, schema: { type: 'array', minItems: 1, items: { type: 'string' } } }, { name: 'reason', required: true }, { name: 'effectiveFrom', required: true, schema: { type: 'string', format: 'date-time' } }, { name: 'effectiveTo', schema: { type: ['string', 'null'], format: 'date-time' } }, { name: 'visibility', required: true, schema: { type: 'string', enum: ['administrators', 'support_staff'] } }] },
  { path: '/documents/{documentId}/download-token', method: 'post', tag: 'Documents and knowledge', summary: 'Create a short-lived document download token', description: 'Requires `documents.read`. Token is tenant-scoped and expires after 300 seconds.', status: 201 },
  { path: '/documents/download/{token}', method: 'get', tag: 'Documents and knowledge', summary: 'Download a document using a short-lived token', description: 'Requires `documents.read`; returns the original file bytes.' },
  { path: '/sla-policies', method: 'get', tag: 'Policies and extracted rules', summary: 'List SLA policies and versions', description: 'Requires `policies.read`; includes policies and their version history.' },
  { path: '/sla-policies', method: 'post', tag: 'Policies and extracted rules', summary: 'Create a draft SLA policy', description: 'Requires `policies.manage`. The policy remains pending approval and does not activate SLA calculations.', fields: [{ name: 'description', required: true }, { name: 'sourceDocumentId' }, { name: 'sourceDocumentVersionId' }, { name: 'effectiveFrom', required: true, schema: { type: 'string', format: 'date-time' } }, { name: 'effectiveTo', schema: { type: ['string', 'null'], format: 'date-time' } }, { name: 'payload', required: true, schema: { type: 'object', additionalProperties: true } }] },
  { path: '/sla-policies/{policyId}/versions', method: 'post', tag: 'Policies and extracted rules', summary: 'Create a draft SLA policy version', description: 'Requires `policies.manage`; version configuration and source-document provenance are validated.' , fields: [{ name: 'description', required: true }, { name: 'sourceDocumentId' }, { name: 'sourceDocumentVersionId' }, { name: 'effectiveFrom', required: true }, { name: 'effectiveTo', schema: { type: ['string', 'null'] } }, { name: 'payload', required: true, schema: { type: 'object', additionalProperties: true } }] },
  { path: '/sla-policies/{policyId}/versions/{versionId}/approve', method: 'post', tag: 'Policies and extracted rules', summary: 'Approve a pending SLA policy version', description: 'Requires `policies.approve`; approval requires a reason.', fields: [{ name: 'reason', required: true }] },
  { path: '/sla-policies/{policyId}/versions/{versionId}/activate', method: 'post', tag: 'Policies and extracted rules', summary: 'Activate an approved SLA policy version', description: 'Requires `policies.activate`; only an approved, effective version can become active.', fields: [{ name: 'reason', required: true }] },
  { path: '/sla/evaluations', method: 'get', tag: 'SLA and reports', summary: 'List SLA evaluation history', description: 'Organisation administrators only. May be filtered by ticket ID.', query: [{ name: 'ticketId' }] },
  { path: '/sla/evaluations/run', method: 'post', tag: 'SLA and reports', summary: 'Evaluate tenant tickets against active SLA policy', description: 'Organisation administrators only. Uses approved, effective tenant policy and ticket evidence; no default target is inferred.' },
  { path: '/reports', method: 'get', tag: 'SLA and reports', summary: 'Get an operational report', description: 'Requires `reports.read.all` or `reports.read.team`; team scope is server-derived.', query: [{ name: 'from', required: true, schema: { type: 'string', format: 'date-time' } }, { name: 'to', required: true, schema: { type: 'string', format: 'date-time' } }] },
  { path: '/audit-logs', method: 'get', tag: 'Identity and organisation', summary: 'List organisation audit records', description: 'Organisation administrators only. Returns existing policy/knowledge audit records, AI governance audit records, and ticket history events for the active organisation, newest first.', query: [{ name: 'page', schema: { type: 'integer', minimum: 1, default: 1 } }, { name: 'pageSize', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }] },
  { path: '/tickets/{ticketId}/recommend-priority', method: 'post', tag: 'AI triage', summary: 'Preview an evidence-backed priority recommendation', description: 'Permission-gated, review-only recommendation. The endpoint does not change ticket priority.' },
  { path: '/extracted-rules', method: 'get', tag: 'Policies and extracted rules', summary: 'List candidate extracted rules', description: 'Organisation administrators only; optionally filter by policy version.', query: [{ name: 'policyVersionId' }] },
  { path: '/extracted-rules/{ruleId}', method: 'get', tag: 'Policies and extracted rules', summary: 'Get a candidate extracted rule', description: 'Organisation administrators only.' },
  { path: '/extracted-rules/{ruleId}/approve', method: 'post', tag: 'Policies and extracted rules', summary: 'Approve an extracted rule', description: 'Organisation administrators only; approval requires a reason and can include an effective date.', fields: [{ name: 'reason', required: true }, { name: 'effectiveFrom', schema: { type: 'string', format: 'date-time' } }] },
  { path: '/extracted-rules/{ruleId}/reject', method: 'post', tag: 'Policies and extracted rules', summary: 'Reject an extracted rule', description: 'Organisation administrators only; rejection requires a reason.', fields: [{ name: 'reason', required: true }] },
  { path: '/extracted-rules/{ruleId}/request-changes', method: 'post', tag: 'Policies and extracted rules', summary: 'Request changes to an extracted rule', description: 'Organisation administrators only; the reviewer reason is required.', fields: [{ name: 'reason', required: true }] },
];

function addRoute(route: ExtraRoute): void {
  const pathItem = document.paths[route.path] ?? (document.paths[route.path] = {});
  if (route.method in pathItem) throw new Error(`OpenAPI route already exists: ${route.method.toUpperCase()} ${route.path}`);
  const parameters = [
    ...[...route.path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } })),
    ...(route.query ?? []).map(parameter => ({ name: parameter.name, in: 'query', required: parameter.required ?? false, description: parameter.description, schema: parameter.schema ?? { type: 'string' } })),
  ];
  const operation: Operation = {
    tags: [route.tag], summary: route.summary, description: route.description,
    operationId: operationId(route.method, route.path),
    security: route.public ? [] : [{ bearerAuth: [], ...(!route.path.startsWith('/health') ? { organisationContext: [] } : {}) }],
    ...(parameters.length ? { parameters } : {}),
    ...(route.fields ? { requestBody: requestBody(route.fields, route.multipart ?? false) } : {}),
    responses: {
      [route.status ?? 200]: successResponse(route.responseDescription ?? route.summary),
      ...(route.status === 202 ? { 200: successResponse('Extraction result is available.') } : {}),
      default: { description: 'Authentication, authorization, validation, or dependency error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/IntegratedErrorEnvelope' } } } },
    },
  };
  pathItem[route.method] = operation;
}

function operationId(method: string, path: string): string {
  const words = `${method}_${path}`.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((word, index) => index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1)).join('');
}

function requestBody(fields: NonNullable<ExtraRoute['fields']>, multipart: boolean) {
  const properties = Object.fromEntries(fields.map(field => [field.name, field.schema ?? { type: 'string' }]));
  const required = fields.filter(field => field.required).map(field => field.name);
  const mediaType = multipart ? 'multipart/form-data' : 'application/json';
  return { required: true, content: { [mediaType]: { schema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false } } } };
}

function successResponse(description: string) {
  return { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/IntegratedSuccessEnvelope' } } } };
}

for (const route of extraRoutes) addRoute(route);

const analyzeOperation = document.paths['/tickets/{ticketId}/analyze']?.post;
if (analyzeOperation) {
  analyzeOperation.description = `${String(analyzeOperation.description ?? '')} Classification may return multiple configured category IDs. Each selected category has exact source evidence from the ticket title or description; uncertain output requires human review. See TicketClassification and TicketClassificationEvidence.`;
  analyzeOperation.responses = { ...analyzeOperation.responses, 200: { description: 'Analysis completed; classification includes configured multi-label categories and exact source evidence.', content: { 'application/json': { schema: { type: 'object', required: ['data', 'requestId'], properties: { data: { type: 'object', required: ['classification'], properties: { classification: { $ref: '#/components/schemas/TicketClassification' } }, additionalProperties: true }, requestId: { type: 'string' } }, additionalProperties: false } } } } };
}

// Foundation liveness routes are mounted outside the /api/v1 prefix.
document.paths['/health/live']!.servers = [{ url: '/' }];
document.paths['/health/ready']!.servers = [{ url: '/' }];

const outputPath = join(apiDirectory, 'integrated-openapi.json');
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath} with ${Object.keys(document.paths).length} paths and ${Object.values(document.paths).reduce((total, item) => total + Object.keys(item).filter(method => ['get', 'post', 'put', 'patch', 'delete'].includes(method)).length, 0)} operations.`);
