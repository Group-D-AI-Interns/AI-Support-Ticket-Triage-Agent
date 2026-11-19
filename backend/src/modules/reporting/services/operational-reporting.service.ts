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
  ): Promise<OperationalReport> {
    const [tickets, evaluations] = await Promise.all([
      this.tickets.listTickets(tenant),
      this.evaluations.list(tenant),
    ]);
    return buildOperationalReport(tickets, evaluations, from, to);
  }
}
