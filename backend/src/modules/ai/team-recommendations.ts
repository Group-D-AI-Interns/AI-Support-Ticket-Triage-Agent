import type { TenantContext } from '../../shared/tenant.js';
import type { TicketAiView } from './contracts.js';
import type { AuthorizedRoutingSource, VerifiedSlaInsightSource } from './team-capability-ports.js';
import type { SlaEvaluationRecord } from '../sla/domain/sla-evaluation.js';

export type RoutingRecommendation = { status: 'recommendation' | 'insufficient_information' | 'unavailable'; teamId: string | null;
  evidence: Array<{ ruleId: string; version: string }>; warnings: string[]; requiresHumanReview: true };
export async function recommendRouting(tenant: TenantContext, ticket: TicketAiView, category: string | null, source?: AuthorizedRoutingSource): Promise<RoutingRecommendation> {
  const base = { teamId: null, evidence: [], requiresHumanReview: true as const };
  if (!source) return { ...base, status: 'unavailable', warnings: ['ROUTING_SOURCE_NOT_CONNECTED'] };
  if (!category) return { ...base, status: 'insufficient_information', warnings: ['CLASSIFICATION_REQUIRED'] };
  const context = await source.getAuthorizedRoutingContext(tenant, structuredClone(ticket));
  if (!context) return { ...base, status: 'unavailable', warnings: ['NO_PERMITTED_ROUTING_CONTEXT'] };
  if (context.organisationId !== tenant.organisationId || ticket.organisationId !== tenant.organisationId) throw new Error('Routing source tenant mismatch.');
  const eligible = new Set(context.eligibleTeams.filter(team => team.organisationId === tenant.organisationId && team.id.trim() && team.name.trim()).map(team => team.id));
  const now = Date.now();
  const rules = context.rules.filter(rule => rule.organisationId === tenant.organisationId && rule.approved === true &&
    rule.id.trim() && rule.version.trim() && eligible.has(rule.teamId) && rule.categoryIds.includes(category) &&
    Number.isFinite(Date.parse(rule.effectiveFrom)) && Date.parse(rule.effectiveFrom) <= now &&
    (rule.effectiveTo === null || (Number.isFinite(Date.parse(rule.effectiveTo)) && Date.parse(rule.effectiveTo) > now)));
  if (new Set(rules.map(rule => rule.teamId)).size !== 1) return { ...base, status: 'insufficient_information', warnings: ['NO_UNAMBIGUOUS_APPROVED_ROUTING_RULE'] };
  return { teamId: rules[0]!.teamId, status: 'recommendation', evidence: rules.map(rule => ({ ruleId: rule.id, version: rule.version })), warnings: [], requiresHumanReview: true };
}

export type SlaInsight = { status: 'available' | 'unavailable' | 'stale'; evaluation: SlaEvaluationRecord | null; warnings: string[]; requiresHumanReview: true };
export async function verifiedSlaInsight(tenant: TenantContext, ticket: TicketAiView, source?: VerifiedSlaInsightSource): Promise<SlaInsight> {
  const base = { evaluation: null, requiresHumanReview: true as const };
  if (!source) return { ...base, status: 'unavailable', warnings: ['SLA_SOURCE_NOT_CONNECTED'] };
  const response = await source.getAuthorizedEvaluation(tenant, structuredClone(ticket));
  if (!response) return { ...base, status: 'unavailable', warnings: ['NO_PERMITTED_VERIFIED_SLA_EVALUATION'] };
  const evaluation = response.evaluation;
  if (ticket.organisationId !== tenant.organisationId || evaluation.organisationId !== tenant.organisationId || evaluation.ticketId !== ticket.id ||
    evaluation.input.organisationId !== tenant.organisationId || evaluation.input.ticketId !== ticket.id ||
    evaluation.result.organisationId !== tenant.organisationId || evaluation.result.ticketId !== ticket.id ||
    evaluation.result.policyId !== evaluation.policyId || evaluation.result.policyVersionId !== evaluation.policyVersionId ||
    evaluation.result.evaluatedAt !== evaluation.evaluatedAt ||
    !evaluation.policyId.trim() || !evaluation.policyVersionId.trim()) throw new Error('SLA evaluation provenance mismatch.');
  if (response.isCurrent !== true || !Number.isFinite(Date.parse(evaluation.evaluatedAt)) || Date.parse(evaluation.evaluatedAt) > Date.now()) {
    return { ...base, status: 'stale', warnings: ['CURRENT_VERIFIED_SLA_EVALUATION_REQUIRED'] };
  }
  for (const metric of [evaluation.result.metrics.firstResponse, evaluation.result.metrics.resolution]) {
    if (!['on_track', 'at_risk', 'breached', 'met', 'paused'].includes(metric.state) ||
      ![metric.targetMinutes, metric.elapsedMinutes, metric.remainingMinutes].every(Number.isFinite)) throw new Error('Invalid verified SLA metrics.');
  }
  return { status: 'available', evaluation: structuredClone(evaluation), warnings: [], requiresHumanReview: true };
}
