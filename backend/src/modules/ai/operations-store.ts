import * as z from 'zod';
import { validTriageResult, validPriorityEvidence } from './triage-result-validation.js';
import { JsonFileStore, JsonStorageError, type JsonEnvelope } from '../../infrastructure/persistence/json/json-file-store.js';

const text = z.string().trim().min(1);
const stamp = z.iso.datetime({ offset: true });
const base = { id: text, organisationId: text, actorId: text, createdAt: stamp, updatedAt: stamp };
export const routingInput = z.strictObject({ categoryIds: z.array(text).min(1).max(30), teamId: text, effectiveFrom: stamp, effectiveTo: stamp.nullable().optional() });
export const resolutionInput = z.strictObject({ resolution: text.max(8_000), visibility: z.enum(['team', 'organisation_staff']), reason: text.max(2_000) });
export const reviewInput = z.strictObject({ decision: z.enum(['accepted', 'rejected', 'needs_information']), reason: text.max(2_000),
  quality: z.strictObject({ classificationCorrect: z.boolean(), groundedness: z.enum(['grounded', 'partially_grounded', 'unsupported']) }).optional() });
const schemas = [
  z.strictObject({ ...base, kind: z.literal('routing'), data: routingInput.extend({ status: z.enum(['draft', 'approved', 'disabled']), approvedBy: text.optional(), reason: text.optional() }) }),
  z.strictObject({ ...base, kind: z.literal('resolution'), data: resolutionInput.extend({ ticketId: text, ticketRevision: text, active: z.boolean() }) }),
  z.strictObject({ ...base, kind: z.literal('report'), data: z.strictObject({ ticketId: text, snapshot: z.strictObject({ id: text, organisationId: text, title: text, description: z.string() }), result: z.json() }) }),
  z.strictObject({ ...base, kind: z.literal('review'), data: reviewInput.extend({ reportId: text }) }),
  z.strictObject({ ...base, kind: z.literal('job'), data: z.strictObject({ ticketId: text, snapshotHash: text, status: z.enum(['queued', 'running', 'completed', 'failed']),
    attempts: z.number().int().nonnegative(), maxAttempts: z.number().int().min(1).max(5), availableAt: stamp, leaseUntil: stamp.nullable(), leaseToken: text.nullable(), reportId: text.nullable(), errorCode: text.nullable() }) }),
  z.strictObject({ ...base, kind: z.literal('evaluation'), data: z.json() }),
  z.strictObject({ ...base, kind: z.literal('audit'), data: z.strictObject({ action: text, targetId: text, reason: text }) }),
] as const;
export const operationSchema = z.discriminatedUnion('kind', schemas);
export type Operation = z.infer<typeof operationSchema>;
export type OfKind<K extends Operation['kind']> = Extract<Operation, { kind: K }>;
function valid(value: unknown): value is JsonEnvelope<Operation> {
  const parsed = z.strictObject({ schemaVersion: z.literal(1), records: z.array(operationSchema) }).safeParse(value);
  if (!parsed.success) return false;
  return parsed.data.records.every(row => row.kind !== 'report' || (validTriageResult(row.data.result) &&
    row.data.result.organisationId === row.organisationId && row.data.result.ticketId === row.data.ticketId &&
    row.data.snapshot.id === row.data.ticketId && row.data.snapshot.organisationId === row.organisationId && validPriorityEvidence(row.data.result, row.data.snapshot)));
}

/** Single atomic ledger makes report/job/audit and decision updates recoverable together. */
export class AiOperationsStore {
  constructor(private readonly files: JsonFileStore) {}
  async all() { return (await this.files.read('ai-operations.json', valid)).records; }
  async list<K extends Operation['kind']>(organisationId: string, kind: K): Promise<OfKind<K>[]> {
    return (await this.all()).filter((row): row is OfKind<K> => row.organisationId === organisationId && row.kind === kind);
  }
  async change<T>(action: (rows: Operation[]) => T | Promise<T>): Promise<T> {
    return this.files.update('ai-operations.json', valid, async envelope => {
      const result = await action(envelope.records);
      if (!valid(envelope)) throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'Invalid AI operation record.');
      return result;
    });
  }
}
