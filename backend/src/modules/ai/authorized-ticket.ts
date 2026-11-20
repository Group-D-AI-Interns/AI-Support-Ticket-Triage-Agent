import type { TenantContext } from '../../shared/tenant.js';
import type { AuthorizedTicketAnalysisSource } from './ports.js';
import type { TicketAiView } from './contracts.js';

export class TicketAiAnalysisError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'TicketAiAnalysisError'; }
}

/** The source owns caller/team authorization. Validate and detach its narrow projection. */
export async function loadAuthorizedTicket(source: AuthorizedTicketAnalysisSource, tenant: TenantContext, ticketId: string): Promise<TicketAiView> {
  if (!tenant?.organisationId || !tenant.userId) throw new TicketAiAnalysisError('INVALID_TENANT_CONTEXT', 'Trusted tenant context is required.');
  if (typeof ticketId !== 'string' || !ticketId.trim()) throw new TicketAiAnalysisError('INVALID_TICKET_ID', 'Ticket ID is required.');
  const ticket = await source.getAuthorizedTicket(tenant, ticketId);
  if (!ticket) throw new TicketAiAnalysisError('TICKET_NOT_FOUND', 'Ticket not found.');
  if (ticket.organisationId !== tenant.organisationId) throw new TicketAiAnalysisError('TICKET_TENANT_MISMATCH', 'Ticket source returned a ticket outside the trusted tenant.');
  if (ticket.id !== ticketId || typeof ticket.title !== 'string' || !ticket.title.trim() || typeof ticket.description !== 'string') {
    throw new TicketAiAnalysisError('INVALID_TICKET_DATA', 'Ticket source returned an invalid AI ticket projection.');
  }
  return { id: ticket.id, organisationId: ticket.organisationId, title: ticket.title, description: ticket.description };
}
