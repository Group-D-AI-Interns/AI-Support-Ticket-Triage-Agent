import { MongoDatabase, mongoCollectionName } from '../src/infrastructure/persistence/mongodb/mongo-database.js';
import { MongoFileStore } from '../src/infrastructure/persistence/mongodb/mongo-file-store.js';
import { isUser, isMembership } from '../src/modules/identity/model.js';
import { isOrganisation } from '../src/modules/organisations/model.js';
import { isDepartment, isTeam, isTeamMembership } from '../src/modules/teams/model.js';
import { isTicketRecord } from '../src/modules/tickets/repositories/json-ticket.store.js';
import { isWorkflowRecord } from '../src/modules/tickets/repositories/json-ticket-workflow.store.js';
import { operationSchema } from '../src/modules/ai/operations-store.js';
import { isWorkflowRuns } from '../src/modules/ai/workflow-run.js';
import { isAnalysisRecord } from '../src/modules/ai/json-ai-analysis.repository.js';
import { validateExtractionAdapterResult } from '../src/modules/documents/services/extraction-adapter.js';

export type MigrationCollection = { name: string; records: Record<string, unknown>[] };

const tenantCollections = new Set([
  'memberships', 'departments', 'teams', 'team-memberships', 'tickets', 'ticket-workflows',
  'documents', 'documentVersions', 'policies', 'policyVersions', 'extractedRules',
  'policyApprovals', 'auditLogs', 'extractionJobs', 'documentExtractions', 'slaEvaluations',
  'ai-analyses', 'ai-workflow-runs', 'ai-operations',
]);

/** Validate source records before opening Atlas or changing its state. */
export function validateMigrationCollection(name: string, value: unknown): value is Record<string, unknown>[] {
  if (name === 'ai-workflow-runs' && Array.isArray(value)) {
    return value.every(record => isWorkflowRuns({ schemaVersion: 1, records: [record] }) &&
      typeof (record as { runId?: unknown }).runId === 'string' &&
      typeof (record as { organisationId?: unknown }).organisationId === 'string' &&
      !!(record as { organisationId: string }).organisationId.trim() &&
      (!(record as { id?: unknown }).id || (record as { id: unknown }).id === (record as { runId: unknown }).runId)) &&
      new Set(value.map(record => (record as { runId: string }).runId)).size === value.length;
  }
  if (!Array.isArray(value) || !value.every(isRecordWithId) ||
    new Set(value.map(record => record.id)).size !== value.length) return false;

  const validators: Record<string, (record: unknown) => boolean> = {
    organisations: isOrganisation,
    users: isUser,
    memberships: isMembership,
    departments: isDepartment,
    teams: isTeam,
    'team-memberships': isTeamMembership,
    tickets: isTicketRecord,
    'ticket-workflows': isWorkflowRecord,
    'ai-operations': record => operationSchema.safeParse(record).success,
    documents: validDocument,
    documentVersions: validDocumentVersion,
    policies: validPolicy,
    policyVersions: validPolicyVersion,
    extractedRules: validExtractedRule,
    policyApprovals: validPolicyApproval,
    auditLogs: validAuditLog,
    extractionJobs: validExtractionJob,
    documentExtractions: validDocumentExtraction,
    slaEvaluations: validSlaEvaluation,
    'ai-analyses': isAnalysisRecord,
  };
  const validator = validators[name];
  if (validator) return value.every(validator);
  if (!tenantCollections.has(name)) return false;
  return value.every(record => typeof record.organisationId === 'string' && record.organisationId.trim().length > 0);
}

/** Map the workflow's domain key to MongoDB's generic storage key without changing JSON/API records. */
export function normalizeMigrationRecords(name: string, records: Record<string, unknown>[]): Record<string, unknown>[] {
  return name === 'ai-workflow-runs'
    ? records.map(record => ({ ...record, id: record.runId }))
    : records;
}

/** Permit a fresh or previously pre-indexed target, but never overwrite application data. */
export async function assertEmptyApplicationDatabase(database: MongoDatabase): Promise<void> {
  const existing = await database.db.listCollections({ name: /^app_/ }, { nameOnly: true }).toArray();
  for (const collection of existing) {
    const count = await database.db.collection(collection.name).countDocuments({});
    if (count > 0) {
      throw new Error('Target database contains application records; no collections were changed. Use a separate empty database.');
    }
  }
}

