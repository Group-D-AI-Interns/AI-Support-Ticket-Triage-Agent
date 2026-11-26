import type { TenantContext } from '../../../shared/tenant.js';
import type { JsonTicketStore } from '../../tickets/repositories/json-ticket.store.js';
import type { SlaEvaluationRepository } from '../../sla/repositories/sla-evaluation.repository.js';
import {
  buildOperationalReport,
  type OperationalReport,
} from '../domain/operational-report.js';

export class OperationalReportingService {
  constructor(
    private readonly tickets: JsonTicketStore,
    private readonly evaluations: SlaEvaluationRepository,
  ) {}

  async getSummary(
    tenant: TenantContext,
    from: string,
    to: string,
    teamIds?: readonly string[],
  ): Promise<OperationalReport> {
    const [tenantTickets, tenantEvaluations] = await Promise.all([
      this.tickets.listTickets(tenant),
      this.evaluations.list(tenant),
    ]);
    const tickets = teamIds === undefined
      ? tenantTickets
      : tenantTickets.filter((ticket) => typeof ticket.teamId === 'string' && teamIds.includes(ticket.teamId));
    const ticketIds = new Set(tickets.map((ticket) => ticket.id));
    const evaluations = teamIds === undefined
      ? tenantEvaluations
      : tenantEvaluations.filter((evaluation) => ticketIds.has(evaluation.ticketId));
    return buildOperationalReport(tickets, evaluations, from, to);
  }
}
