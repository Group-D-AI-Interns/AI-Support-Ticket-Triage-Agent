import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import type { JsonTenantStore } from '../../infrastructure/persistence/json/json-store.js';
import type { TenantContext } from '../../shared/tenant.js';
import { JsonDocumentRepository } from './repositories/json-document.repository.js';
import { DocumentLifecycleService } from './services/document-lifecycle.service.js';
import { ExtractionJobService } from './services/extraction-job-service.js';
import { createLocalPrivateStorageAdapter, type DocumentStorageAdapter } from './storage/document-storage.js';
import { JsonPolicyRepository } from '../policies/repositories/json-policy.repository.js';
import type { PolicyRecord, PolicyVersionRecord } from '../policies/domain/policy.js';

export type DocumentPolicyDevelopmentPrincipal = {
  bearerToken: string;
  organisationId: string;
  userId: string;
  roles: ReadonlySet<'organisation_admin'>;
};

export type DocumentPolicyApiDependencies = {
  store: JsonTenantStore;
  storage: DocumentStorageAdapter;
  developmentPrincipal: DocumentPolicyDevelopmentPrincipal | null;
};

const MAX_REQUEST_BYTES = 30 * 1024 * 1024;

export function loadDocumentPolicyDevelopmentPrincipal(
  environment: Record<string, string | undefined>,
): DocumentPolicyDevelopmentPrincipal | null {
  const raw = environment.DOCUMENT_POLICY_DEV_PRINCIPAL;
  if (!raw) return null;
  if (environment.APP_ENV !== 'development') {
    throw new Error('DOCUMENT_POLICY_DEV_PRINCIPAL is permitted only in development.');
  }

  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    throw new Error('DOCUMENT_POLICY_DEV_PRINCIPAL must contain valid JSON.');
  }
  if (!isRecord(value)) throw new Error('DOCUMENT_POLICY_DEV_PRINCIPAL must be a JSON object.');

  const bearerToken = value.bearerToken;
  const organisationId = value.organisationId;
  const userId = value.userId;
  const roles = value.roles;
  if (typeof bearerToken !== 'string' || bearerToken.length < 32) {
    throw new Error('The development bearer token must contain at least 32 characters.');
  }
  if (typeof organisationId !== 'string' || !organisationId) throw new Error('A development organisationId is required.');
  if (typeof userId !== 'string' || !userId) throw new Error('A development userId is required.');
  if (!Array.isArray(roles) || roles.length !== 1 || roles[0] !== 'organisation_admin') {
    throw new Error('Document/policy development roles must contain organisation_admin only.');
  }

  return { bearerToken, organisationId, userId, roles: new Set(['organisation_admin']) };
}

export function createDocumentPolicyApi(dependencies: DocumentPolicyApiDependencies): RequestListener {
  return (request, response) => {
    const requestId = `req_${randomUUID()}`;
    response.setHeader('X-Request-ID', requestId);
    void dispatch(request, response, dependencies, requestId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'The request could not be completed.';
      const status = error instanceof ValidationError
        ? error.status
        : isNotFoundError(message) ? 404 : isConflictError(message) ? 409 : isValidationError(message) ? 400 : 500;
      const code = status === 401 ? 'UNAUTHENTICATED'
        : status === 503 ? 'CONFIGURATION_ERROR'
        : status === 500 ? 'INTERNAL_ERROR'
        : status === 404 ? 'NOT_FOUND'
        : status === 409 ? 'CONFLICT'
        : 'VALIDATION_ERROR';
      sendJson(response, status, {
        error: { code, message: status === 500 ? 'The request could not be completed.' : message, requestId, fields: [] },
      });
    });
  };
}

