import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeRetriever, type KnowledgeDocument, type AuthorizedKnowledgeSource } from '../src/modules/knowledge/retrieval.js';
import { ApprovedPolicyKnowledgeSource } from '../src/modules/knowledge/approved-policy-source.js';
import { ResolutionRecommendationService } from '../src/modules/ai/resolution-recommendation.service.js';
import { AiExecutionRunner, AiExecutionError } from '../src/modules/ai/ai-execution-runner.js';
import { DeterministicFakeProvider } from '../src/infrastructure/llm/deterministic-fake-provider.js';
import { LlmProviderError } from '../src/infrastructure/llm/structured-generation-provider.js';
import { JsonPolicyRepository } from '../src/modules/policies/repositories/json-policy.repository.js';
import { AiOperationsStore } from '../src/modules/ai/operations-store.js';
import { ResolutionGenerationInProgressError } from '../src/modules/ai/resolution-recommendation.service.js';
import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tenant = { organisationId: 'org-a', userId: 'agent-a', roles: ['support_agent'] };
const ticket = { id: 'ticket-a', organisationId: 'org-a', title: 'Account lockout', description: 'Account locked after password reset.' };
const document: KnowledgeDocument = { id: 'runbook-a', version: 'version-1', organisationId: 'org-a',
  sourceType: 'knowledge_article', title: 'Account lockout runbook', content: 'For account lockout, verify the account owner before requesting an authorised reset.',
  approved: true, status: 'active', effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveTo: null };
function source(documents = [document]): AuthorizedKnowledgeSource {
  return { async listAuthorizedDocuments(context) { assert.deepEqual(context, tenant); return documents; } };
}
function fixture(documents = [document], mode = 'success') {
  let calls = 0;
  const events: unknown[] = [];
  const provider = new DeterministicFakeProvider({ ticket_resolution(input) {
    calls++;
    if (mode === 'failure') throw new LlmProviderError('NETWORK_ERROR', 'secret=not-for-output', false);
    const data = input as { ticket: object; evidence: Array<{ passageId: string; excerpt: string }> };
    assert.deepEqual(Object.keys(data.ticket).sort(), ['description','id','title']);
    const passage = data.evidence[0]!;
    return { summary: 'Review the cited runbook before acting.',
      steps: mode === 'insufficient' ? [] : [{ instruction: 'Verify the account owner before requesting a reset.',
        citations: [{ passageId: mode === 'unknown-source' ? 'invented' : passage.passageId, excerpt: mode === 'invented-quote' ? 'Disable all authentication' : passage.excerpt }] }],
      missingInformation: mode === 'insufficient' ? ['Approved technical resolution steps'] : [], warnings: [] };
  } });
  const runner = new AiExecutionRunner(provider, { async record(event) { events.push(event); } }, { model: 'fixture-model', timeoutMs: 100, maxRetries: 0 });
  const service = new ResolutionRecommendationService({ async getAuthorizedTicket() { return ticket; } }, new KnowledgeRetriever(source(documents)), runner);
  return { service, runner, calls: () => calls, events };
}

