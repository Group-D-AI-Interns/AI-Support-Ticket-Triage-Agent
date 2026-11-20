import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendRouting, verifiedSlaInsight } from '../src/modules/ai/team-recommendations.js';
import type { AuthorizedRoutingContext } from '../src/modules/ai/team-capability-ports.js';
import type { SlaEvaluationRecord } from '../src/modules/sla/domain/sla-evaluation.js';
import { createLocalDemoTicketAiRuntime } from '../src/modules/ai/local-demo-runtime.js';

const tenant = { organisationId: 'org-a', userId: 'agent', roles: ['support_agent'] };
const ticket = { id: 'ticket-a', organisationId: 'org-a', title: 'Account access locked', description: 'Account locked after reset.' };
const context: AuthorizedRoutingContext = { organisationId: tenant.organisationId,
  eligibleTeams: [{ id: 'team-access', organisationId: tenant.organisationId, name: 'Account support' }],
  rules: [{ id: 'rule-a', version: 'v1', organisationId: tenant.organisationId, categoryIds: ['ACCESS'], teamId: 'team-access', approved: true, effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveTo: null }] };
const metric = { targetMinutes: 120, elapsedMinutes: 30, remainingMinutes: 90, deadlineAt: '2026-01-01T02:00:00.000Z', completedAt: null, state: 'on_track' as const, explanation: 'Synthetic verified engine output.' };
const evaluation: SlaEvaluationRecord = { id: 'evaluation-a', organisationId: tenant.organisationId, ticketId: ticket.id, policyId: 'policy-a', policyVersionId: 'version-a', evaluatedAt: '2026-01-01T00:30:00.000Z',
  input: { ticketId: ticket.id, organisationId: tenant.organisationId, priority: 'high', createdAt: '2026-01-01T00:00:00.000Z', now: '2026-01-01T00:30:00.000Z' },
  result: { ticketId: ticket.id, organisationId: tenant.organisationId, policyId: 'policy-a', policyVersionId: 'version-a', policyVersion: 1, evaluatedAt: '2026-01-01T00:30:00.000Z', metrics: { firstResponse: metric, resolution: metric } } };

test('routing uses only one unambiguous approved rule and permitted team; never assigns it', async () => {
  const before = structuredClone(ticket);
  const result = await recommendRouting(tenant, ticket, 'ACCESS', { async getAuthorizedRoutingContext() { return context; } });
  assert.equal(result.teamId, 'team-access');
  assert.equal(result.status, 'recommendation');
  assert.equal(result.requiresHumanReview, true);
  assert.deepEqual(result.evidence, [{ ruleId: 'rule-a', version: 'v1' }]);
  assert.deepEqual(ticket, before);
  for (const rule of [
    { ...context.rules[0]!, approved: false }, { ...context.rules[0]!, organisationId: 'foreign' },
    { ...context.rules[0]!, effectiveTo: '2020-01-01T00:00:00Z' }, { ...context.rules[0]!, teamId: 'unpermitted-team' },
  ]) assert.equal((await recommendRouting(tenant, ticket, 'ACCESS', { async getAuthorizedRoutingContext() { return { ...context, rules: [rule] }; } })).teamId, null);
});

test('routing reports absent/ambiguous data honestly and rejects foreign tenant context', async () => {
  assert.equal((await recommendRouting(tenant, ticket, 'ACCESS')).status, 'unavailable');
  const competing = { ...context, eligibleTeams: [...context.eligibleTeams, { id: 'team-other', name: 'Other', organisationId: tenant.organisationId }],
    rules: [...context.rules, { ...context.rules[0]!, id: 'competing-rule', teamId: 'team-other' }] };
  assert.equal((await recommendRouting(tenant, ticket, 'ACCESS', { async getAuthorizedRoutingContext() { return competing; } })).status, 'insufficient_information');
  await assert.rejects(recommendRouting(tenant, ticket, 'ACCESS', { async getAuthorizedRoutingContext() { return { ...context, organisationId: 'foreign' }; } }));
});

