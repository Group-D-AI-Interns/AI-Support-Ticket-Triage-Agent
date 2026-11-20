import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createIntegratedApp } from '../src/integrated-app.js';
import { loadEnvironment } from '../src/config/env.js';
import { KeycloakAuthenticationProvider } from '../src/infrastructure/auth/keycloak-authentication.js';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';
import { JsonTicketStore } from '../src/modules/tickets/repositories/json-ticket.store.js';
import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { JsonDocumentRepository } from '../src/modules/documents/repositories/json-document.repository.js';
import { AiExecutionRunner } from '../src/modules/ai/ai-execution-runner.js';
import { DeterministicFakeProvider } from '../src/infrastructure/llm/deterministic-fake-provider.js';
import type { PriorityPreviewConfiguration } from '../src/modules/ai/priority-preview-config.js';
import { priorityPreviewFromEnvironment } from '../src/modules/ai/priority-preview-config.js';
import type { StructuredGenerationProvider } from '../src/infrastructure/llm/structured-generation-provider.js';
import type { AuthorizedKnowledgeSource } from '../src/modules/knowledge/retrieval.js';
import type { TicketAppOptions } from '../src/modules/tickets/api.js';
import { ProviderDocumentExtractionAdapter } from '../src/modules/ai/provider-document-extraction.adapter.js';
import { documentExtractionSchemas } from '../src/modules/ai/document-extraction-schemas.js';

function documentAiAdapters(invalidFirst = false) {
  let calls = 0;
  const runner = new AiExecutionRunner(new DeterministicFakeProvider({ document_rule_extraction(input) {
    calls++;
    const text = (input as { document: { content: string } }).document.content;
    return { rules: [{ ruleType: 'document_clause', payload: { text }, excerpt: invalidFirst && calls === 1 ? 'Invented source quote' : text,
      confidence: 0.9, ambiguity: false }], warnings: [] };
  } }), { async record() {} }, { model: 'document-fixture', timeoutMs: 100, maxRetries: 0 });
  const resolutionRunner = new AiExecutionRunner(new DeterministicFakeProvider({ ticket_resolution(input) {
    const passage = (input as { evidence: Array<{ passageId: string; excerpt: string }> }).evidence[0]!;
    return { summary: 'Use approved account lockout guidance.', steps: [{ instruction: 'Follow the approved account lockout procedure.',
      citations: [{ passageId: passage.passageId, excerpt: passage.excerpt }] }], missingInformation: [], warnings: [] };
  } }), { async record() {} }, { model: 'resolution-fixture', timeoutMs: 100, maxRetries: 0 });
  return { documentExtractionAdapter: new ProviderDocumentExtractionAdapter(runner, documentExtractionSchemas), resolutionRunner, calls: () => calls };
}

async function uploadKnowledge(f: Awaited<ReturnType<typeof fixture>>, text = 'For account lockout, verify the account owner and request an authorized reset.') {
  const body = new FormData();
  body.append('title', 'Approved account access runbook');
  body.append('file', new Blob([text], { type: 'text/plain' }), 'account-runbook.txt');
  const response = await f.request('/api/v1/documents', 'admin', { method: 'POST', body });
  assert.equal(response.status, 201);
  return (await response.json()).data;
}

async function fixture(priorityPreview: PriorityPreviewConfiguration | null = null,
  resolution: Pick<TicketAppOptions, 'knowledgeSource' | 'resolutionRunner' | 'documentExtractionAdapter' | 'routingSource' | 'slaInsightSource' | 'aiAutomation'> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'integrated-triage-'));
  const store = new JsonFileStore(root);
  const now = new Date().toISOString();
  const dates = { createdAt: now, updatedAt: now };
  await store.write('organisations.json', { schemaVersion: 1, records: ['org-a', 'org-b'].map((id) => ({ id, name: id, status: 'active', settings: {}, ...dates })) });
  await store.write('users.json', { schemaVersion: 1, records: ['admin', 'requester', 'other', 'agent', 'lead'].map((id) => ({ id, email: `${id}@example.test`, displayName: id, status: 'active', ...dates })) });
  await store.write('memberships.json', { schemaVersion: 1, records: [
    { id: 'm-admin', organisationId: 'org-a', userId: 'admin', roles: ['organisation_admin'], status: 'active', ...dates },
    { id: 'm-requester', organisationId: 'org-a', userId: 'requester', roles: ['requester'], status: 'active', ...dates },
    { id: 'm-agent', organisationId: 'org-a', userId: 'agent', roles: ['support_agent'], status: 'active', ...dates },
    { id: 'm-lead', organisationId: 'org-a', userId: 'lead', roles: ['support_lead'], status: 'active', ...dates },
    { id: 'm-other', organisationId: 'org-b', userId: 'other', roles: ['organisation_admin'], status: 'active', ...dates },
  ] });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://identity.example.test/realms/support';
  const authenticator = new KeycloakAuthenticationProvider({
    issuer, audience: 'support-api', jwksUri: `${issuer}/certs`,
    fetcher: async () => Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'integration', alg: 'RS256', use: 'sig' }] }),
  });
  function token(userId: string) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'integration' })).toString('base64url');
    // Forged role/team claims must never override server-side membership.
    const body = Buffer.from(JSON.stringify({ iss: issuer, aud: 'support-api', typ: 'Bearer', sub: userId, roles: ['organisation_admin'], teamIds: ['forged-team'], exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
    const input = `${header}.${body}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  }
  let server = createServer();
  function createServer() {
    return createIntegratedApp(loadEnvironment({ DATA_DIRECTORY: root, LOG_LEVEL: 'error', PORT: '0' }), { authenticator }, {
      priorityPreview,
      ...resolution,
      settings: { dataDirectory: root, projectMappings: { SUP: 'org-a' }, organisations: {
        'org-a': { webhookSecret: 'integration-webhook-secret-at-least-32-characters', reporterMappings: { 'jira-requester': 'requester' } },
      } },
      ticketAiDemo: { categories: [{ id: 'ACCESS', name: 'Account access' }] }, ticketAiLive: null,
    });
  }
  async function listen() {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  }
  async function closeServer() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  await listen();
  return {
    root, store,
    async request(path: string, user = 'admin', init: RequestInit = {}, organisationId = user === 'other' ? 'org-b' : 'org-a') {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token(user)}`);
      headers.set('x-organisation-id', organisationId);
      if (typeof init.body === 'string') headers.set('content-type', 'application/json');
      return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
    },
    async restart() { await closeServer(); server = createServer(); await listen(); },
    async close() { await closeServer(); await rm(root, { recursive: true, force: true }); },
  };
}