async function dispatch(request: IncomingMessage, response: ServerResponse, dependencies: DocumentPolicyApiDependencies, requestId: string): Promise<void> {
  const tenant = authenticate(request, dependencies.developmentPrincipal);
  const url = new URL(request.url ?? '/', 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);

  const policyRepository = new JsonPolicyRepository(dependencies.store);
  const documentRepository = new JsonDocumentRepository(dependencies.store);
  const lifecycle = new DocumentLifecycleService(dependencies.store, dependencies.storage);
  const jobService = new ExtractionJobService(dependencies.store, policyRepository);

  if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'documents') {
    if (segments.length === 3 && request.method === 'POST') {
      const body = await readJsonBody(request);
      const fileName = requireString(body.fileName, 'fileName');
      const mimeType = requireString(body.mimeType, 'mimeType');
      const content = requireBase64(body.content, 'content');
      const title = requireString(body.title, 'title');
      const createdBy = typeof body.createdBy === 'string' ? body.createdBy : tenant.userId;
      const result = await lifecycle.uploadDocument({ tenant, title, fileName, mimeType, content, createdBy });
      sendJson(response, 201, { data: { document: result.document, version: result.version }, requestId });
      return;
    }
    if (segments.length === 3 && request.method === 'GET') {
      sendJson(response, 200, { data: await lifecycle.listDocuments(tenant), requestId });
      return;
    }
    if (segments.length === 4 && request.method === 'GET') {
      const documentId = segments[3];
      if (!documentId) throw new ValidationError('Document ID is required.');
      const document = await lifecycle.getDocument(tenant, documentId);
      if (!document) throw new NotFoundError('Document not found.');
      sendJson(response, 200, { data: document, requestId });
      return;
    }
    if (segments.length === 5 && segments[4] === 'download-token' && request.method === 'POST') {
      const documentId = segments[3];
      if (!documentId) throw new ValidationError('Document ID is required.');
      const token = await lifecycle.createDownloadToken(tenant, documentId);
      if (!token) throw new NotFoundError('Document not found.');
      sendJson(response, 200, { data: { downloadToken: token }, requestId });
      return;
    }
    if (segments.length === 5 && segments[4] === 'process' && request.method === 'POST') {
      const documentId = segments[3];
      if (!documentId) throw new ValidationError('Document ID is required.');
      const body = await readJsonBody(request);
      const policyId = requireString(body.policyId, 'policyId');
      const policyVersionId = requireString(body.policyVersionId, 'policyVersionId');
      const maxAttempts = body.maxAttempts === undefined ? undefined : requirePositiveInteger(body.maxAttempts, 'maxAttempts');
      const job = await jobService.processDocument({
        tenant,
        documentId,
        policyId,
        policyVersionId,
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
      });
      sendJson(response, 202, { data: job, requestId });
      return;
    }
    if (segments.length === 5 && segments[4] === 'extractions' && request.method === 'GET') {
      const documentId = segments[3];
      if (!documentId) throw new ValidationError('Document ID is required.');
      const document = await documentRepository.getById(tenant, documentId);
      if (!document) throw new NotFoundError('Document not found.');
      const rules = await policyRepository.listExtractedRules(tenant);
      sendJson(response, 200, { data: rules.filter((rule) => rule.documentId === document.id), requestId });
      return;
    }
  }

  if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'policies') {
    if (segments.length === 3 && request.method === 'GET') {
      sendJson(response, 200, { data: await policyRepository.listPolicies(tenant), requestId });
      return;
    }
    if (segments.length === 3 && request.method === 'POST') {
      const body = await readJsonBody(request);
      const timestamp = new Date().toISOString();
      const policy: PolicyRecord = {
        id: `policy-${randomUUID()}`,
        organisationId: tenant.organisationId,
        policyType: requireString(body.policyType, 'policyType'),
        ownerId: tenant.userId,
        status: 'draft',
        createdAt: timestamp,
        updatedAt: timestamp,
        version: requirePositiveInteger(body.version ?? 1, 'version'),
        description: typeof body.description === 'string' ? body.description : '',
      };
      sendJson(response, 201, { data: await policyRepository.createPolicy(policy, tenant), requestId });
      return;
    }
    if (segments.length === 5 && segments[4] === 'versions' && request.method === 'GET') {
      const policyId = segments[3];
      if (!policyId) throw new ValidationError('Policy ID is required.');
      const policy = await policyRepository.getPolicyById(tenant, policyId);
      if (!policy) throw new NotFoundError('Policy not found.');
      const storeVersions = await dependencies.store.readCollection<PolicyVersionRecord>('policyVersions');
      sendJson(response, 200, { data: storeVersions.filter((version) => version.organisationId === tenant.organisationId && version.policyId === policy.id), requestId });
      return;
    }
    if (segments.length === 5 && segments[4] === 'versions' && request.method === 'POST') {
      const policyId = segments[3];
      if (!policyId) throw new ValidationError('Policy ID is required.');
      const policy = await policyRepository.getPolicyById(tenant, policyId);
      if (!policy) throw new NotFoundError('Policy not found.');
      const body = await readJsonBody(request);
      const timestamp = new Date().toISOString();
      const version: PolicyVersionRecord = {
        id: `policy-version-${randomUUID()}`,
        organisationId: tenant.organisationId,
        policyId: policy.id,
        version: requirePositiveInteger(body.version, 'version'),
        status: 'draft',
        effectiveFrom: typeof body.effectiveFrom === 'string' ? body.effectiveFrom : null,
        effectiveTo: typeof body.effectiveTo === 'string' ? body.effectiveTo : null,
        payload: isRecord(body.payload) ? body.payload : {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      sendJson(response, 201, { data: await policyRepository.createVersion(policy.id, version, tenant), requestId });
      return;
    }
    if (segments.length === 5 && segments[4] === 'activate' && request.method === 'POST') {
      const policyId = segments[3];
      if (!policyId) throw new ValidationError('Policy ID is required.');
      const policy = await policyRepository.getPolicyById(tenant, policyId);
      if (!policy) throw new NotFoundError('Policy not found.');
      const body = await readJsonBody(request);
      const versionId = requireString(body.versionId, 'versionId');
      const version = await policyRepository.getVersionById(tenant, versionId);
      if (!version || version.policyId !== policy.id) throw new NotFoundError('Policy version not found.');
      if (body.effectiveFrom !== undefined) {
        if (typeof body.effectiveFrom !== 'string' || Number.isNaN(Date.parse(body.effectiveFrom))) throw new ValidationError('effectiveFrom must be a valid timestamp.');
      }
      await policyRepository.transitionVersionStatus(tenant, versionId, 'pending_approval');
      await policyRepository.addApproval({
        id: `policy-approval-${randomUUID()}`,
        organisationId: tenant.organisationId,
        policyVersionId: versionId,
        reviewerId: tenant.userId,
        decision: 'approved',
        reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'Approved by organisation administrator.',
        createdAt: new Date().toISOString(),
      }, tenant);
      const active = await policyRepository.transitionVersionStatus(tenant, versionId, 'active');
      sendJson(response, 200, { data: active, requestId });
      return;
    }
  }

  if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'extracted-rules' && segments.length === 5) {
    const ruleId = segments[3];
    if (!ruleId) throw new ValidationError('Extracted rule ID is required.');
    if (request.method === 'GET') {
      const rule = await policyRepository.getExtractedRuleById(tenant, ruleId);
      if (!rule) throw new NotFoundError('Extracted rule not found.');
      sendJson(response, 200, { data: rule, requestId });
      return;
    }
    if (segments[4] === 'approve' || segments[4] === 'reject' || segments[4] === 'request-changes') {
      if (request.method !== 'POST') throw new MethodNotAllowedError();
      const body = await readJsonBody(request);
      const reason = requireString(body.reason ?? body.decisionReason, 'reason');
      const decision = segments[4] === 'approve' ? 'approved' : segments[4] === 'reject' ? 'rejected' : 'changes_requested';
      const effectiveFrom = typeof body.effectiveFrom === 'string' ? body.effectiveFrom : undefined;
      const reviewed = await policyRepository.reviewExtractedRule(tenant, ruleId, decision, reason, effectiveFrom);
      sendJson(response, 200, { data: reviewed, requestId });
      return;
    }
  }

  throw new NotFoundError('Resource not found.');
}

