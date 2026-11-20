import type { TenantContext } from '../../shared/tenant.js';
import type { TicketAiView } from './contracts.js';
import type { SlaEvaluationRecord } from '../sla/domain/sla-evaluation.js';

/** AI-side integration ports. Teammates implement adapters; these do not grant permissions. */
export type AuthorizedRoutingContext = {
  organisationId: string;
  eligibleTeams: Array<{ id: string; organisationId: string; name: string }>;
  rules: Array<{ id: string; version: string; organisationId: string; categoryIds: string[]; teamId: string;
    approved: boolean; effectiveFrom: string; effectiveTo: string | null }>;
};
export interface AuthorizedRoutingSource {
  /** Must apply caller visibility, eligible-team restrictions and governance before returning rules. */
  getAuthorizedRoutingContext(tenant: TenantContext, ticket: TicketAiView): Promise<AuthorizedRoutingContext | null>;
}
export interface VerifiedSlaInsightSource {
  /** Faith's adapter must verify policy/input freshness and caller access; no LLM recomputation. */
  getAuthorizedEvaluation(tenant: TenantContext, ticket: TicketAiView): Promise<{ evaluation: SlaEvaluationRecord; isCurrent: boolean } | null>;
}
