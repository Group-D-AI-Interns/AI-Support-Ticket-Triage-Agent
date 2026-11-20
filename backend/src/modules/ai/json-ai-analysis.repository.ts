import { JsonFileStore, JsonStorageError, type JsonEnvelope } from '../../infrastructure/persistence/json/json-file-store.js';
import type { TenantContext } from '../../shared/tenant.js';
import type { AiAnalysisRepository } from './ports.js';
import { validateTicketClassification, validateTicketSummary, type TicketAiAnalysis } from './contracts.js';
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
      const category = record.classification?.category;
      validateTicketClassification(record.classification, typeof category === 'string' ? [{ id: category, name: category }] : []);
      validateTicketSummary(record.summary);
      if (record.orchestration !== undefined && !orchestrationSchema.safeParse(record.orchestration).success) return false;
      return record.executions.length === 2 && record.executions.every((execution) =>
        execution && typeof execution.executionId === 'string' && execution.executionId.trim() &&
        ['ticket_classification', 'ticket_summarization'].includes(execution.task) && execution.status === 'completed' &&
        typeof execution.provider === 'string' && execution.provider.trim() &&
        typeof execution.model === 'string' && execution.model.trim() &&
        Number.isInteger(execution.attempts) && execution.attempts > 0 &&
        Number.isFinite(execution.durationMs) && execution.durationMs >= 0 &&
        Number.isFinite(Date.parse(execution.startedAt)) && Number.isFinite(Date.parse(execution.completedAt)));
    } catch { return false; }
  });
}

export class JsonAiAnalysisRepository implements AiAnalysisRepository {
  constructor(private readonly store: JsonFileStore) {}

  async saveWorkflowRun(tenant: TenantContext, run: AiWorkflowRun): Promise<void> {
    if (run.organisationId !== tenant.organisationId || run.initiatedBy !== tenant.userId || !isWorkflowRuns({ schemaVersion: 1, records: [run] })) {
      throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'Invalid tenant-scoped workflow metadata.');
    }
    await this.store.update('ai-workflow-runs.json', isWorkflowRuns, envelope => {
      if (envelope.records.some(record => record.runId === run.runId)) throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'Duplicate workflow run ID.');
      envelope.records.push(structuredClone(run));
    });
  }
  async listWorkflowRuns(tenant: TenantContext, ticketId: string): Promise<AiWorkflowRun[]> {
    return (await this.store.read('ai-workflow-runs.json', isWorkflowRuns)).records.filter(run => run.organisationId === tenant.organisationId && run.ticketId === ticketId);
  }

  async save(tenant: TenantContext, analysis: TicketAiAnalysis): Promise<void> {
    if (tenant.organisationId !== analysis.organisationId || !isAnalyses({ schemaVersion: 1, records: [analysis] })) {
      throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'Invalid tenant-scoped AI analysis.');
    }
    await this.store.update('ai-analyses.json', isAnalyses, (envelope) => {
      if (envelope.records.some((record) => record.id === analysis.id)) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'Duplicate AI analysis ID.');
      }
      envelope.records.push(structuredClone(analysis));
    });
  }

  async listForTicket(tenant: TenantContext, ticketId: string): Promise<TicketAiAnalysis[]> {
    return (await this.store.read('ai-analyses.json', isAnalyses)).records
      .filter((record) => record.organisationId === tenant.organisationId && record.ticketId === ticketId);
  }
}