test('document AI extraction, human review, controlled publication and full ticket triage work on one API', async () => {
  const adapters = documentAiAdapters();
  const priority = await priorityConfiguration();
  const f = await fixture(priority.config, adapters);
  try {
    const source = await uploadKnowledge(f);
    const documentId = source.document.id;
    const extracted = await f.request(`/api/v1/documents/${documentId}/extract-rules`, 'admin', { method: 'POST', body: '{}' });
    assert.equal(extracted.status, 200, JSON.stringify(await extracted.clone().json()));
    const data = (await extracted.json()).data;
    assert.equal(data.job.status, 'succeeded');
    assert.equal(data.job.executionMetadata.provider, 'deterministic-fake');
    assert.equal(data.rules.length, 1);
    assert.equal(data.rules[0].reviewStatus, 'pending_review');
    assert.equal(data.rules[0].requiresHumanReview, true);
    const cached = await f.request(`/api/v1/documents/${documentId}/extract-rules`, 'admin', { method: 'POST', body: '{}' });
    assert.equal((await cached.json()).data.job.id, data.job.id);
    assert.equal(adapters.calls(), 1);
    const detail = await f.request(`/api/v1/documents/${documentId}`);
    assert.equal((await detail.json()).data.extraction.result.executionMetadata.provider, 'deterministic-fake');
    assert.equal((await f.request('/api/v1/extracted-rules')).status, 200);
    const publication = { ruleIds: [data.rules[0].id], reason: 'Checked the original runbook and approved this guidance.', effectiveFrom: '2020-01-01T00:00:00.000Z', visibility: 'administrators' };
    const unreviewed = await f.request(`/api/v1/documents/${documentId}/publish-knowledge`, 'admin', { method: 'POST', body: JSON.stringify(publication) });
    assert.equal(unreviewed.status, 409);
    const approved = await f.request(`/api/v1/extracted-rules/${data.rules[0].id}/approve`, 'admin', { method: 'POST', body: '{"reason":"Verified the quoted procedure"}' });
    assert.equal(approved.status, 200);
    const governanceStore = createJsonTenantStore(f.root);
    const reviewRecords = await governanceStore.readCollection<{ id: string }>('policyApprovals');
    await governanceStore.writeCollection('policyApprovals', []);
    assert.equal((await f.request(`/api/v1/documents/${documentId}/publish-knowledge`, 'admin', { method: 'POST', body: JSON.stringify(publication) })).status, 409);
    await governanceStore.writeCollection('policyApprovals', reviewRecords);
    const published = await f.request(`/api/v1/documents/${documentId}/publish-knowledge`, 'admin', { method: 'POST', body: JSON.stringify(publication) });
    assert.equal(published.status, 200, JSON.stringify(await published.clone().json()));
    const active = (await published.json()).data;
    assert.equal(active.status, 'active');
    assert.equal(active.payload.visibility, 'administrators');
    const repeated = await f.request(`/api/v1/documents/${documentId}/publish-knowledge`, 'admin', { method: 'POST', body: JSON.stringify(publication) });
    assert.equal((await repeated.json()).data.id, active.id);
    const team = (await (await f.request('/api/v1/teams', 'admin', { method: 'POST', body: '{"name":"Account support"}' })).json()).data;
    await f.request(`/api/v1/teams/${team.id}/members`, 'admin', { method: 'PUT', body: '{"userId":"agent","role":"support_agent","status":"active"}' });
    const ticket = await new JsonTicketStore(f.root).createTicket({ organisationId: 'org-a', requesterId: 'requester', title: 'Account access lockout', description: 'Account locked after reset.', teamId: team.id },
      { organisationId: 'org-a', userId: 'requester', roles: ['requester'] });
    const path = `/api/v1/tickets/${ticket.id}`;
    assert.equal((await (await f.request(`${path}/evidence`, 'agent')).json()).data.length, 0);
    const shared = await f.request(`/api/v1/documents/${documentId}/publish-knowledge`, 'admin', { method: 'POST', body: JSON.stringify({ ...publication, visibility: 'support_staff', effectiveFrom: '2021-01-01T00:00:00.000Z' }) });
    assert.equal(shared.status, 200);
    const ticketBefore = await readFile(join(f.root, 'tickets.json'), 'utf8');
    const triaged = await f.request(`${path}/triage`, 'agent', { method: 'POST', body: '{}' });
    assert.equal(triaged.status, 200, JSON.stringify(await triaged.clone().json()));
    const triage = (await triaged.json()).data;
    assert.equal(triage.core.orchestration.engine, 'langgraph');
    assert.equal(triage.priority.data.priority, 'P1');
    assert.ok(triage.evidence.data.length > 0);
    assert.ok(triage.evidence.data.every((passage: { sourceType: string }) => passage.sourceType === 'knowledge_article'));
    assert.equal(triage.resolution.data.status, 'recommendation');
    assert.equal(triage.requiresHumanReview, true);
    assert.equal(await readFile(join(f.root, 'tickets.json'), 'utf8'), ticketBefore);
    assert.equal((await f.request(`/api/v1/documents/${documentId}`, 'agent')).status, 403);
    assert.equal((await f.request('/api/v1/extracted-rules', 'agent')).status, 403);
    assert.equal((await (await f.request(`${path}/ai-runs`, 'agent')).json()).data.length, 1);
    await f.restart();
    assert.equal((await (await f.request(`${path}/ai-runs`, 'agent')).json()).data.length, 1);
    const withdrawn = await f.request(`/api/v1/documents/${documentId}/publish-knowledge`, 'admin', { method: 'POST', body: JSON.stringify({ ...publication, effectiveFrom: '2022-01-01T00:00:00.000Z' }) });
    assert.equal(withdrawn.status, 200);
    assert.equal((await (await f.request(`${path}/evidence`, 'agent')).json()).data.length, 0);
    const oldHistory = (await (await f.request(`${path}/triages`, 'agent')).json()).data;
    assert.equal(oldHistory[0].redacted, true);
    assert.equal(oldHistory[0].data, undefined);
    for (const user of ['requester', 'other']) {
      assert.equal((await f.request(`${path}/triage`, user, { method: 'POST', body: '{}' })).status, user === 'requester' ? 403 : 404);
      assert.equal((await f.request(`${path}/ai-runs`, user)).status, user === 'requester' ? 403 : 404);
    }
    assert.equal((await f.request(`${path}/triage`, 'admin', { method: 'POST', body: '{"roles":["organisation_admin"]}' })).status, 400);
  } finally { await f.close(); }
});

