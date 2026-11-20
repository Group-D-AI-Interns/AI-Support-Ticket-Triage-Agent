import type { TenantContext } from '../../shared/tenant.js';
import type { AuthorizedTicketAnalysisSource } from './ports.js';
import type { PriorityRecommender } from './components/priority-recommender.js';
import { TicketAiAnalysisError } from './ticket-ai-analysis.service.js';

/** Caller must supply trusted identity; source enforces ticket/team/ownership access. */
export class PriorityRecommendationService {
  constructor(private readonly source: AuthorizedTicketAnalysisSource, private readonly recommender: PriorityRecommender) {}
  async recommend(tenant: TenantContext, ticketId: string) {
    if (!tenant?.organisationId || !tenant.userId || typeof ticketId !== 'string' || !ticketId.trim()) {
      throw new TicketAiAnalysisError('INVALID_INPUT', 'Trusted tenant and ticket ID are required.');
    }
    const ticket = await this.source.getAuthorizedTicket(tenant, ticketId);
    if (!ticket) throw new TicketAiAnalysisError('TICKET_NOT_FOUND', 'Ticket not found.');
    if (ticket.organisationId !== tenant.organisationId || ticket.id !== ticketId) {
      throw new TicketAiAnalysisError('TICKET_TENANT_MISMATCH', 'Invalid authorised ticket projection.');
    }
    if (typeof ticket.title !== 'string' || !ticket.title.trim() || typeof ticket.description !== 'string') {
      throw new TicketAiAnalysisError('INVALID_TICKET_DATA', 'Invalid AI ticket projection.');
    }
    return this.recommender.recommend(ticket);
  }
}
