import { randomUUID } from 'node:crypto';

import type { TenantContext } from '../../shared/tenant.js';
import type {
  TicketAiAnalysis,
  TicketClassificationCategory,
} from './contracts.js';
import type { AiAnalysisRepository, AuthorizedTicketAnalysisSource } from './ports.js';
import { TicketClassifier } from './components/ticket-classifier.js';
import { TicketSummarizer } from './components/ticket-summarizer.js';
import { loadAuthorizedTicket } from './authorized-ticket.js';
import { TicketAnalysisGraph } from './ticket-analysis.graph.js';
import { AiExecutionError } from './ai-execution-runner.js';
import { validateClassificationEvidenceAgainstTicket } from './contracts.js';
export { TicketAiAnalysisError } from './authorized-ticket.js';

export type AnalyzeTicketInput = {
  tenant: TenantContext;
  ticketId: string;
  categories: TicketClassificationCategory[];
  informationToCollect?: string[];
};

export class TicketAiAnalysisService {
  private readonly workflow: TicketAnalysisGraph;
  constructor(
    private readonly ticketSource: AuthorizedTicketAnalysisSource,
    classifier: TicketClassifier,
    summarizer: TicketSummarizer,
    private readonly repository: AiAnalysisRepository,
  ) { this.workflow = new TicketAnalysisGraph(classifier, summarizer); }

  async analyze(input: AnalyzeTicketInput): Promise<TicketAiAnalysis> {
    const ticket = await this.getAuthorizedTicket(input.tenant, input.ticketId);

    const output = await this.workflow.run({
      ticket,
      categories: input.categories,
      ...(input.informationToCollect === undefined
        ? {}
        : { informationToCollect: input.informationToCollect }),
    });
    await this.repository.saveWorkflowRun?.(input.tenant, { ...output.orchestration, organisationId: ticket.organisationId,
      ticketId: ticket.id, initiatedBy: input.tenant.userId, executions: output.executions, failure: output.failure });
    if (output.failure) throw new AiExecutionError(output.failure.code, 'AI analysis could not produce a valid result.', output.failure.executionId, output.failure.task);
    if (!output.classification || !output.summary) throw new Error('Analysis graph did not produce its required outputs.');

    const analysis: TicketAiAnalysis = {
      id: `analysis_${randomUUID()}`,
      ticketId: ticket.id,
      organisationId: input.tenant.organisationId,
      status: 'completed',
      classification: output.classification,
      summary: output.summary,
      executions: output.executions,
      createdAt: new Date().toISOString(),
      orchestration: output.orchestration,
    };

    await this.repository.save(input.tenant, analysis);
    return analysis;
  }

  async listAnalyses(
    tenant: TenantContext,
    ticketId: string,
  ): Promise<TicketAiAnalysis[]> {
    const ticket = await this.getAuthorizedTicket(tenant, ticketId);
    const analyses = await this.repository.listForTicket(tenant, ticketId);
    for (const analysis of analyses) validateClassificationEvidenceAgainstTicket(analysis.classification, ticket);
    return analyses;
  }

  async listWorkflowRuns(tenant: TenantContext, ticketId: string) {
    await this.getAuthorizedTicket(tenant, ticketId);
    return this.repository.listWorkflowRuns?.(tenant, ticketId) ?? [];
  }

  private async getAuthorizedTicket(
    tenant: TenantContext,
    ticketId: string,
  ) {
    return loadAuthorizedTicket(this.ticketSource, tenant, ticketId);
  }
}