test('retrieval rejects cross-tenant, draft, expired, future, unapproved and malformed-date records before ranking', async () => {
  const documents = [document,
    { ...document, id: 'foreign', organisationId: 'org-b' }, { ...document, id: 'draft', status: 'draft' as const },
    { ...document, id: 'unapproved', approved: false }, { ...document, id: 'expired', effectiveTo: '2020-01-01T00:00:00Z' },
    { ...document, id: 'future', effectiveFrom: '2099-01-01T00:00:00Z' }, { ...document, id: 'broken', effectiveTo: 'invalid' }];
  const results = await new KnowledgeRetriever(source(documents)).retrieve(tenant, ticket.title);
  assert.deepEqual(results.map(result => result.sourceId), ['runbook-a']);
});
test('retrieval chunks text with exact offsets, stable version/content IDs, bounds and deterministic ranking', async () => {
  const long = { ...document, content: ('Account lockout guidance. ').repeat(200) };
  const retriever = new KnowledgeRetriever(source([long]));
  const first = await retriever.retrieve(tenant, 'account lockout');
  assert.ok(first.length > 0 && first.length <= 5);
  for (const passage of first) assert.equal(long.content.slice(passage.start, passage.end), passage.excerpt);
  assert.deepEqual(first, await retriever.retrieve(tenant, 'account lockout'));
  const changed = await new KnowledgeRetriever(source([{ ...long, version: 'v2' }])).retrieve(tenant, 'account lockout');
  assert.notEqual(first[0]?.passageId, changed[0]?.passageId);
});
test('historical retrieval excludes current ticket and keeps historical examples distinct from policy', async () => {
  const history: KnowledgeDocument = { ...document, id: 'resolved-ticket', sourceType: 'historical_ticket' };
  const retriever = new KnowledgeRetriever(source([document, history, { ...history, id: ticket.id }]));
  const results = await retriever.retrieve(tenant, 'account lockout', { sourceType: 'historical_ticket', excludeTicketId: ticket.id });
  assert.deepEqual(results.map(result => result.sourceId), ['resolved-ticket']);
  assert.equal(results[0]?.sourceType, 'historical_ticket');
});
test('permission-aware source is invoked before retrieval and may deny all content', async () => {
  let requested = false;
  const retriever = new KnowledgeRetriever({ async listAuthorizedDocuments(context) { requested = true; assert.deepEqual(context, tenant); return []; } });
  assert.deepEqual(await retriever.retrieve(tenant, 'account lockout'), []);
  assert.equal(requested, true);
});
test('resolution uses only permitted citations and leaves the ticket unchanged', async () => {
  const f = fixture(); const before = structuredClone(ticket);
  const result = await f.service.recommend(tenant, ticket.id);
  assert.equal(result.status, 'recommendation');
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.execution?.task, 'ticket_resolution');
  assert.equal(result.steps[0]?.citations[0]?.passageId, result.evidence[0]?.passageId);
  assert.equal(result.evidence[0]?.version, 'version-1');
  assert.equal(result.ticketSnapshotHash.length, 64);
  assert.deepEqual(ticket, before);
});
test('no relevant or permitted evidence skips the provider instead of inventing a resolution', async () => {
  for (const documents of [[], [{ ...document, content: 'Printer toner replacement procedure.' }], [{ ...document, approved: false }]]) {
    const f = fixture(documents); const result = await f.service.recommend(tenant, ticket.id);
    assert.equal(result.status, 'insufficient_evidence');
    assert.deepEqual(result.steps, []); assert.equal(result.execution, null); assert.equal(f.calls(), 0);
  }
});
test('unknown citations and invented quotes are rejected by existing runner validation', async () => {
  for (const mode of ['unknown-source','invented-quote']) {
    const f = fixture([document], mode);
    await assert.rejects(f.service.recommend(tenant, ticket.id), (error: unknown) => error instanceof AiExecutionError && error.code === 'INVALID_OUTPUT');
  }
});
test('irrelevant guidance may be declined even when passages were retrieved', async () => {
  const result = await fixture([document], 'insufficient').service.recommend(tenant, ticket.id);
  assert.equal(result.status, 'insufficient_evidence'); assert.deepEqual(result.steps, []);
});
test('unauthorised or cross-tenant ticket projections fail before retrieval/provider', async () => {
  const f = fixture(); let retrieved = false;
  for (const value of [null, { ...ticket, organisationId: 'org-b' }]) {
    const service = new ResolutionRecommendationService({ async getAuthorizedTicket() { return value; } }, new KnowledgeRetriever({ async listAuthorizedDocuments() { retrieved = true; return [document]; } }), f.runner);
    await assert.rejects(service.recommend(tenant, ticket.id));
    assert.equal(retrieved, false); assert.equal(f.calls(), 0);
  }
});
test('provider failures preserve safe runner errors and do not log ticket/evidence text', async () => {
  const f = fixture([document], 'failure');
  await assert.rejects(f.service.recommend(tenant, ticket.id), (error: unknown) => error instanceof AiExecutionError && !error.message.includes('secret'));
  assert.equal(JSON.stringify(f.events).includes(document.content), false);
});

