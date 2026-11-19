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

async function fixture(priorityPreview: PriorityPreviewConfiguration | null = null,
  resolution: { knowledgeSource?: AuthorizedKnowledgeSource; resolutionRunner?: AiExecutionRunner } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'integrated-triage-'));
  const store = new JsonFileStore(root);
  const now = new Date().toISOString();
  const dates = { createdAt: now, updatedAt: now };
  await store.write('organisations.json', { schemaVersion: 1, records: ['org-a', 'org-b'].map((id) => ({ id, name: id, status: 'active', settings: {}, ...dates })) });
  await store.write('users.json', { schemaVersion: 1, records: ['admin', 'requester', 'other', 'agent'].map((id) => ({ id, email: `${id}@example.test`, displayName: id, status: 'active', ...dates })) });
  await store.write('memberships.json', { schemaVersion: 1, records: [
    { id: 'm-admin', organisationId: 'org-a', userId: 'admin', roles: ['organisation_admin'], status: 'active', ...dates },
    { id: 'm-requester', organisationId: 'org-a', userId: 'requester', roles: ['requester'], status: 'active', ...dates },
    { id: 'm-agent', organisationId: 'org-a', userId: 'agent', roles: ['support_agent'], status: 'active', ...dates },
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
    const created = await f.request('/api/v1/sla-policies', 'admin', { method: 'POST', body: JSON.stringify({ description: 'Reviewed test SLA', sourceDocumentId: source.document.id, sourceDocumentVersionId: source.version.id, effectiveFrom: '2020-01-01T00:00:00.000Z', payload }) });
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const policy = (await created.json()).data;
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
    assert.equal((await f.request(`/api/v1/tickets/${ticket.id}`, 'requester', { method: 'PATCH', body: '{"priority":"high"}' })).status, 403);
    const prioritised = await f.request(`/api/v1/tickets/${ticket.id}`, 'admin', { method: 'PATCH', body: '{"priority":"high"}' });
    assert.equal(prioritised.status, 200);
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
