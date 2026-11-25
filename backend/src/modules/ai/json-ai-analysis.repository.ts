import { JsonStorageError, updateTenantRecords, type JsonEnvelope, type JsonFileStorePort } from '../../infrastructure/persistence/json/json-file-store.js';
import type { TenantContext } from '../../shared/tenant.js';
import type { AiAnalysisRepository } from './ports.js';
import { normalizeStoredTicketClassification, normalizeStoredTicketSummary, type TicketAiAnalysis } from './contracts.js';
import { isWorkflowRuns, orchestrationSchema, type AiWorkflowRun } from './workflow-run.js';

function isAnalyses(value: unknown): value is JsonEnvelope<TicketAiAnalysis> {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as { schemaVersion?: unknown; records?: unknown };
  return envelope.schemaVersion === 1 && Array.isArray(envelope.records) && envelope.records.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as TicketAiAnalysis;
    if (!['id', 'ticketId', 'organisationId', 'createdAt'].every((key) =>
      typeof record[key as keyof TicketAiAnalysis] === 'string' && String(record[key as keyof TicketAiAnalysis]).trim()) ||
      record.status !== 'completed' || !Number.isFinite(Date.parse(record.createdAt)) || !Array.isArray(record.executions)) return false;
    try {
      normalizeStoredTicketClassification(record.classification);
      normalizeStoredTicketSummary(record.summary);
      if (record.orchestration !== undefined && !orchestrationSchema.safeParse(record.orchestration).success) return false;
      return record.executions.length === 2 && record.executions.every((execution) =>
        execution && typeof execution.executionId === 'string' && execution.executionId.trim() &&
        ['ticket_classification', 'ticket_summarization'].includes(execution.task) && execution.status === 'completed' &&
        typeof execution.provider === 'string' && execution.provider.trim() &&
        typeof execution.model === 'string' && execution.model.trim() &&
        Number.isInteger(execution.attempts) && execution.attempts > 0 &&
        (execution.usage === undefined || (typeof execution.usage === 'object' && execution.usage !== null && !Array.isArray(execution.usage) &&
          Object.entries(execution.usage).every(([key, count]) => ['promptTokens', 'completionTokens', 'totalTokens'].includes(key) && Number.isSafeInteger(count) && (count as number) >= 0))) &&
        (execution.validationRetryOf === undefined || (typeof execution.validationRetryOf === 'string' && !!execution.validationRetryOf.trim() && execution.validationRetryOf !== execution.executionId)) &&
        Number.isFinite(execution.durationMs) && execution.durationMs >= 0 &&
        Number.isFinite(Date.parse(execution.startedAt)) && Number.isFinite(Date.parse(execution.completedAt)));
    } catch { return false; }
  });
}

export function isAnalysisRecord(value: unknown): value is TicketAiAnalysis {
  return isAnalyses({ schemaVersion: 1, records: [value] });
}

function isWorkflowRunRecord(value: unknown): value is AiWorkflowRun {
  return isWorkflowRuns({ schemaVersion: 1, records: [value] });
}
type PersistedWorkflowRun = AiWorkflowRun & { id: string };
function isPersistedWorkflowRun(value: unknown): value is PersistedWorkflowRun {
  return isWorkflowRunRecord(value) && typeof (value as unknown as { id?: unknown }).id === 'string' &&
    (value as unknown as { id: string }).id === value.runId;
}

export class JsonAiAnalysisRepository implements AiAnalysisRepository {
  constructor(private readonly store: JsonFileStorePort) {}

  async saveWorkflowRun(tenant: TenantContext, run: AiWorkflowRun): Promise<void> {
    if (run.organisationId !== tenant.organisationId || run.initiatedBy !== tenant.userId || !isWorkflowRuns({ schemaVersion: 1, records: [run] })) {
      throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'Invalid tenant-scoped workflow metadata.');
    }
    if (this.store.updateTenant) {
      await updateTenantRecords<PersistedWorkflowRun, void>(this.store, 'ai-workflow-runs.json', tenant.organisationId, isPersistedWorkflowRun, records => {
        if (records.some(record => record.runId === run.runId)) throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'Duplicate workflow run ID.');
        records.push({ ...structuredClone(run), id: run.runId });
      });
      return;
    }
    await this.store.update('ai-workflow-runs.json', isWorkflowRuns, envelope => {
      if (envelope.records.some(record => record.runId === run.runId)) throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'Duplicate workflow run ID.');
      envelope.records.push(structuredClone(run));
    });
  }
  async listWorkflowRuns(tenant: TenantContext, ticketId: string): Promise<AiWorkflowRun[]> {
    const records = await this.store.findRecords('ai-workflow-runs.json', isWorkflowRunRecord, {
      organisationId: tenant.organisationId,
      ticketId,
    });
    return records.map(record => {
      const { id: _storageId, ...run } = record as AiWorkflowRun & { id?: string };
      return run;
    });
  }

  async save(tenant: TenantContext, analysis: TicketAiAnalysis): Promise<void> {
    if (tenant.organisationId !== analysis.organisationId || !isAnalyses({ schemaVersion: 1, records: [analysis] })) {
      throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'Invalid tenant-scoped AI analysis.');
    }
    await updateTenantRecords<TicketAiAnalysis, void>(this.store, 'ai-analyses.json', tenant.organisationId, isAnalysisRecord, records => {
      if (records.some((record) => record.id === analysis.id)) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'Duplicate AI analysis ID.');
      }
      records.push(structuredClone(analysis));
    });
  }

  async listForTicket(tenant: TenantContext, ticketId: string): Promise<TicketAiAnalysis[]> {
    const records = await this.store.findRecords('ai-analyses.json', isAnalysisRecord, {
      organisationId: tenant.organisationId,
      ticketId,
    });
    return records.map(record => ({ ...record, classification: normalizeStoredTicketClassification(record.classification), summary: normalizeStoredTicketSummary(record.summary) }));
  }
}