test('recommendation is stored, reused across service restart, and regenerated as a new history row only on request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resolution-cache-'));
  try {
    const operations = new AiOperationsStore(new (await import('../src/infrastructure/persistence/json/json-file-store.js')).JsonFileStore(root));
    const f = fixture();
    const sourceAdapter = { async getAuthorizedTicket() { return ticket; } };
    const firstService = new ResolutionRecommendationService(sourceAdapter, new KnowledgeRetriever(source()), f.runner, operations);
    const first = await firstService.recommend(tenant, ticket.id);
    assert.equal(first.cacheHit, false);
    assert.equal(first.recommendationVersion, 1);
    assert.equal(f.calls(), 1);

    const second = await firstService.recommend(tenant, ticket.id);
    assert.equal(second.cacheHit, true);
    assert.equal(second.execution?.executionId, first.execution?.executionId);
    assert.equal(f.calls(), 1);

    const restarted = new ResolutionRecommendationService(sourceAdapter, new KnowledgeRetriever(source()), f.runner,
      new AiOperationsStore(new (await import('../src/infrastructure/persistence/json/json-file-store.js')).JsonFileStore(root)));
    assert.equal((await restarted.recommend(tenant, ticket.id)).cacheHit, true);
    assert.equal(f.calls(), 1);

    const regenerated = await restarted.recommend(tenant, ticket.id, { regenerate: true, reason: 'Reviewer requested a fresh recommendation.' });
    assert.equal(regenerated.cacheHit, false);
    assert.equal(regenerated.recommendationVersion, 2);
    assert.equal(f.calls(), 2);
    const history = (await operations.list(tenant.organisationId, 'resolution_recommendation')).filter(row => row.data.ticketId === ticket.id);
    assert.equal(history.length, 2);
    assert.ok(history.every(row => row.data.status === 'completed'));
    assert.equal(history[1]?.data.regenerationReason, 'Reviewer requested a fresh recommendation.');
    assert.equal((await operations.list('other-org', 'resolution_recommendation')).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent opens share one in-flight generation and invalid failed cache rows are not reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resolution-cache-concurrent-'));
  try {
    const { JsonFileStore } = await import('../src/infrastructure/persistence/json/json-file-store.js');
    const operations = new AiOperationsStore(new JsonFileStore(root));
    let calls = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = new DeterministicFakeProvider({ async ticket_resolution(input) {
      calls++; await gate;
      const passage = (input as { evidence: Array<{ passageId: string; excerpt: string }> }).evidence[0]!;
      return { summary: 'Review the runbook.', steps: [{ instruction: 'Verify account ownership.', citations: [{ passageId: passage.passageId, excerpt: passage.excerpt }] }], missingInformation: [], warnings: [] };
    } });
    const runner = new AiExecutionRunner(provider, { async record() {} }, { model: 'fixture-model', timeoutMs: 1000, maxRetries: 0 });
    const service = new ResolutionRecommendationService({ async getAuthorizedTicket() { return ticket; } }, new KnowledgeRetriever(source()), runner, operations);
    const first = service.recommend(tenant, ticket.id);
    await new Promise(resolve => setTimeout(resolve, 15));
    await assert.rejects(service.recommend(tenant, ticket.id), ResolutionGenerationInProgressError);
    assert.equal(calls, 1);
    release(); await first;
    const completed = (await operations.list(tenant.organisationId, 'resolution_recommendation'))[0]!;
    await operations.changeForOrganisation(tenant.organisationId, rows => {
      const row = rows.find(item => item.id === completed.id)!;
      if (row.kind === 'resolution_recommendation') { row.data.status = 'failed'; row.data.result = null; row.data.leaseUntil = null; }
    });
    const retried = await service.recommend(tenant, ticket.id);
    assert.equal(retried.cacheHit, false);
    assert.equal(calls, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('default policy source requires actual approval and current administrator visibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'policy-retrieval-'));
  try {
    const store = createJsonTenantStore(root); const repo = new JsonPolicyRepository(store);
    const admin = { ...tenant, roles: ['organisation_admin'] };
    const now = new Date().toISOString();
    await repo.createPolicy({ id: 'policy', organisationId: tenant.organisationId, policyType: 'resolution', description: 'Account lockout', ownerId: tenant.userId, status: 'draft', version: 1, createdAt: now, updatedAt: now }, admin);
    await repo.createVersion('policy', { id: 'version', organisationId: tenant.organisationId, policyId: 'policy', version: 1, status: 'pending_approval', effectiveFrom: '2020-01-01T00:00:00Z', effectiveTo: null, payload: { steps: ['Verify account owner before reset.'] }, createdAt: now, updatedAt: now }, admin);
    const knowledge = new ApprovedPolicyKnowledgeSource(repo, store);
    assert.deepEqual(await knowledge.listAuthorizedDocuments(admin), []);
    await repo.addApproval({ id: 'approval', organisationId: tenant.organisationId, policyVersionId: 'version', reviewerId: tenant.userId, decision: 'approved', reason: 'Synthetic test approval', createdAt: now }, admin);
    await repo.activateVersion(admin, 'policy', 'version');
    assert.equal((await knowledge.listAuthorizedDocuments(admin)).length, 1);
    assert.deepEqual(await knowledge.listAuthorizedDocuments(tenant), []);
    assert.deepEqual(await knowledge.listAuthorizedDocuments({ ...admin, organisationId: 'org-b' }), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
