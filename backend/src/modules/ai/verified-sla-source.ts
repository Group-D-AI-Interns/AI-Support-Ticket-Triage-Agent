import type { TenantContext } from '../../shared/tenant.js';
import type { TicketAiView } from './contracts.js';
import type { VerifiedSlaInsightSource } from './team-capability-ports.js';
import type { TicketRecord } from '../tickets/domain/ticket.js';
import type { SlaEvaluationService } from '../sla/services/sla-evaluation.service.js';
import { ticketSnapshotHash } from './ticket-analysis.graph.js';

export type AuthorizedSlaTicketState = {
  ticket: TicketAiView;
  revision: string;
  domain: Pick<TicketRecord, 'priority' | 'createdAt' | 'teamId'>;
};

/** Reuses Faith's deterministic service and the existing SLA API permission boundary. */
export class FreshVerifiedSlaSource implements VerifiedSlaInsightSource {
  constructor(
    private readonly service: Pick<SlaEvaluationService, 'evaluateTicket' | 'resolvePolicyForTicket'>,
    private readonly readAuthorizedState: (tenant: TenantContext, ticketId: string) => Promise<AuthorizedSlaTicketState | null>,
    private readonly canEvaluate: (tenant: TenantContext) => boolean,
  ) {}

  async getAuthorizedEvaluation(tenant: TenantContext, ticket: TicketAiView) {
    if (!this.canEvaluate(tenant) || ticket.organisationId !== tenant.organisationId) return null;
    const initial = await this.readAuthorizedState(tenant, ticket.id);
    const before = initial ? structuredClone(initial) : null;
    if (!before || ticketSnapshotHash(before.ticket) !== ticketSnapshotHash(ticket)) return null;
    const evaluation = await this.service.evaluateTicket(tenant, ticket.id);
    if (!evaluation) return null; // Missing actual priority or applicable approved/effective policy.
    const after = await this.readAuthorizedState(tenant, ticket.id);
    if (!after) return null; // Access was lost: do not expose even stale results.
    if (after.revision !== before.revision || ticketSnapshotHash(after.ticket) !== ticketSnapshotHash(ticket)) {
      return { evaluation, isCurrent: false };
    }
    const policy = await this.service.resolvePolicyForTicket(tenant, after.domain);
    return { evaluation, isCurrent: policy !== null && policy.id === evaluation.policyId && policy.versionId === evaluation.policyVersionId };
  }
}
