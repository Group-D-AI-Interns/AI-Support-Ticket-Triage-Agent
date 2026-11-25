import type { TenantContext } from '../../shared/tenant.js';
import type { TicketAiAnalysis, TicketAiView } from './contracts.js';
import type { AiWorkflowRun } from './workflow-run.js';

export interface AuthorizedTicketAnalysisSource {
  getAuthorizedTicket(
    tenant: TenantContext,
    ticketId: string,
  ): Promise<TicketAiView | null>;
}

export interface AiAnalysisRepository {
  save(tenant: TenantContext, analysis: TicketAiAnalysis): Promise<void>;
  listForTicket(tenant: TenantContext, ticketId: string): Promise<TicketAiAnalysis[]>;
  /** Optional for existing adapters; JSON runtime implements durable metadata for every graph outcome. */
  saveWorkflowRun?(tenant: TenantContext, run: AiWorkflowRun): Promise<void>;
  listWorkflowRuns?(tenant: TenantContext, ticketId: string): Promise<AiWorkflowRun[]>;
}

export type AiExecutionLogEvent = {
  executionId: string;
  task: string;
  status: 'completed' | 'failed';
  provider: string | null;
  model: string | null;
  attempts: number;
  durationMs: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  errorCode?: string;
};

export interface AiExecutionLogger {
  record(event: AiExecutionLogEvent): Promise<void>;
}
