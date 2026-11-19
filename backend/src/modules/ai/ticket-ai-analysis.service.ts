import { randomUUID } from 'node:crypto';

import type { TenantContext } from '../../shared/tenant.js';
import type {
  TicketAiAnalysis,
  TicketClassificationCategory,
} from './contracts.js';
import type { AiAnalysisRepository, AuthorizedTicketAnalysisSource } from './ports.js';
import { TicketClassifier } from './components/ticket-classifier.js';
import { TicketSummarizer } from './components/ticket-summarizer.js';

export class TicketAiAnalysisError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TicketAiAnalysisError';
  }
}

export type AnalyzeTicketInput = {
  tenant: TenantContext;
  ticketId: string;
  categories: TicketClassificationCategory[];
  informationToCollect?: string[];
};

export class TicketAiAnalysisService {
  constructor(
    private readonly ticketSource: AuthorizedTicketAnalysisSource,
    private readonly classifier: TicketClassifier,
    private readonly summarizer: TicketSummarizer,
    private readonly repository: AiAnalysisRepository,
  ) {}

  async analyze(input: AnalyzeTicketInput): Promise<TicketAiAnalysis> {
    if (!input.tenant?.organisationId || !input.tenant.userId) {
      throw new TicketAiAnalysisError('INVALID_TENANT_CONTEXT', 'Trusted tenant context is required.');
    }
    if (!input.ticketId.trim()) {
      throw new TicketAiAnalysisError('INVALID_TICKET_ID', 'Ticket ID is required.');
    }

    const ticket = await this.ticketSource.getAuthorizedTicket(input.tenant, input.ticketId);
    if (!ticket) {
      throw new TicketAiAnalysisError('TICKET_NOT_FOUND', 'Ticket not found.');
    }
    if (ticket.organisationId !== input.tenant.organisationId) {
      throw new TicketAiAnalysisError(
        'TICKET_TENANT_MISMATCH',
        'Ticket source returned a ticket outside the trusted tenant.',
      );
    }
    if (
      ticket.id !== input.ticketId
      || !ticket.title.trim()
      || typeof ticket.description !== 'string'
    ) {
      throw new TicketAiAnalysisError(
        'INVALID_TICKET_DATA',
        'Ticket source returned an invalid AI ticket projection.',
      );
    }

    const classification = await this.classifier.classify({
      ticket,
      categories: input.categories,
    });
    const summary = await this.summarizer.summarize({
      ticket,
      informationToCollect: input.informationToCollect,
    });

    const analysis: TicketAiAnalysis = {
      id: `analysis_${randomUUID()}`,
      ticketId: ticket.id,
      organisationId: input.tenant.organisationId,
      status: 'completed',
      classification: classification.result,
      summary: summary.result,
      executions: [classification.execution, summary.execution],
      createdAt: new Date().toISOString(),
    };

    await this.repository.save(input.tenant, analysis);
    return analysis;
  }
}
