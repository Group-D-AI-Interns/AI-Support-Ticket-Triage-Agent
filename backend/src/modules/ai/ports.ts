import type { TenantContext } from '../../shared/tenant.js';
import type { TicketAiAnalysis, TicketAiView } from './contracts.js';

export interface AuthorizedTicketAnalysisSource {
  getAuthorizedTicket(
    tenant: TenantContext,
    ticketId: string,
  ): Promise<TicketAiView | null>;
}

export interface AiAnalysisRepository {
  save(tenant: TenantContext, analysis: TicketAiAnalysis): Promise<void>;
  listForTicket(tenant: TenantContext, ticketId: string): Promise<TicketAiAnalysis[]>;
}

export type AiExecutionLogEvent = {
  executionId: string;
  task: string;
  status: 'completed' | 'failed';
  provider: string | null;
  model: string | null;
  attempts: number;
  durationMs: number;
  errorCode?: string;
};

export interface AiExecutionLogger {
  record(event: AiExecutionLogEvent): Promise<void>;
}
