import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';
import { KeycloakAuthenticationProvider } from '../src/infrastructure/auth/keycloak-authentication.js';
import { createIntegratedApp } from '../src/integrated-app.js';
import { loadEnvironment } from '../src/config/env.js';
import { liveTicketAiConfigurationFromEnvironment } from '../src/modules/ai/live-ticket-ai-runtime.js';
import { validatePriorityCandidate } from '../src/modules/ai/components/priority-matrix.js';

// Live providers, synthetic users/source documents only. No real Keycloak changes.
// Review/publication calls simulate an administrator solely inside temporary fixture data.
const localRoot = resolve('.local-data');
await mkdir(localRoot, { recursive: true });
const root = await mkdtemp(join(localRoot, 'document-ticket-live-'));
let server: ReturnType<typeof createIntegratedApp> | undefined;
const deadline = setTimeout(() => { console.error('Integration smoke test exceeded three minutes.'); process.exit(1); }, 180_000);
try {
  const environment = { ...process.env, APP_ENV: 'development', TICKET_AI_LIVE_ENABLED: 'true', TICKET_AI_DEMO_ENABLED: 'false',
    TICKET_AI_CATEGORIES: JSON.stringify([{ id: 'ACCOUNT_ACCESS', name: 'Account access' }]) };
  const configuration = liveTicketAiConfigurationFromEnvironment(environment)!;
  configuration.timeoutMs = Math.min(configuration.timeoutMs, 15_000);
  configuration.inceptionMaxRetries = Math.min(configuration.inceptionMaxRetries, 1);
  configuration.inceptionBackoffBaseMs = Math.min(configuration.inceptionBackoffBaseMs, 1_000);
  configuration.inceptionBackoffMaxMs = Math.min(configuration.inceptionBackoffMaxMs, 2_000);
  const now = new Date().toISOString();
  const dates = { createdAt: now, updatedAt: now };
  const store = new JsonFileStore(root);
  await store.write('organisations.json', { schemaVersion: 1, records: [{ id: 'fixture-org', name: 'Fixture Support', status: 'active', settings: {}, ...dates }] });
  const identities = ['admin', 'requester', 'agent'];
  await store.write('users.json', { schemaVersion: 1, records: identities.map(id => ({ id, email: `${id}@example.test`, displayName: id, status: 'active', ...dates })) });
  await store.write('memberships.json', { schemaVersion: 1, records: identities.map((id, index) => ({ id: `membership-${id}`, userId: id, organisationId: 'fixture-org', status: 'active', roles: [['organisation_admin'], ['requester'], ['support_agent']][index], ...dates })) });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://fixture-identity.invalid/realms/support';
  const authenticator = new KeycloakAuthenticationProvider({ issuer, audience: 'support-api', jwksUri: `${issuer}/certs`,
    fetcher: async () => Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' }] }) });
  function token(user: string) {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: 'support-api', typ: 'Bearer', sub: user, exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
    const unsigned = `${head}.${claims}`;
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
  }
  const candidate = validatePriorityCandidate(JSON.parse(await readFile('data/reference/candidates/priority-policy.json', 'utf8')));
  server = createIntegratedApp(loadEnvironment({ NODE_ENV: 'test', DATA_DIRECTORY: root, PORT: '0', LOG_LEVEL: 'error' }), { authenticator }, {
    dataDirectory: root, ticketAiLive: configuration, ticketAiDemo: null,
    priorityPreview: { candidate, minimumConfidence: 0.75 },
  });
  await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(path: string, user = 'admin', method = 'GET', body?: object | FormData, status = 200) {
    const multipart = body instanceof FormData;
    const response = await fetch(url + path, { method, headers: { authorization: `Bearer ${token(user)}`, 'x-organisation-id': 'fixture-org', ...(multipart ? {} : { 'content-type': 'application/json' }) },
      ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90_000) });
    assert.equal(response.status, status, `${method} ${path}: ${response.status}`);
    return response.json();
  }
  console.log('Live HTTP integration using synthetic documents, users and review decisions only.');
  const upload = new FormData();
  upload.append('title', 'Synthetic account lockout runbook');
  upload.append('file', new Blob(['For an account locked after failed login attempts: wait 15 minutes before trying to log in again. If the account remains locked, contact the service desk and provide the exact error message.'], { type: 'text/plain' }), 'fixture-runbook.txt');
  const source = (await request('/api/v1/documents', 'admin', 'POST', upload, 201)).data;
  const extracted = (await request(`/api/v1/documents/${source.document.id}/extract-rules`, 'admin', 'POST', {})).data;
  assert.equal(extracted.job.status, 'succeeded');
  assert.ok(extracted.rules.length > 0);
  for (const rule of extracted.rules) {
    assert.equal(rule.requiresHumanReview, true);
    await request(`/api/v1/extracted-rules/${rule.id}/approve`, 'admin', 'POST', { reason: 'Synthetic smoke fixture review only.' });
  }
  const publication = (await request(`/api/v1/documents/${source.document.id}/publish-knowledge`, 'admin', 'POST', {
    ruleIds: extracted.rules.map((rule: { id: string }) => rule.id), reason: 'Publish synthetic fixture excerpts only.', effectiveFrom: '2020-01-01T00:00:00.000Z', visibility: 'support_staff',
  })).data;
  assert.equal(publication.status, 'active');
  const team = (await request('/api/v1/teams', 'admin', 'POST', { name: 'Synthetic account support' }, 201)).data;
  for (const user of ['admin', 'agent']) await request(`/api/v1/teams/${team.id}/members`, 'admin', 'PUT', { userId: user, role: 'support_agent', status: 'active' });
  const ticket = (await request('/api/v1/tickets', 'requester', 'POST', { title: 'Account locked after failed login attempts',
    description: 'My account is locked. Only my account is affected. I cannot work and have no workaround. I need access within one hour.' }, 201)).data;
  await request(`/api/v1/tickets/${ticket.id}`, 'admin', 'PATCH', { teamId: team.id });
  const before = await readFile(join(root, 'tickets.json'), 'utf8');
  const triage = (await request(`/api/v1/tickets/${ticket.id}/triage`, 'agent', 'POST', {})).data;
  assert.equal(triage.core.orchestration.engine, 'langgraph');
  assert.equal(triage.evidence.status, 'completed');
  assert.ok(triage.evidence.data.some((passage: { version: string }) => passage.version === publication.id));
  assert.equal(triage.resolution.status, 'completed');
  assert.equal(triage.priority.status, 'completed');
  assert.equal(await readFile(join(root, 'tickets.json'), 'utf8'), before);
  await request(`/api/v1/documents/${source.document.id}`, 'agent', 'GET', undefined, 403);
  await request(`/api/v1/tickets/${ticket.id}/triage`, 'requester', 'POST', {}, 403);
  assert.equal((await request(`/api/v1/tickets/${ticket.id}/ai-runs`, 'agent')).data.length, 1);
  console.log(JSON.stringify({ result: 'PASS', fixtureOnly: true, extractionProvider: extracted.job.executionMetadata.provider,
    candidateCount: extracted.rules.length, publicationStatus: publication.status, workflow: triage.core.orchestration.engine,
    priorityStatus: triage.priority.data.status, resolutionStatus: triage.resolution.data.status,
    knowledgePublicationUsed: true, ticketUnchanged: true, roleIsolationVerified: true }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', code: error && typeof error === 'object' && 'code' in error ? error.code : 'CONFIGURATION_OR_TEST_FAILURE',
    ...(error instanceof Error && error.name === 'AssertionError' ? { assertion: error.message } : {}) }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (server?.listening) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
  if (dirname(root) !== localRoot || !root.startsWith(join(localRoot, 'document-ticket-live-'))) throw new Error('Unexpected test directory.');
  await rm(root, { recursive: true, force: true });
}