test('document extraction denies requester/foreign access and permits an explicit retry after safe provider failure', async () => {
  const adapters = documentAiAdapters(true);
  const f = await fixture(null, adapters);
  try {
    const source = await uploadKnowledge(f);
    const path = `/api/v1/documents/${source.document.id}`;
    assert.equal((await f.request(`${path}/extract-rules`, 'requester', { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await f.request(`${path}/extract-rules`, 'other', { method: 'POST', body: '{}' })).status, 404);
    assert.equal(adapters.calls(), 0);
    const failed = await f.request(`${path}/extract-rules`, 'admin', { method: 'POST', body: '{}' });
    assert.equal(failed.status, 502);
    const history = (await (await f.request(`${path}/extractions`)).json()).data;
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'failed');
    assert.equal((await (await f.request('/api/v1/extracted-rules')).json()).data.length, 0);
    assert.equal((await f.request(`${path}/extract-rules`, 'admin', { method: 'POST', body: '{}' })).status, 502);
    assert.equal(adapters.calls(), 1);
    const retried = await f.request(`${path}/extract-rules`, 'admin', { method: 'POST', body: '{"retry":true}' });
    assert.equal(retried.status, 200);
    assert.equal(adapters.calls(), 2);
    assert.equal((await (await f.request(`${path}/extractions`)).json()).data.length, 2);
    const rule = (await retried.json()).data.rules[0];
    const rejected = await f.request(`/api/v1/extracted-rules/${rule.id}/reject`, 'admin', { method: 'POST', body: '{"reason":"Not suitable for publication"}' });
    assert.equal(rejected.status, 200);
    assert.equal((await f.request(`${path}/publish-knowledge`, 'admin', { method: 'POST', body: JSON.stringify({ ruleIds: [rule.id], reason: 'Try rejected rule', visibility: 'support_staff', effectiveFrom: '2020-01-01T00:00:00Z' }) })).status, 409);
    assert.equal((await f.request(`${path}/extract-rules`, 'admin', { method: 'POST', body: '{"schema":{}}' })).status, 400);
  } finally { await f.close(); }
});

test('parallel document requests process their own jobs and retain both human review records', async () => {
  const adapters = documentAiAdapters();
  const f = await fixture(null, adapters);
  try {
    const first = await uploadKnowledge(f, 'Account access procedure for account lockout.');
    const second = await uploadKnowledge(f, 'Billing procedure for an incorrect invoice.');
    const results = await Promise.all([first, second].map(source => f.request(`/api/v1/documents/${source.document.id}/extract-rules`, 'admin', { method: 'POST', body: '{}' })));
    assert.deepEqual(results.map(response => response.status), [200, 200]);
    const data = await Promise.all(results.map(response => response.json()));
    assert.equal(data[0].data.rules[0].documentId, first.document.id);
    assert.equal(data[1].data.rules[0].documentId, second.document.id);
    const approved = await Promise.all(data.map(result => f.request(`/api/v1/extracted-rules/${result.data.rules[0].id}/approve`, 'admin', { method: 'POST', body: '{"reason":"Checked original"}' })));
    assert.deepEqual(approved.map(response => response.status), [200, 200]);
    assert.equal((await createJsonTenantStore(f.root).readCollection('policyApprovals')).length, 2);
  } finally { await f.close(); }
});

test('existing Jira intake can feed full AI triage without changing the imported ticket or logging its webhook secret', async () => {
  const f = await fixture();
  const messages: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => messages.push(values.map(String).join(' '));
  try {
    const imported = await f.request('/api/v1/tickets/ingest/jira/integration-webhook-secret-at-least-32-characters', 'admin', { method: 'POST', body: JSON.stringify({
      webhookEvent: 'jira:issue_created', issue: { id: 'jira-triage-1', key: 'SUP-42', fields: { project: { key: 'SUP' }, summary: 'Account access locked', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Account locked after reset.' }] }] }, reporter: { accountId: 'jira-requester' }, status: { name: 'Open' } } },
    }) });
    assert.equal(imported.status, 201);
    const id = (await imported.json()).data.id;
    const before = await readFile(join(f.root, 'tickets.json'), 'utf8');
    const triaged = await f.request(`/api/v1/tickets/${id}/triage`, 'admin', { method: 'POST', body: '{}' });
    assert.equal(triaged.status, 200);
    const result = (await triaged.json()).data;
    assert.equal(result.core.ticketId, id);
    assert.equal(result.core.orchestration.engine, 'langgraph');
    assert.equal(result.resolution.data.status, 'insufficient_evidence');
    assert.equal(await readFile(join(f.root, 'tickets.json'), 'utf8'), before);
    assert.equal(messages.join('\n').includes('integration-webhook-secret-at-least-32-characters'), false);
  } finally { console.log = originalLog; await f.close(); }
});

test('one signed-token API joins foundation, tickets, AI, memberships and persistent history', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/health/ready')).status, 200);
    assert.equal((await f.request('/api/v1/me')).status, 200);
    assert.equal((await f.request('/api/v1/teams')).status, 200);
    const created = await f.request('/api/v1/tickets', 'requester', { method: 'POST', body: JSON.stringify({ title: 'Account access locked', description: 'Account locked after password reset.' }) });
    assert.equal(created.status, 201);
    const ticket = (await created.json()).data;
    const analysis = await f.request(`/api/v1/tickets/${ticket.id}/analyze`, 'admin', { method: 'POST', body: '{}' });
    assert.equal(analysis.status, 200);
    assert.equal((await analysis.json()).data.organisationId, 'org-a');
    const detail = await f.request(`/api/v1/tickets/${ticket.id}`, 'requester');
    assert.deepEqual((await detail.json()).data.title, ticket.title);
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}`, 'other')).status, 404);
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/analyses`, 'other')).status, 404);
    assert.equal((await f.request('/api/v1/tickets', 'requester', {}, 'org-b')).status, 403);
    assert.equal((await f.request('/api/v1/documents', 'requester')).status, 403);
    await f.restart();
    const history = await f.request(`/api/v1/tickets/${ticket.id}/analyses`, 'admin');
    assert.equal(history.status, 200);
    assert.equal((await history.json()).data.length, 1);
    const revoke = await f.request('/api/v1/users/requester/memberships', 'admin', { method: 'PUT', body: JSON.stringify({ status: 'inactive', roles: ['requester'] }) });
    assert.equal(revoke.status, 200);
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/analyses`, 'requester')).status, 403);
  } finally { await f.close(); }
});

async function priorityConfiguration(malformed = false, timeout = false) {
  const candidate = JSON.parse(await readFile(new URL('../data/reference/candidates/priority-policy.json', import.meta.url), 'utf8'));
  let calls = 0;
  const fake = new DeterministicFakeProvider({ ticket_priority_factors(input) {
    calls++;
    const ticket = (input as { ticket: { id: string; title: string } }).ticket;
    const assessment = { value: 'high', reason: 'Synthetic factor fixture for API verification.', confidence: 0.9,
      evidence: [{ ticketId: ticket.id, field: 'title', start: 0, end: ticket.title.length, excerpt: malformed ? 'Fabricated citation' : ticket.title }] };
    return { impact: assessment, urgency: assessment, missingInformation: [], warnings: [] };
  } });
  const provider: StructuredGenerationProvider = timeout ? { generateStructured: () => { calls++; return new Promise(() => {}); } } : fake;
  const runner = new AiExecutionRunner(provider, { async record() {} }, { model: 'test-priority-model', timeoutMs: 20, maxRetries: 0 });
  return { config: { candidate, runner, minimumConfidence: 0.75 }, calls: () => calls };
}

test('priority API returns evidence-backed draft preview without changing ticket or analyses', async () => {
  const priority = await priorityConfiguration();
  const f = await fixture(priority.config);
  try {
    const created = await f.request('/api/v1/tickets', 'requester', { method: 'POST', body: '{"title":"All departments unavailable","description":"Production stopped"}' });
    const ticket = (await created.json()).data;
    const before = await readFile(join(f.root, 'tickets.json'), 'utf8');
    const response = await f.request(`/api/v1/tickets/${ticket.id}/recommend-priority`, 'admin', { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.data.priority, 'P1');
    assert.equal(result.data.policyStatus, 'draft');
    assert.equal(result.data.requiresHumanReview, true);
    assert.equal(result.data.factors.impact.evidence[0].ticketId, ticket.id);
    assert.ok(result.requestId);
    assert.equal(await readFile(join(f.root, 'tickets.json'), 'utf8'), before);
    await assert.rejects(readFile(join(f.root, 'ai-analyses.json')), { code: 'ENOENT' });
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/recommend-priority`, 'requester', { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/recommend-priority`, 'other', { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/recommend-priority`, 'agent', { method: 'POST', body: '{}' })).status, 404);
    for (const body of ['{"priority":"P1"}', '{"roles":["organisation_admin"]}', '{"impact":"high"}', '{"policy":{}}']) {
      assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/recommend-priority`, 'admin', { method: 'POST', body })).status, 400);
    }
    assert.equal(priority.calls(), 1);
  } finally { await f.close(); }
});

test('priority API handles invalid evidence and provider timeouts as safe dependency errors', async () => {
  for (const [malformed, timeout] of [[true, false], [false, true]]) {
    const priority = await priorityConfiguration(malformed, timeout);
    const f = await fixture(priority.config);
    try {
      const created = await f.request('/api/v1/tickets', 'requester', { method: 'POST', body: '{"title":"Outage","description":"System unavailable"}' });
      const ticket = (await created.json()).data;
      const response = await f.request(`/api/v1/tickets/${ticket.id}/recommend-priority`, 'admin', { method: 'POST', body: '{}' });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, 'AI_ANALYSIS_FAILED');
    } finally { await f.close(); }
  }
});

test('priority API is disabled without explicit server configuration', async () => {
  const f = await fixture();
  try {
    const response = await f.request('/api/v1/tickets/any/recommend-priority', 'admin', { method: 'POST', body: '{}' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'PRIORITY_PREVIEW_DISABLED');
  } finally { await f.close(); }
});

test('local demo priority API returns honest insufficient information with mandatory review', async () => {
  const { config } = await priorityConfiguration();
  const f = await fixture({ candidate: config.candidate, minimumConfidence: config.minimumConfidence });
  try {
    const created = await f.request('/api/v1/tickets', 'requester', { method: 'POST', body: '{"title":"Account locked","description":"Cannot sign in"}' });
    const ticket = (await created.json()).data;
    const response = await f.request(`/api/v1/tickets/${ticket.id}/recommend-priority`, 'admin', { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    const result = (await response.json()).data;
    assert.equal(result.priority, null);
    assert.equal(result.status, 'insufficient_information');
    assert.equal(result.requiresHumanReview, true);
    assert.ok(result.warnings.some((warning: string) => warning.startsWith('DEMO_ONLY')));
  } finally { await f.close(); }
});

test('priority preview environment requires development opt-in and an explicit confidence threshold', () => {
  assert.equal(priorityPreviewFromEnvironment({}), null);
  assert.throws(() => priorityPreviewFromEnvironment({ APP_ENV: 'production', TICKET_PRIORITY_PREVIEW_ENABLED: 'true', TICKET_PRIORITY_MIN_CONFIDENCE: '0.75' }));
  assert.throws(() => priorityPreviewFromEnvironment({ APP_ENV: 'development', TICKET_PRIORITY_PREVIEW_ENABLED: 'true' }));
  assert.throws(() => priorityPreviewFromEnvironment({ APP_ENV: 'development', TICKET_PRIORITY_PREVIEW_ENABLED: 'true', TICKET_PRIORITY_MIN_CONFIDENCE: 'NaN' }));
  assert.equal(priorityPreviewFromEnvironment({ APP_ENV: 'development', TICKET_PRIORITY_PREVIEW_ENABLED: 'true', TICKET_PRIORITY_MIN_CONFIDENCE: '0.75' })?.candidate.status, 'draft');
});

test('resolution API retrieves authorised evidence, validates citations and never modifies tickets', async () => {
  let calls = 0;
  const provider = new DeterministicFakeProvider({ ticket_resolution(input) {
    calls++;
    const evidence = (input as { evidence: Array<{ passageId: string; excerpt: string }> }).evidence[0]!;
    return { summary: 'Review the runbook.', steps: [{ instruction: 'Verify the account owner before requesting a reset.', citations: [{ passageId: evidence.passageId, excerpt: evidence.excerpt }] }], missingInformation: [], warnings: [] };
  } });
  const runner = new AiExecutionRunner(provider, { async record() {} }, { model: 'resolution-test', timeoutMs: 100, maxRetries: 0 });
  const f = await fixture(null, { resolutionRunner: runner, knowledgeSource: {
    async listAuthorizedDocuments(tenant) {
      if (tenant.organisationId !== 'org-a' || !tenant.roles.includes('organisation_admin')) return [];
      return [{ id: 'runbook', version: 'v1', organisationId: 'org-a', sourceType: 'knowledge_article', title: 'Account lockout runbook',
        content: 'For account lockout, verify the account owner before requesting a reset.', approved: true, status: 'active', effectiveFrom: '2020-01-01T00:00:00Z', effectiveTo: null }];
    },
  } });
  try {
    const created = await f.request('/api/v1/tickets', 'requester', { method: 'POST', body: '{"title":"Account lockout","description":"Account locked after reset"}' });
    const ticket = (await created.json()).data;
    const before = await readFile(join(f.root, 'tickets.json'), 'utf8');
    const retrieved = await f.request(`/api/v1/tickets/${ticket.id}/evidence`);
    assert.equal(retrieved.status, 200);
    assert.equal((await retrieved.json()).data[0].sourceId, 'runbook');
    const response = await f.request(`/api/v1/tickets/${ticket.id}/recommend-resolution`, 'admin', { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    const result = (await response.json()).data;
    assert.equal(result.status, 'recommendation');
    assert.equal(result.requiresHumanReview, true);
    assert.equal(result.steps[0].citations[0].passageId, result.evidence[0].passageId);
    assert.equal(await readFile(join(f.root, 'tickets.json'), 'utf8'), before);
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/recommend-resolution`, 'requester', { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/recommend-resolution`, 'other', { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/recommend-resolution`, 'admin', { method: 'POST', body: '{"evidence":[],"roles":["organisation_admin"]}' })).status, 400);
    const similar = await f.request(`/api/v1/tickets/${ticket.id}/similar`);
    assert.deepEqual((await similar.json()).data, []);
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('default resolution API returns insufficient evidence instead of using unapproved references', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/api/v1/tickets', 'requester', { method: 'POST', body: '{"title":"Account lockout","description":"Cannot sign in"}' });
    const ticket = (await created.json()).data;
    const response = await f.request(`/api/v1/tickets/${ticket.id}/recommend-resolution`, 'admin', { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    const result = (await response.json()).data;
    assert.equal(result.status, 'insufficient_evidence'); assert.deepEqual(result.steps, []);
    assert.equal(result.execution, null);
  } finally { await f.close(); }
});