test('SLA insight passes through verified engine results without calculating deadlines', async () => {
  const result = await verifiedSlaInsight(tenant, ticket, { async getAuthorizedEvaluation() { return { evaluation, isCurrent: true }; } });
  assert.equal(result.status, 'available');
  assert.deepEqual(result.evaluation, evaluation);
  assert.notEqual(result.evaluation, evaluation);
  assert.equal((await verifiedSlaInsight(tenant, ticket)).status, 'unavailable');
  assert.equal((await verifiedSlaInsight(tenant, ticket, { async getAuthorizedEvaluation() { return { evaluation, isCurrent: false }; } })).status, 'stale');
  await assert.rejects(verifiedSlaInsight(tenant, ticket, { async getAuthorizedEvaluation() { return { evaluation: { ...evaluation, organisationId: 'foreign' }, isCurrent: true }; } }));
});

test('AI triage reads teammate updates each run, freezes a ticket snapshot and does not depend on Keycloak setup', async () => {
  let currentTicket = { ...ticket };
  let version = 'v1';
  let routingCalls = 0;
  const runtime = createLocalDemoTicketAiRuntime({ async getAuthorizedTicket(caller) { assert.deepEqual(caller, tenant); return currentTicket; } });
  const service = runtime.createTriageService({
    knowledge: { async listAuthorizedDocuments(caller) { assert.deepEqual(caller, tenant); return [{ id: 'article-a', version, organisationId: tenant.organisationId, sourceType: 'knowledge_article',
      title: 'Account access', content: 'Account locked: consult approved account support guidance.', approved: true, status: 'active', effectiveFrom: '2020-01-01T00:00:00Z', effectiveTo: null }]; } },
    routing: { async getAuthorizedRoutingContext() { routingCalls++; return { ...context, rules: [{ ...context.rules[0]!, version }] }; } },
    sla: { async getAuthorizedEvaluation() { return { evaluation, isCurrent: true }; } },
  });
  const first = await service.analyze({ tenant, ticketId: ticket.id, categories: [{ id: 'ACCESS', name: 'Account access' }] });
  assert.equal(first.priority.status, 'unavailable');
  assert.equal(first.core.orchestration?.engine, 'langgraph');
  assert.equal(first.routing.status, 'completed');
  if (first.routing.status === 'completed') assert.equal(first.routing.data.evidence[0]?.version, 'v1');
  assert.equal(first.evidence.status, 'completed');
  version = 'v2';
  currentTicket = { ...ticket, description: 'Updated account access request from Fhulu.' };
  const second = await service.analyze({ tenant, ticketId: ticket.id, categories: [{ id: 'ACCESS', name: 'Account access' }] });
  assert.equal(routingCalls, 2);
  if (second.evidence.status === 'completed') assert.ok(second.evidence.data.every(passage => passage.version === 'v2'));
  if (second.routing.status === 'completed') assert.equal(second.routing.data.evidence[0]?.version, 'v2');
  assert.notEqual(first.core.orchestration?.snapshotHash, second.core.orchestration?.snapshotHash);
  assert.equal(second.sla.status, 'completed');
});

test('missing/failed teammate services do not corrupt successful core AI analysis or expose remote errors', async () => {
  const runtime = createLocalDemoTicketAiRuntime({ async getAuthorizedTicket() { return ticket; } });
  const service = runtime.createTriageService({ knowledge: { async listAuthorizedDocuments() { throw new Error('secret-upstream-credentials'); } } });
  const result = await service.analyze({ tenant, ticketId: ticket.id, categories: [{ id: 'ACCESS', name: 'Account access' }] });
  assert.equal(result.core.status, 'completed');
  assert.equal(result.evidence.status, 'failed');
  assert.equal(result.resolution.status, 'failed');
  assert.equal(JSON.stringify(result).includes('secret-upstream-credentials'), false);
  assert.equal(result.routing.status === 'completed' && result.routing.data.status, 'unavailable');
});