function authenticate(request: IncomingMessage, principal: DocumentPolicyDevelopmentPrincipal | null): TenantContext {
  if (!principal) throw new ValidationError('Document/policy development principal is not configured.', 503);
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.toLowerCase().startsWith('bearer ')) throw new ValidationError('Bearer authentication is required.', 401);
  const provided = authorization.slice(7);
  const expected = Buffer.from(principal.bearerToken);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new ValidationError('Authentication failed.', 401);
  return { organisationId: principal.organisationId, userId: principal.userId, roles: ['organisation_admin'] };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new ValidationError('Request body exceeds the approved size limit.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    throw new ValidationError('Request body must be valid JSON.');
  }
}

function requireBase64(value: unknown, field: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw new ValidationError(`${field} is required.`);
  try {
    const buffer = Buffer.from(value, 'base64');
    if (buffer.length === 0) throw new Error();
    return buffer;
  } catch {
    throw new ValidationError(`${field} must be valid base64 content.`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${field} is required.`);
  return value.trim();
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new ValidationError(`${field} must be a positive integer.`);
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

class ValidationError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
class NotFoundError extends Error {}
class ConflictError extends Error {}
class MethodNotAllowedError extends Error {}

function isValidationError(message: string): boolean {
  return /required|valid|unsupported|exceeds|corrupted|must|cannot|authentication/i.test(message);
}
function isNotFoundError(message: string): boolean { return /not found|does not exist|missing/i.test(message); }
function isConflictError(message: string): boolean { return /already|immutable|conflict/i.test(message); }