test('document processing, human SLA approval, evaluation and reporting work on the same server', async () => {
  const f = await fixture();
  try {
    const upload = new FormData();
    upload.append('title', 'SLA source');
    upload.append('file', new Blob(['Respond within two hours.'], { type: 'text/plain' }), 'policy.txt');
    const uploaded = await f.request('/api/v1/documents', 'admin', { method: 'POST', body: upload });
    assert.equal(uploaded.status, 201);
    const source = (await uploaded.json()).data;
    const processed = await f.request(`/api/v1/documents/${source.document.id}/process`, 'admin', { method: 'POST', body: '{}' });
    assert.equal(processed.status, 200);
    assert.equal((await processed.json()).data.extraction.result.rules[0].payload.targetHours, 2);
    assert.equal((await f.request(`/api/v1/documents/${source.document.id}`, 'other')).status, 404);
    const payload = {
      calendar: { timeZone: 'Africa/Johannesburg', weeklySchedule: Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((day) => [day, [{ startMinute: 0, endMinute: 1440 }]])), holidays: [] },
      targetsByPriority: { high: { firstResponseMinutes: 120, resolutionMinutes: 480 } }, pausedStatuses: ['PENDING'], resolvedStatuses: ['RESOLVED', 'CLOSED'], riskAtPercent: 75,
    };
    const incompleteSource = await f.request('/api/v1/sla-policies', 'admin', { method: 'POST', body: JSON.stringify({ description: 'Incomplete source SLA', sourceDocumentId: source.document.id, effectiveFrom: '2020-01-01T00:00:00.000Z', payload }) });
    assert.equal(incompleteSource.status, 400);
    const created = await f.request('/api/v1/sla-policies', 'admin', { method: 'POST', body: JSON.stringify({ description: 'Reviewed test SLA', sourceDocumentId: source.document.id, sourceDocumentVersionId: source.version.id, effectiveFrom: '2020-01-01T00:00:00.000Z', payload }) });
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const policy = (await created.json()).data;
    assert.equal(policy.version.sourceDocumentId, source.document.id);
    assert.equal(policy.version.sourceDocumentVersionId, source.version.id);
    const path = `/api/v1/sla-policies/${policy.policy.id}/versions/${policy.version.id}`;
    assert.equal((await f.request(`${path}/activate`, 'admin', { method: 'POST', body: '{}' })).status, 409);
    assert.equal((await f.request(`${path}/approve`, 'admin', { method: 'POST', body: '{"reason":"Verified source"}' })).status, 200);
    assert.equal((await f.request(`${path}/activate`, 'admin', { method: 'POST', body: '{}' })).status, 200);
    // Jira's separately authenticated input supplies priority; AI does not mutate it.
    const imported = await f.request('/api/v1/tickets/ingest/jira/integration-webhook-secret-at-least-32-characters', 'other', {
      method: 'POST', body: JSON.stringify({ webhookEvent: 'jira:issue_created', organisationId: 'org-b', issue: {
        id: '1001', key: 'SUP-1', fields: { project: { key: 'SUP' }, summary: 'Account access', description: 'Account locked', reporter: { accountId: 'jira-requester' }, priority: { name: 'high' }, status: { name: 'Open' } },
      } }),
    });
    assert.equal(imported.status, 201);
    const ticket = (await imported.json()).data;
    // Source priority is retained as evidence; a permitted human sets internal priority explicitly.
    const jiraPriorityFilter = await f.request('/api/v1/tickets?priority=high', 'admin');
    assert.ok((await jiraPriorityFilter.json()).data.some((item: { id: string }) => item.id === ticket.id));
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}`, 'requester', { method: 'PATCH', body: '{"priority":"high","priorityOverride":{"reason":"classify","businessJustification":"business impact"}}' })).status, 403);
    const missingOverrideEvidence = await f.request(`/api/v1/tickets/${ticket.id}`, 'admin', { method: 'PATCH', body: '{"priority":"high"}' });
    assert.equal(missingOverrideEvidence.status, 400);
    const incompleteOverrideEvidence = await f.request(`/api/v1/tickets/${ticket.id}`, 'admin', {
      method: 'PATCH',
      body: '{"priority":"P2","priorityOverride":{"reason":"Impact assessed"}}',
    });
    assert.equal(incompleteOverrideEvidence.status, 400);
    const invalidPriority = await f.request(`/api/v1/tickets/${ticket.id}`, 'admin', {
      method: 'PATCH',
      body: '{"priority":"urgent","priorityOverride":{"reason":"Impact assessed","businessJustification":"Service impact"}}',
    });
    assert.equal(invalidPriority.status, 400);
    const prioritised = await f.request(`/api/v1/tickets/${ticket.id}`, 'lead', {
      method: 'PATCH',
      body: JSON.stringify({
        priority: 'high',
        priorityOverride: {
          reason: 'Impact assessed by support lead.',
          businessJustification: 'The service is unavailable to the user.',
        },
      }),
    });
    assert.equal(prioritised.status, 200);
    const prioritisedTicket = (await prioritised.json()).data;
    assert.equal(prioritisedTicket.priority, 'P2');
    assert.equal(prioritisedTicket.source.priority, 'high');
    const beforeTriage = await readFile(join(f.root, 'tickets.json'), 'utf8');
    const triaged = await f.request(`/api/v1/tickets/${ticket.id}/triage`, 'admin', { method: 'POST', body: '{}' });
    assert.equal(triaged.status, 200);
    const sla = (await triaged.json()).data.sla;
    assert.equal(sla.status, 'completed');
    assert.equal(sla.data.status, 'available');
    assert.equal(sla.data.evaluation.ticketId, ticket.id);
    assert.equal(sla.data.evaluation.policyVersionId, policy.version.id);
    assert.equal(sla.data.evaluation.input.priority, 'P2');
    assert.equal(await readFile(join(f.root, 'tickets.json'), 'utf8'), beforeTriage);
    const savedEvaluations = (await (await f.request(`/api/v1/sla/evaluations?ticketId=${ticket.id}`)).json()).data;
    assert.ok(savedEvaluations.some((record: { id: string }) => record.id === sla.data.evaluation.id));
    const audit = await f.request(`/api/v1/tickets/${ticket.id}/audit`, 'admin');
    const override = (await audit.json()).data.find(
      (event: { action: string }) => event.action === 'ticket.priority.overridden',
    );
    assert.equal(override.actorId, 'lead');
    assert.ok(Number.isFinite(Date.parse(override.createdAt)));
    assert.deepEqual(override.changes.priority, { before: null, after: 'P2' });
    assert.deepEqual(override.changes.priorityOverride, {
      reason: 'Impact assessed by support lead.',
      businessJustification: 'The service is unavailable to the user.',
    });
    const evaluated = await f.request('/api/v1/sla/evaluations/run', 'admin', { method: 'POST', body: '{}' });
    assert.equal(evaluated.status, 200);
    assert.ok((await evaluated.json()).data.some((record: { ticketId: string }) => record.ticketId === ticket.id));
    const report = await f.request('/api/v1/reports?from=2020-01-01T00:00:00.000Z&to=2099-01-01T00:00:00.000Z');
    assert.equal(report.status, 200);
    assert.equal((await report.json()).data.ticketVolume, 1);
    assert.equal((await f.request('/api/v1/sla/evaluations', 'other')).status, 200);
    assert.equal((await (await f.request('/api/v1/sla/evaluations', 'other')).json()).data.length, 0);
  } finally { await f.close(); }
});

test('approved workflows, attachments, status and audit use the shared authenticated caller', async () => {
  const f = await fixture();
  try {
    const config = {
      sourceReference: 'Synthetic workflow policy', initialStatus: 'NEW', reopenStatus: 'REOPENED',
      statuses: ['NEW', 'OPEN', 'RESOLVED', 'CLOSED', 'REOPENED'],
      transitions: { NEW: ['OPEN'], OPEN: ['RESOLVED'], RESOLVED: ['CLOSED', 'REOPENED'], CLOSED: ['REOPENED'], REOPENED: ['OPEN'] },
      requestableReopenFrom: ['RESOLVED'], restrictedReopenFrom: ['CLOSED'],
      permissions: { directStatusChangeRoles: ['support_agent', 'support_lead'], closedReopenRoles: ['support_lead', 'organisation_admin'], reopenRequestRoles: ['requester'], reopenApprovalRoles: ['support_lead', 'organisation_admin'], administratorOverrideRoles: ['organisation_admin'] },
    };
    const drafted = await f.request('/api/v1/ticket-workflows', 'admin', { method: 'POST', body: JSON.stringify({ config }) });
    assert.equal(drafted.status, 201);
    const workflow = (await drafted.json()).data;
    assert.equal((await f.request(`/api/v1/ticket-workflows/${workflow.id}/approve`, 'admin', { method: 'POST', body: '{}' })).status, 200);
    const created = await f.request('/api/v1/tickets', 'requester', { method: 'POST', body: '{"title":"Access issue","description":"Locked"}' });
    const ticket = (await created.json()).data;
    assert.equal(ticket.status, 'NEW');
    const form = new FormData();
    form.append('file', new Blob(['Issue details'], { type: 'text/plain' }), 'details.txt');
    const attachment = await f.request(`/api/v1/tickets/${ticket.id}/attachments`, 'requester', { method: 'POST', body: form });
    assert.equal(attachment.status, 201);
    const attachmentId = (await attachment.json()).data.id;
    const downloadPath = `/api/v1/tickets/${ticket.id}/attachments/${attachmentId}`;
    assert.equal(await (await f.request(downloadPath, 'requester')).text(), 'Issue details');
    assert.equal((await f.request(downloadPath, 'other')).status, 404);
    const change = { method: 'PATCH', body: '{"status":"OPEN"}' };
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/status`, 'requester', change)).status, 403);
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/status`, 'admin', change)).status, 200);
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/audit`)).status, 200);
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/audit`, 'requester')).status, 403);
  } finally { await f.close(); }
});

test('team access is resolved per caller and changes take effect without restarting', async () => {
  const f = await fixture();
  try {
    const teamResponse = await f.request('/api/v1/teams', 'admin', { method: 'POST', body: '{"name":"Support"}' });
    const team = (await teamResponse.json()).data;
    const ticket = await new JsonTicketStore(f.root).createTicket({ organisationId: 'org-a', requesterId: 'requester', title: 'Account access', description: 'Locked', teamId: team.id }, { organisationId: 'org-a', userId: 'requester', roles: ['requester'] });
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}`, 'agent')).status, 404);
    const assigned = await f.request(`/api/v1/teams/${team.id}/members`, 'admin', { method: 'PUT', body: '{"userId":"agent","role":"support_agent","status":"active"}' });
    assert.equal(assigned.status, 200);
    const parallel = await Promise.all([
      f.request(`/api/v1/tickets/${ticket.id}/analyze`, 'agent', { method: 'POST', body: '{}' }),
      f.request(`/api/v1/tickets/${ticket.id}/analyze`, 'other', { method: 'POST', body: '{}' }),
    ]);
    assert.deepEqual(parallel.map((response) => response.status), [200, 404]);
    const renamed = await f.request(`/api/v1/teams/${team.id}`, 'admin', { method: 'PATCH', body: '{"name":"Service Desk"}' });
    assert.equal(renamed.status, 200);
    await f.request(`/api/v1/teams/${team.id}/members`, 'admin', { method: 'PUT', body: '{"userId":"agent","role":"support_agent","status":"inactive"}' });
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}/analyses`, 'agent')).status, 404);
  } finally { await f.close(); }
});

test('shared domain persistence preserves corruption and concurrent document writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'domain-persistence-'));
  try {
    const now = new Date().toISOString();
    const tenant = { organisationId: 'org-a', userId: 'admin', roles: ['organisation_admin'] };
    await Promise.all(Array.from({ length: 12 }, (_, index) => new JsonDocumentRepository(createJsonTenantStore(root)).create({
      id: `doc-${index}`, organisationId: tenant.organisationId, title: 'Policy', status: 'uploaded', fileName: 'policy.txt', mimeType: 'text/plain', storageKey: `private/org-a/doc-${index}/policy.txt`, checksumSha256: 'test', createdBy: 'admin', createdAt: now, updatedAt: now, version: 1, fileSizeBytes: 10, provider: 'private-storage', processingStatus: 'queued',
    }, tenant)));
    assert.equal((await createJsonTenantStore(root).readCollection('documents')).length, 12);
    const broken = '{"schemaVersion":1,"records":';
    await writeFile(join(root, 'documents.json'), broken);
    await assert.rejects(createJsonTenantStore(root).readCollection('documents'), /invalid JSON/);
    assert.equal(await readFile(join(root, 'documents.json'), 'utf8'), broken);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('approved routing, durable triage history and immutable quality reviews use scoped APIs', async () => {
  const f = await fixture();
  try {
    const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
    const team = (await (await f.request('/api/v1/teams', 'admin', post({name:'Access desk'}))).json()).data;
    await f.request(`/api/v1/teams/${team.id}/members`, 'admin', { method:'PUT', body:JSON.stringify({userId:'agent',role:'support_agent',status:'active'}) });
    const ticket = await new JsonTicketStore(f.root).createTicket({organisationId:'org-a',requesterId:'requester',teamId:team.id,title:'Account access problem',description:'Account locked after password reset.'}, {organisationId:'org-a',userId:'requester',roles:['requester']});
    const path = `/api/v1/tickets/${ticket.id}`;
    const input = {categoryIds:['ACCESS'],teamId:team.id,effectiveFrom:'2020-01-01T00:00:00.000Z'};
    assert.equal((await f.request('/api/v1/ai/routing-rules','agent',post(input))).status,403);
    assert.equal((await f.request('/api/v1/ai/routing-rules','admin',post({...input,categoryIds:['FORGED']}))).status,400);
    const rule = (await (await f.request('/api/v1/ai/routing-rules','admin',post(input))).json()).data;
    const draft = (await (await f.request(`${path}/triage`,'agent',post({}))).json()).data;
    assert.equal(draft.routing.data.teamId,null);
    assert.equal((await f.request(`/api/v1/ai/routing-rules/${rule.id}/approve`,'admin',post({reason:'Agreed by support lead'}))).status,200);
    const triaged = await f.request(`${path}/triage`,'agent',post({}));
    assert.equal(triaged.status,200,JSON.stringify(await triaged.clone().json()));
    const result = (await triaged.json()).data;
    assert.equal(result.routing.data.teamId,team.id);
    assert.ok(result.triageId);
    assert.equal((await f.request(`${path}/triages/${result.triageId}/reviews`,'agent',post({decision:'accepted',reason:'Checked'}))).status,403);
    const decision = {decision:'accepted',reason:'Verified category and evidence',quality:{classificationCorrect:true,groundedness:'grounded'}};
    const review = await f.request(`${path}/triages/${result.triageId}/reviews`,'admin',post(decision));
    assert.equal(review.status,201,JSON.stringify(await review.clone().json()));
    const reviewId = (await review.json()).data.id;
    assert.equal((await (await f.request(`${path}/triages/${result.triageId}/reviews`,'admin',post(decision))).json()).data.id,reviewId);
    assert.equal((await f.request(`${path}/triages/${result.triageId}/reviews`,'admin',post({...decision,decision:'rejected'}))).status,409);
    const quality = (await (await f.request('/api/v1/ai/quality-summary')).json()).data;
    assert.equal(quality.classificationAccuracy,1); assert.equal(quality.reviewedSamples,1);
    await f.restart();
    const history = (await (await f.request(`${path}/triages`,'agent')).json()).data;
    assert.equal(history.length,2); assert.equal(history[1].reviews[0].id,reviewId);
    assert.equal((await f.request(`${path}/triages`,'other')).status,404);
    assert.equal((await f.request(`${path}/triages`,'requester')).status,403);
    await f.request(`/api/v1/ai/routing-rules/${rule.id}/disable`,'admin',post({reason:'Rule withdrawn'}));
    const hidden = (await (await f.request(`${path}/triages`,'agent')).json()).data[1];
    assert.equal(hidden.redacted,true); assert.equal(hidden.data,undefined);
    assert.equal((await new JsonTicketStore(f.root).findTicket({organisationId:'org-a',userId:'admin',roles:[]},ticket.id))?.teamId,team.id);
  } finally { await f.close(); }
});

test('queued triage is durable, rejects actor injection and checks current membership', async () => {
  const f = await fixture();
  try {
    const post = (body: unknown) => ({method:'POST',body:JSON.stringify(body)});
    const ticket = (await (await f.request('/api/v1/tickets','requester',post({title:'Account access',description:'Cannot log in.'}))).json()).data;
    const path = `/api/v1/tickets/${ticket.id}`;
    assert.equal((await f.request(`${path}/triage-jobs`,'admin',post({actorId:'requester'}))).status,400);
    const queued = await f.request(`${path}/triage-jobs`,'admin',post({}));
    assert.equal(queued.status,202); const job = (await queued.json()).data;
    assert.equal((await f.request(`/api/v1/ai/triage-jobs/${job.id}`,'other')).status,404);
    await f.restart();
    const completed = await f.request(`/api/v1/ai/triage-jobs/${job.id}/process`,'admin',post({}));
    assert.equal(completed.status,200); const processed = (await completed.json()).data;
    assert.equal(processed.data.status,'completed'); assert.equal(processed.data.attempts,1);
    await f.request(`/api/v1/ai/triage-jobs/${job.id}/process`,'admin',post({}));
    assert.equal((await (await f.request(`${path}/triages`)).json()).data.length,1);
    const stale = (await (await f.request(`${path}/triage-jobs`,'admin',post({}))).json()).data;
    await new JsonTicketStore(f.root).updateTicket({organisationId:'org-a',userId:'admin',roles:['organisation_admin']},ticket.id,{title:'Changed account access'});
    const failed = (await (await f.request(`/api/v1/ai/triage-jobs/${stale.id}/process`,'admin',post({}))).json()).data;
    assert.equal(failed.data.status,'failed'); assert.equal(failed.data.errorCode,'STALE_JOB');
    const pending = (await (await f.request(`${path}/triage-jobs`,'admin',post({}))).json()).data;
    await f.store.update('memberships.json', (value: unknown): value is {schemaVersion:1,records:Array<{userId:string,status:string}>} => !!value && typeof value === 'object' && Array.isArray((value as {records?:unknown}).records), envelope => { envelope.records.find(row => row.userId === 'admin')!.status = 'inactive'; });
    const {AiOperationsStore} = await import('../src/modules/ai/operations-store.js');
    const {TriageJobs} = await import('../src/modules/ai/triage-jobs.js');
    const {AiOperationsService} = await import('../src/modules/ai/operations-service.js');
    const dummy = new AiOperationsService(new AiOperationsStore(f.store), {} as never);
    await new TriageJobs(dummy, async () => null).process(pending.id);
    const revoked = (await dummy.store.list('org-a','job')).find(row => row.id === pending.id)!;
    assert.equal(revoked.data.errorCode,'ACCESS_REVOKED');
  } finally { await f.close(); }
});

test('evaluation APIs expose measured fixture outcomes and Swagger serves local assets', async () => {
  const f = await fixture();
  try {
    const input = {version:'test-v1',cases:[{id:'access',title:'Account access',description:'Account locked.',expectedCategory:'ACCESS',requiredFacts:['locked'],prohibitedFacts:['ticket closed']},{id:'unknown',title:'Please help',description:'Something went wrong.',expectedCategory:null,requiredFacts:[],prohibitedFacts:[]}]};
    const post = (body: unknown) => ({method:'POST',body:JSON.stringify(body)});
    assert.equal((await f.request('/api/v1/ai/evaluations','agent',post(input))).status,403);
    assert.equal((await f.request('/api/v1/ai/evaluations','admin',post({...input,cases:[{...input.cases[0],expectedCategory:'WRONG'}]}))).status,400);
    const response = await f.request('/api/v1/ai/evaluations','admin',post(input));
    assert.equal(response.status,201,JSON.stringify(await response.clone().json()));
    const report = (await response.json()).data;
    assert.equal(report.data.metrics.categoryAccuracy,1); assert.equal(report.data.metrics.requiredFactCoverage,1);
    assert.equal(report.data.metrics.semanticGroundedness,'requires_human_review');
    assert.equal((await (await f.request('/api/v1/ai/evaluations')).json()).data.length,1);
    for (const path of ['/api/v1/ai/docs','/api/v1/ai/docs/swagger-ui.css','/api/v1/ai/docs/swagger-ui-bundle.js','/api/v1/ai/openapi.json']) {
      const response = await f.request(path,'admin',{headers:{}});
      assert.equal(response.status,200,path);
      const publicResponse = await fetch(response.url);
      assert.equal(publicResponse.status,200,'Documentation must work without a token');
    }
    const protectedResponse = await f.request('/api/v1/ai/routing-rules');
    assert.equal((await fetch(protectedResponse.url)).status,401);
  } finally { await f.close(); }
});


test('historical retrieval requires verified resolution evidence and stops after reopen or revocation', async () => {
  const f = await fixture();
  try {
    const post = (body: unknown) => ({method:'POST',body:JSON.stringify(body)});
    const actor = {organisationId:'org-a',userId:'admin',roles:['organisation_admin']};
    const tickets = new JsonTicketStore(f.root);
    const source = await tickets.createTicket({organisationId:'org-a',requesterId:'requester',title:'Account access restored',description:'Account locked after reset.'},actor);
    const target = await tickets.createTicket({organisationId:'org-a',requesterId:'requester',title:'Account access lockout',description:'Account locked after reset.'},actor);
    const verify = {resolution:'Account access restored after verifying identity and resetting the expired password link.',visibility:'organisation_staff',reason:'Verified the outcome with recorded evidence'};
    const path = `/api/v1/tickets/${source.id}`;
    assert.equal((await f.request(`${path}/verified-resolution`,'admin',post(verify))).status,409);
    assert.equal((await f.request(`${path}/verified-resolution`,'agent',post(verify))).status,403);
    assert.equal((await f.request(`${path}/verified-resolution`,'other',post(verify))).status,404);
    const payload = {calendar:{timeZone:'UTC',weeklySchedule:Object.fromEntries(['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].map(day=>[day,[{startMinute:0,endMinute:1440}]])),holidays:[]},targetsByPriority:{P2:{firstResponseMinutes:120,resolutionMinutes:480}},pausedStatuses:['PENDING'],resolvedStatuses:['RESOLVED'],riskAtPercent:75};
    const created = await f.request('/api/v1/sla-policies','admin',post({description:'Historical resolution verification SLA',effectiveFrom:'2020-01-01T00:00:00.000Z',payload}));
    assert.equal(created.status,201,JSON.stringify(await created.clone().json()));
    const policy = (await created.json()).data;
    const policyPath = `/api/v1/sla-policies/${policy.policy.id}/versions/${policy.version.id}`;
    await f.request(`${policyPath}/approve`,'admin',post({reason:'Verified test policy'}));
    await f.request(`${policyPath}/activate`,'admin',post({}));
    await tickets.updateTicket(actor,source.id,{priority:'P2'});
    await tickets.changeStatus(actor,source.id,'new','RESOLVED','Human resolution','test-workflow');
    assert.equal((await f.request(`${path}/verified-resolution`,'admin',post(verify))).status,409);
    await tickets.changeStatus(actor,source.id,'RESOLVED','RESOLVED','Recorded resolution','test-workflow',{resolution:{outcome:'service_restored',note:'Access restored after resetting expired link.',customerConfirmation:'received',customerConfirmationEvidence:'Requester confirmed access.'}});
    const verified = await f.request(`${path}/verified-resolution`,'admin',post(verify));
    assert.equal(verified.status,201,JSON.stringify(await verified.clone().json()));
    const verification = (await verified.json()).data;
    const similar = (await (await f.request(`/api/v1/tickets/${target.id}/similar`)).json()).data;
    assert.equal(similar[0].sourceId,source.id); assert.equal(similar[0].sourceType,'historical_ticket');
    assert.equal((await (await f.request(`${path}/similar`)).json()).data.length,0);
    assert.equal((await (await f.request(`/api/v1/tickets/${target.id}/similar`,'agent')).json()).data,undefined);
    await f.restart();
    assert.equal((await (await f.request(`/api/v1/tickets/${target.id}/similar`)).json()).data[0].version,verification.id);
    await f.request(`/api/v1/ai/verified-resolutions/${verification.id}/revoke`,'admin',post({reason:'Withdraw outdated resolution'}));
    assert.equal((await (await f.request(`/api/v1/tickets/${target.id}/similar`)).json()).data.length,0);
    await f.request(`${path}/verified-resolution`,'admin',post(verify));
    await tickets.changeStatus(actor,source.id,'RESOLVED','new','Reopened by human','test-workflow');
    assert.equal((await (await f.request(`/api/v1/tickets/${target.id}/similar`)).json()).data.length,0);
  } finally {await f.close();}
});

test('automatic intake is opt-in and idempotent without ticket mutations', async () => {
  const f = await fixture(null,{aiAutomation:{enabled:true,actors:{'org-a':'admin'},intervalMs:60000,createdAfter:'2026-01-01T00:00:00.000Z'}});
  try {
    const created = await f.request('/api/v1/tickets','requester',{method:'POST',body:JSON.stringify({title:'Account access',description:'Account locked.'})});
    assert.equal(created.status,201); const ticket = (await created.json()).data;
    const {AiOperationsStore} = await import('../src/modules/ai/operations-store.js');
    const ledger = new AiOperationsStore(f.store);
    const queued = (await ledger.list('org-a','job')).filter(row => row.data.ticketId === ticket.id);
    assert.equal(queued.length,1); assert.equal(queued[0]!.actorId,'admin');
    const before = await readFile(join(f.root,'tickets.json'),'utf8');
    const result = await f.request(`/api/v1/ai/triage-jobs/${queued[0]!.id}/process`,'admin',{method:'POST',body:'{}'});
    assert.equal((await result.json()).data.data.status,'completed');
    await f.restart();
    assert.equal((await ledger.list('org-a','job')).filter(row => row.data.ticketId === ticket.id).length,1);
    assert.equal(await readFile(join(f.root,'tickets.json'),'utf8'),before);
  } finally {await f.close();}
});
