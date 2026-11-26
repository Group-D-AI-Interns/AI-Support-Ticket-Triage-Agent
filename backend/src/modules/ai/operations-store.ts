import * as z from 'zod';
import { normalizeStoredTriageResult, validTriageResult, validPriorityEvidence } from './triage-result-validation.js';
import { JsonStorageError, updateTenantRecords, type JsonEnvelope, type JsonFileStorePort } from '../../infrastructure/persistence/json/json-file-store.js';

const text = z.string().trim().min(1);
const stamp = z.iso.datetime({ offset: true });
const base = { id: text, organisationId: text, actorId: text, createdAt: stamp, updatedAt: stamp };
const incidentPriority = z.enum(['P1', 'P2', 'P3', 'P4']);
const legacyPriorityMatrix = z.strictObject({ high: z.strictObject({ high: incidentPriority, medium: incidentPriority, low: incidentPriority }), medium: z.strictObject({ high: incidentPriority, medium: incidentPriority, low: incidentPriority }), low: z.strictObject({ high: incidentPriority, medium: incidentPriority, low: incidentPriority }) });
const currentPriorityMatrix = z.strictObject({ critical: z.strictObject({ immediate: incidentPriority, high: incidentPriority, medium: incidentPriority, low: incidentPriority }), high: z.strictObject({ immediate: incidentPriority, high: incidentPriority, medium: incidentPriority, low: incidentPriority }), medium: z.strictObject({ immediate: incidentPriority, high: incidentPriority, medium: incidentPriority, low: incidentPriority }), low: z.strictObject({ immediate: incidentPriority, high: incidentPriority, medium: incidentPriority, low: incidentPriority }) });
const storedPriorityMatrix = z.union([legacyPriorityMatrix, currentPriorityMatrix]);
const affectedUsersSchema = z.strictObject({ scope: z.enum(['one_user', 'small_group', 'multiple_users_one_department', 'multiple_departments', 'organisation_wide']), count: z.number().int().positive().safe().optional() });
const ticketSnapshotSchema = z.strictObject({ id: text, organisationId: text, title: text, description: z.string(), product: z.string().nullable().optional(), affectedService: z.string().nullable().optional(), affectedUsers: affectedUsersSchema.optional(), businessImpact: z.enum(['critical', 'high', 'medium', 'low']).optional(), urgency: z.enum(['immediate', 'high', 'medium', 'low']).optional() });
export const priorityPolicyInput = z.strictObject({
  matrix: currentPriorityMatrix,
  sourceDocumentId: text, sourceDocumentVersionId: text, reason: text.max(2000),
});
export const routingInput = z.strictObject({ categoryIds: z.array(text).min(1).max(30), teamId: text, effectiveFrom: stamp, effectiveTo: stamp.nullable().optional() });
export const resolutionInput = z.strictObject({ resolution: text.max(8_000), visibility: z.enum(['team', 'organisation_staff']), reason: text.max(2_000) });
export const reviewedResolutionSchema = z.strictObject({ summary: text.max(4_000), steps: z.array(z.strictObject({ instruction: text.max(4_000), citations: z.array(z.strictObject({ passageId: text, excerpt: text })).min(1).max(5) })).max(10), missingInformation: z.array(text).max(20), warnings: z.array(text).max(20) });
export const reviewInput = z.strictObject({ decision: z.enum(['accepted', 'rejected', 'needs_information']), reason: text.max(2_000),
  quality: z.strictObject({ classificationCorrect: z.boolean(), groundedness: z.enum(['grounded', 'partially_grounded', 'unsupported']) }).optional(), editedResolution: reviewedResolutionSchema.optional() });