/** Import every selected source as one transaction and verify each count before commit. */
export async function importAndVerifyCollections(
  database: MongoDatabase,
  store: MongoFileStore,
  sources: readonly MigrationCollection[],
): Promise<void> {
  await database.transaction(async session => {
    for (const source of sources) {
      await store.importCollection(source.name, source.records);
      const actualCount = await database.db.collection(mongoCollectionName(source.name))
        .countDocuments({}, { session });
      if (actualCount !== source.records.length) {
        throw new Error(`Imported record count did not match source for ${source.name}; transaction aborted.`);
      }
    }
  });
}

function isRecordWithId(value: unknown): value is Record<string, unknown> & { id: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === 'string' && !!(value as { id: string }).id.trim();
}

function validDocument(value: unknown): boolean {
  return isTenantRecord(value) && hasText(value, ['title', 'fileName', 'mimeType', 'storageKey', 'checksumSha256', 'createdBy']) &&
    /^[a-f0-9]{64}$/i.test(value.checksumSha256 as string) &&
    oneOf(value.status, ['draft', 'uploaded', 'processing', 'processed', 'failed', 'archived']) &&
    oneOf(value.processingStatus, ['queued', 'processing', 'completed', 'failed']) && value.provider === 'private-storage' &&
    isTimestamp(value.createdAt) && isTimestamp(value.updatedAt) && positiveInteger(value.version) && nonnegativeInteger(value.fileSizeBytes);
}

function validDocumentVersion(value: unknown): boolean {
  return isTenantRecord(value) && hasText(value, ['documentId', 'checksumSha256', 'fileName', 'mimeType', 'storageKey', 'createdBy']) &&
    /^[a-f0-9]{64}$/i.test(value.checksumSha256 as string) && positiveInteger(value.version) &&
    nonnegativeInteger(value.fileSizeBytes) && isTimestamp(value.createdAt);
}

function validPolicy(value: unknown): boolean {
  return isTenantRecord(value) && hasText(value, ['policyType', 'ownerId', 'description']) &&
    oneOf(value.status, ['draft', 'pending_approval', 'approved', 'active', 'rejected', 'expired', 'archived']) &&
    positiveInteger(value.version) && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);
}

function validPolicyVersion(value: unknown): boolean {
  return isTenantRecord(value) && hasText(value, ['policyId']) &&
    oneOf(value.status, ['draft', 'pending_approval', 'approved', 'active', 'rejected', 'expired', 'archived']) &&
    positiveInteger(value.version) && isNullableTimestamp(value.effectiveFrom) && isNullableTimestamp(value.effectiveTo) &&
    isPlainObject(value.payload) && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt) &&
    optionalText(value, ['sourceDocumentId', 'sourceDocumentVersionId']);
}

function validExtractedRule(value: unknown): boolean {
  return isTenantRecord(value) && hasText(value, ['policyVersionId', 'ruleType']) &&
    optionalText(value, ['executionId', 'documentId', 'documentVersionId', 'reviewedBy', 'reviewReason']) &&
    isPlainObject(value.payload) && Array.isArray(value.evidence) && value.evidence.every(isPlainObject) &&
    (value.confidence === null || (typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1)) &&
    typeof value.ambiguous === 'boolean' && isTimestamp(value.createdAt) &&
    optionalStringArray(value, 'warnings') && optionalBoolean(value, 'requiresHumanReview') &&
    (value.reviewStatus === undefined || oneOf(value.reviewStatus, ['pending_review', 'approved', 'rejected', 'changes_requested'])) &&
    (value.reviewedAt === undefined || isTimestamp(value.reviewedAt)) && isNullableOptionalTimestamp(value.effectiveFrom);
}

function validPolicyApproval(value: unknown): boolean {
  return isTenantRecord(value) && hasText(value, ['policyVersionId', 'reviewerId', 'reason']) &&
    optionalText(value, ['extractedRuleId']) && oneOf(value.decision, ['approved', 'rejected']) &&
    isTimestamp(value.createdAt) && (value.effectiveFrom === undefined || isTimestamp(value.effectiveFrom));
}

function validAuditLog(value: unknown): boolean {
  return isTenantRecord(value) && hasText(value, ['actorId', 'action', 'targetType', 'targetId']) &&
    oneOf(value.targetType, ['policy', 'policy_version']) && isTimestamp(value.createdAt) &&
    optionalObject(value, ['before', 'after']);
}

function validExtractionJob(value: unknown): boolean {
  return isTenantRecord(value) && hasText(value, ['policyId', 'policyVersionId', 'documentId', 'documentVersionId', 'correlationId', 'executionId']) &&
    oneOf(value.status, ['queued', 'processing', 'succeeded', 'failed', 'retrying']) &&
    nonnegativeInteger(value.attempts) && positiveInteger(value.maxAttempts) &&
    isTimestamp(value.createdAt) && isTimestamp(value.updatedAt) &&
    ['claimedAt', 'completedAt'].every(key => value[key] === undefined || isTimestamp(value[key])) &&
    optionalText(value, ['lastError']) && optionalStringArray(value, 'warnings') &&
    (value.executionMetadata === undefined || (isPlainObject(value.executionMetadata) && hasText(value.executionMetadata, ['provider', 'model']) &&
      isTimestamp(value.executionMetadata.startedAt) && typeof value.executionMetadata.durationMs === 'number' && Number.isFinite(value.executionMetadata.durationMs) && value.executionMetadata.durationMs >= 0));
}

function validDocumentExtraction(value: unknown): boolean {
  if (!isTenantRecord(value) || !hasText(value, ['documentId', 'documentVersionId']) || !isTimestamp(value.createdAt)) return false;
  try {
    validateExtractionAdapterResult(value.result);
    return true;
  } catch { return false; }
}

function validSlaEvaluation(value: unknown): boolean {
  if (!isTenantRecord(value) || !hasText(value, ['ticketId', 'policyId', 'policyVersionId']) || !isTimestamp(value.evaluatedAt) ||
      !isPlainObject(value.input) || !isPlainObject(value.result)) return false;
  const input = value.input;
  const result = value.result;
  return hasText(input, ['ticketId', 'organisationId', 'priority', 'createdAt', 'now']) &&
    input.organisationId === value.organisationId && input.ticketId === value.ticketId &&
    isTimestamp(input.createdAt) && isTimestamp(input.now) &&
    hasText(result, ['ticketId', 'organisationId', 'policyId', 'policyVersionId', 'evaluatedAt']) &&
    result.ticketId === value.ticketId && result.organisationId === value.organisationId &&
    positiveInteger(result.policyVersion) && isTimestamp(result.evaluatedAt) && isPlainObject(result.metrics) &&
    validSlaMetric(result.metrics.firstResponse) && validSlaMetric(result.metrics.resolution);
}

function validSlaMetric(value: unknown): boolean {
  return isPlainObject(value) && ['targetMinutes', 'elapsedMinutes', 'remainingMinutes'].every(key =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) && (value[key] as number) >= 0) &&
    (value.deadlineAt === null || isTimestamp(value.deadlineAt)) && (value.completedAt === null || isTimestamp(value.completedAt)) &&
    oneOf(value.state, ['on_track', 'at_risk', 'breached', 'met', 'paused']) && typeof value.explanation === 'string';
}

function isTenantRecord(value: unknown): value is Record<string, unknown> & { id: string; organisationId: string } {
  return isRecordWithId(value) && typeof value.organisationId === 'string' && !!value.organisationId.trim();
}

function hasText(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => typeof value[key] === 'string' && !!(value[key] as string).trim());
}

function optionalText(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => value[key] === undefined || (typeof value[key] === 'string' && !!(value[key] as string).trim()));
}

function optionalStringArray(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || (Array.isArray(value[key]) && (value[key] as unknown[]).every(item => typeof item === 'string'));
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'boolean';
}

function optionalObject(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => value[key] === undefined || isPlainObject(value[key]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value: unknown): boolean {
  return typeof value === 'string' && !!value.trim() && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): boolean {
  return value === null || isTimestamp(value);
}

function isNullableOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isNullableTimestamp(value);
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}