const schemas = [
  z.strictObject({ ...base, kind: z.literal('category'), data: z.strictObject({ categoryId: text, name: text.max(120), description: z.string().trim().max(500).optional(), status: z.enum(['active', 'disabled']) }) }),
  z.strictObject({ ...base, kind: z.literal('routing'), data: routingInput.extend({ status: z.enum(['draft', 'approved', 'disabled']), approvedBy: text.optional(), reason: text.optional() }) }),
  z.strictObject({ ...base, kind: z.literal('priority_policy'), data: z.strictObject({ version: z.number().int().positive(), status: z.enum(['draft', 'approved', 'active', 'archived']), matrix: storedPriorityMatrix, sourceDocumentId: text, sourceDocumentVersionId: text, sourceChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/), reason: text.max(2000), approvedBy: text.optional(), approvalReason: text.optional(), activatedBy: text.optional(), activationReason: text.optional() }) }),
  z.strictObject({ ...base, kind: z.literal('resolution'), data: resolutionInput.extend({ ticketId: text, ticketRevision: text, active: z.boolean() }) }),
  z.strictObject({ ...base, kind: z.literal('resolution_recommendation'), data: z.strictObject({
    ticketId: text, cacheKey: z.string().regex(/^[a-f0-9]{64}$/), generationId: text, version: z.number().int().positive(),
    status: z.enum(['generating', 'completed', 'failed']), leaseUntil: stamp.nullable(),
    executionId: text.nullable(), regenerationReason: z.string().trim().max(2000).optional(), result: z.json().nullable(),
  }).superRefine((data, ctx) => {
    if ((data.status === 'completed') !== (data.result !== null) || (data.status !== 'generating' && data.leaseUntil !== null)) {
      ctx.addIssue({ code: 'custom', message: 'Inconsistent resolution recommendation state.' });
    }
  }) }),
  z.strictObject({ ...base, kind: z.literal('report'), data: z.strictObject({ ticketId: text, snapshot: ticketSnapshotSchema, result: z.json() }) }),
  z.strictObject({ ...base, kind: z.literal('review'), data: z.strictObject({ decision: reviewInput.shape.decision, reason: reviewInput.shape.reason,
    quality: reviewInput.shape.quality, reportId: text, resolutionRevision: z.strictObject({ before: reviewedResolutionSchema, after: reviewedResolutionSchema }).optional() }) }),
  z.strictObject({ ...base, kind: z.literal('job'), data: z.strictObject({ ticketId: text, snapshotHash: text, status: z.enum(['queued', 'running', 'completed', 'failed']),
    automatic: z.boolean().optional(), attempts: z.number().int().nonnegative(), maxAttempts: z.number().int().min(1).max(5), availableAt: stamp, leaseUntil: stamp.nullable(), leaseToken: text.nullable(), reportId: text.nullable(), errorCode: text.nullable() }) }),
  z.strictObject({ ...base, kind: z.literal('evaluation'), data: z.json() }),
  z.strictObject({ ...base, kind: z.literal('audit'), data: z.strictObject({ action: text, targetId: text, reason: text, details: z.strictObject({ before: z.json(), after: z.json() }).optional() }) }),
] as const;
export const operationSchema = z.discriminatedUnion('kind', schemas);
export type Operation = z.infer<typeof operationSchema>;
export type OfKind<K extends Operation['kind']> = Extract<Operation, { kind: K }>;
function normalizeStoredOperation(record: Operation): Operation {
  if (record.kind !== 'report') return record;
  return {
    ...record,
    data: {
      ...record.data,
      result: normalizeStoredTriageResult(record.data.result, record.data.snapshot) as unknown as typeof record.data.result,
    },
  };
}
function valid(value: unknown): value is JsonEnvelope<Operation> {
  const parsed = z.strictObject({ schemaVersion: z.literal(1), records: z.array(operationSchema) }).safeParse(value);
  if (!parsed.success) return false;
  return parsed.data.records.every(row => row.kind !== 'report' || (validTriageResult(row.data.result, row.data.snapshot) &&
    row.data.result.organisationId === row.organisationId && row.data.result.ticketId === row.data.ticketId &&
    row.data.snapshot.id === row.data.ticketId && row.data.snapshot.organisationId === row.organisationId && validPriorityEvidence(row.data.result, row.data.snapshot)));
}

function validOperationRecord(value: unknown): value is Operation {
  return valid({ schemaVersion: 1, records: [value] });
}

/** Single atomic ledger makes report/job/audit and decision updates recoverable together. */
export class AiOperationsStore {
  constructor(private readonly files: JsonFileStorePort) {}
  async all() { return (await this.files.read('ai-operations.json', valid)).records.map(normalizeStoredOperation); }
  async list<K extends Operation['kind']>(organisationId: string, kind: K): Promise<OfKind<K>[]> {
    const records = await this.files.findRecords('ai-operations.json', validOperationRecord, {
      organisationId,
      kind,
    });
    return records.map(normalizeStoredOperation) as OfKind<K>[];
  }
  async listJobsForPolling(): Promise<OfKind<'job'>[]> {
    return this.files.findRecords('ai-operations.json', validOperationRecord, {
      kind: 'job',
      'data.status': { $in: ['queued', 'running'] },
    }) as Promise<OfKind<'job'>[]>;
  }
  async findJobById(id: string): Promise<OfKind<'job'> | null> {
    return (await this.files.findRecords('ai-operations.json', validOperationRecord, { id, kind: 'job' }) as OfKind<'job'>[])[0] ?? null;
  }
  async changeForOrganisation<T>(organisationId: string, action: (rows: Operation[]) => T | Promise<T>): Promise<T> {
    return updateTenantRecords<Operation, T>(this.files, 'ai-operations.json', organisationId, validOperationRecord, async rows => {
      const result = await action(rows);
      if (!rows.every(validOperationRecord)) throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'Invalid AI operation record.');
      return result;
    });
  }
  async change<T>(action: (rows: Operation[]) => T | Promise<T>): Promise<T> {
    return this.files.update('ai-operations.json', valid, async envelope => {
      const result = await action(envelope.records);
      if (!valid(envelope)) throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'Invalid AI operation record.');
      return result;
    });
  }
}
