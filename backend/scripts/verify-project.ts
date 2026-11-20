import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { createConfiguredServer } from '../src/server.js';
import { createIntegratedApp } from '../src/integrated-app.js';
import { loadEnvironment } from '../src/config/env.js';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';
import { KeycloakAuthenticationProvider } from '../src/infrastructure/auth/keycloak-authentication.js';
import { createLiveTicketAiRuntime, liveTicketAiConfigurationFromEnvironment, LiveTicketAiConfigurationError } from '../src/modules/ai/live-ticket-ai-runtime.js';
import { MistralEmbeddingProvider } from '../src/infrastructure/embeddings/mistral-embedding-provider.js';
import { validatePriorityCandidate } from '../src/modules/ai/components/priority-matrix.js';
import { policyDocx, policyPdf } from '../tests/fixtures/document-fixtures.js';

// Explicit verification tool. --live sends only synthetic data to configured providers.
// Credentials/tokens are never logged; real application data and configuration are untouched.
const live = process.argv.includes('--live');
let langGraphInstalled = false;
try { createRequire(import.meta.url).resolve('@langchain/langgraph'); langGraphInstalled = true; } catch { /* Optional, unapproved dependency. */ }
const results: Array<{ check: string; status: string; detail?: string }> = [];
const localRoot = resolve('.local-data');
await mkdir(localRoot, { recursive: true });
const root = await mkdtemp(join(localRoot, 'verification-'));
async function check(name: string, action: () => Promise<string | void>) {
  try {
    const detail = await action();
    results.push({ check: name, status: 'PASS', ...(detail ? { detail } : {}) });
  } catch (error) {
    // Only the configuration exception is trusted to describe variable names, not secrets.
    const detail = error instanceof LiveTicketAiConfigurationError || (error instanceof Error && error.name === 'AssertionError') ? error.message
      : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : error instanceof Error ? error.name : 'Verification failed';
    results.push({ check: name, status: 'FAIL', detail });
  }
  console.log(JSON.stringify(results.at(-1)));
}
async function listen(server: Server) {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
const deadline = setTimeout(() => { console.error('Verification exceeded four minutes.'); process.exit(1); }, 240_000);
try {
  await check('Normal startup configuration and public health', async () => {
    const environment = loadEnvironment();
    // Use a fresh data directory/ephemeral port, preserving all normal config guards.
    const server = createConfiguredServer({ ...environment, dataDirectory: join(root, 'normal-startup'), port: 0 });
    try {
      const url = await listen(server);
      for (const path of ['/health/live', '/health/ready']) {
        assert.equal((await fetch(url + path, { signal: AbortSignal.timeout(5_000) })).status, 200);
      }
      assert.equal((await fetch(url + '/api/v1/tickets', { signal: AbortSignal.timeout(5_000) })).status, 401);
      const counts: Record<string, number> = {};
      for (const collection of ['users', 'memberships', 'organisations']) {
        try {
          const envelope = JSON.parse(await readFile(join(resolve(environment.dataDirectory), `${collection}.json`), 'utf8')) as { records: Array<{ status?: string }> };
          counts[collection] = envelope.records.filter(record => record.status === 'active').length;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          counts[collection] = 0;
        }
      }
      if (Object.values(counts).some(count => count === 0)) {
        const identity = { check: 'Configured real identity records', status: 'BLOCKED', detail: `Active record counts ${JSON.stringify(counts)}; real-user onboarding remains unverified` };
        results.push(identity);
        console.log(JSON.stringify(identity));
      }
      return `authMode=${environment.authMode}; protected routes reject missing tokens`;
    } finally { await close(server); }
  });
  if (process.env.AUTH_MODE === 'keycloak') {
    await check('Live Keycloak discovery and signing keys', async () => {
      const environment = loadEnvironment();
      const response = await fetch(`${environment.authIssuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8_000) });
      assert.equal(response.status, 200);
      const discovery = await response.json() as { issuer: string; jwks_uri: string };
      assert.equal(discovery.issuer, environment.authIssuer);
      const keys = await fetch(environment.authJwksUri ?? discovery.jwks_uri, { signal: AbortSignal.timeout(8_000) });
      assert.equal(keys.status, 200);
      assert.ok(((await keys.json()) as { keys: unknown[] }).keys.length > 0);
      return 'Discovery/JWKS only; real-user login and membership are not verified';
    });
  }
  if (live) {
    await check('Live Groq classification and summarization', async () => {
      const environment = { ...process.env, APP_ENV: 'development', TICKET_AI_DEMO_ENABLED: 'false', TICKET_AI_LIVE_ENABLED: 'true',
        TICKET_AI_CLASSIFICATION_PROVIDER: 'groq', TICKET_AI_SUMMARIZATION_PROVIDER: 'groq',
        TICKET_AI_CATEGORIES: JSON.stringify([{ id: 'ACCOUNT_ACCESS', name: 'Account access' }]) };
      const configuration = liveTicketAiConfigurationFromEnvironment(environment)!;
      configuration.timeoutMs = Math.min(configuration.timeoutMs, 15_000);
      const ticket = { id: 'synthetic-groq-ticket', organisationId: 'synthetic-org', title: 'Unable to log in', description: 'Account locked after failed login attempts.' };
      const runtime = createLiveTicketAiRuntime({ async getAuthorizedTicket() { return ticket; } }, configuration, environment);
      const result = await runtime.service.analyze({ tenant: { organisationId: ticket.organisationId, userId: 'synthetic-agent', roles: ['support_agent'] }, ticketId: ticket.id, categories: configuration.categories });
      assert.equal(result.classification.category, 'ACCOUNT_ACCESS');
      assert.ok(result.summary.summary.length > 0);
      return 'Synthetic direct-provider test; forced Inception-to-Groq failover remains mocked';
    });
    if (process.env.MISTRAL_API_KEY?.trim()) {
      await check('Live Mistral embedding adapter', async () => {
        const provider = new MistralEmbeddingProvider({ apiKey: process.env.MISTRAL_API_KEY!, model: process.env.MISTRAL_EMBEDDING_MODEL! });
        const vectors = await provider.embed(['Synthetic account lockout runbook verification.'], AbortSignal.timeout(15_000));
        assert.equal(vectors.length, 1);
        assert.ok(vectors[0]!.length > 0 && vectors[0]!.every(Number.isFinite));
        return 'Synthetic input; embeddings discarded, no vector index created';
      });
    } else {
      results.push({ check: 'Live Mistral embedding adapter', status: 'SKIPPED', detail: 'No key configured; adapter remains covered by mocked tests' });
    }
    await check('Integrated HTTP API with live AI and synthetic signed identity', async () => {
      const environment = { ...process.env, APP_ENV: 'development', TICKET_AI_DEMO_ENABLED: 'false', TICKET_AI_LIVE_ENABLED: 'true',
        TICKET_AI_CATEGORIES: JSON.stringify([{ id: 'ACCOUNT_ACCESS', name: 'Account access' }]) };
      const configuration = liveTicketAiConfigurationFromEnvironment(environment)!;
      configuration.timeoutMs = Math.min(configuration.timeoutMs, 15_000);
      configuration.inceptionMaxRetries = Math.min(configuration.inceptionMaxRetries, 1);
      configuration.inceptionBackoffBaseMs = Math.min(configuration.inceptionBackoffBaseMs, 1_000);
      configuration.inceptionBackoffMaxMs = Math.min(configuration.inceptionBackoffMaxMs, 2_000);
      const data = join(root, 'live-http');
      const store = new JsonFileStore(data);
      const now = new Date().toISOString();
      const dates = { createdAt: now, updatedAt: now };
      await store.write('organisations.json', { schemaVersion: 1, records: [{ id: 'synthetic-org', name: 'Synthetic verification', status: 'active', settings: {}, ...dates }] });
      await store.write('users.json', { schemaVersion: 1, records: ['synthetic-admin', 'synthetic-requester'].map(id => ({ id, email: `${id}@example.test`, displayName: id, status: 'active', ...dates })) });
      await store.write('memberships.json', { schemaVersion: 1, records: [
        { id: 'synthetic-admin-membership', organisationId: 'synthetic-org', userId: 'synthetic-admin', status: 'active', roles: ['organisation_admin'], ...dates },
        { id: 'synthetic-requester-membership', organisationId: 'synthetic-org', userId: 'synthetic-requester', status: 'active', roles: ['requester'], ...dates },
      ] });
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const issuer = 'https://synthetic-verification.invalid/realms/support';
      const authenticator = new KeycloakAuthenticationProvider({ issuer, audience: 'support-api', jwksUri: `${issuer}/certs`,
        fetcher: async () => Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'verification', alg: 'RS256', use: 'sig' }] }) });
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'verification' })).toString('base64url');
      function token(user: string) {
        const body = Buffer.from(JSON.stringify({ iss: issuer, aud: 'support-api', typ: 'Bearer', sub: user, exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
        const unsigned = `${header}.${body}`;
        return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
      }
      const candidate = validatePriorityCandidate(JSON.parse(await readFile('data/reference/candidates/priority-policy.json', 'utf8')));
      const server = createIntegratedApp(loadEnvironment({ DATA_DIRECTORY: data, LOG_LEVEL: 'error', PORT: '0' }), { authenticator }, {
        ticketAiDemo: null, ticketAiLive: configuration, priorityPreview: { candidate, minimumConfidence: 0.75 },
        settings: { dataDirectory: data, projectMappings: {}, organisations: {} },
        knowledgeSource: { async listAuthorizedDocuments(tenant) { return tenant.organisationId === 'synthetic-org' ? [{
          id: 'synthetic-runbook', version: '1', organisationId: tenant.organisationId, sourceType: 'knowledge_article',
          title: 'Synthetic account lockout runbook', content: 'For an account locked after failed login attempts: wait 15 minutes before trying to log in again. If the account remains locked, contact the service desk and provide the exact error message.',
          approved: true, status: 'active', effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveTo: null,
        }] : []; } },
      });
      try {
        const url = await listen(server);
        async function request(path: string, method = 'GET', value?: object, expected = 200, user = 'synthetic-admin') {
          const multipart = value instanceof FormData;
          const response = await fetch(url + path, { method, headers: { authorization: `Bearer ${token(user)}`, 'x-organisation-id': 'synthetic-org', ...(multipart ? {} : { 'content-type': 'application/json' }) },
            ...(value ? { body: multipart ? value : JSON.stringify(value) } : {}), signal: AbortSignal.timeout(55_000) });
          assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, got ${response.status}`);
          return response.json();
        }
        await request('/api/v1/me');
        const { data: ticket } = await request('/api/v1/tickets', 'POST', {
          title: 'Account locked after failed login attempts', description: 'My account is locked. I reset my password twice and still cannot log in. Only my account is affected. I cannot work and have no workaround. I need access within one hour.',
        }, 201, 'synthetic-requester');
        const originalTickets = await readFile(join(data, 'tickets.json'), 'utf8');
        const { data: analysis } = await request(`/api/v1/tickets/${ticket.id}/analyze`, 'POST', {});
        assert.equal(analysis.classification.category, 'ACCOUNT_ACCESS');
        assert.ok(analysis.summary.summary.length > 0);
        assert.equal((await request(`/api/v1/tickets/${ticket.id}/analyses`)).data.length, 1);
        console.log(JSON.stringify({ check: 'Live HTTP classification, summary and persisted history', status: 'PASS' }));
        await check('Live HTTP priority output validation', async () => {
          const { data: priority } = await request(`/api/v1/tickets/${ticket.id}/recommend-priority`, 'POST', {});
          assert.ok(['recommendation', 'insufficient_information'].includes(priority.status));
          assert.equal(priority.requiresHumanReview, true);
          return `status=${priority.status}; priority=${priority.priority}`;
        });
        assert.ok((await request(`/api/v1/tickets/${ticket.id}/evidence`)).data.length > 0);
        const { data: resolution } = await request(`/api/v1/tickets/${ticket.id}/recommend-resolution`, 'POST', {});
        assert.equal(resolution.requiresHumanReview, true);
        assert.ok(['recommendation', 'insufficient_evidence'].includes(resolution.status));
        assert.equal(await readFile(join(data, 'tickets.json'), 'utf8'), originalTickets);
        console.log(JSON.stringify({ check: 'Live HTTP resolution citations and unchanged ticket', status: 'PASS', recommendationStatus: resolution.status, stepCount: resolution.steps.length }));
        for (const [fileName, mimeType, content] of [
          ['policy.pdf', 'application/pdf', policyPdf()],
          ['policy.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', policyDocx()],
        ] as const) {
          const upload = new FormData();
          upload.append('title', 'Synthetic response policy');
          upload.append('file', new Blob([new Uint8Array(content)], { type: mimeType }), fileName);
          const { data: uploaded } = await request('/api/v1/documents', 'POST', upload, 201);
          const { data: processed } = await request(`/api/v1/documents/${uploaded.document.id}/process`, 'POST', {});
          assert.equal(processed.extraction.result.executionMetadata.provider, 'local-provisional');
          assert.equal(processed.extraction.result.rules[0].payload.targetHours, 2);
        }
        console.log(JSON.stringify({ check: 'HTTP PDF/DOCX processing', status: 'PASS', detail: 'Local text conversion and provisional regex extraction; no document LLM' }));
        await request('/api/v1/extracted-rules/synthetic-rule/approve', 'POST', { reason: 'Synthetic probe' }, 404);
        const candidateReview = { check: 'Candidate-review integration', status: 'BLOCKED', detail: 'Source audit found no main-server mounting of standalone candidate-review routes; missing-rule probe returns 404 (not proof of mounting by itself)' };
        results.push(candidateReview);
        console.log(JSON.stringify(candidateReview));
        return 'Synthetic identity; real providers; isolated temporary storage; real-user login remains separate';
      } finally { await close(server); }
    });
  }
} finally {
  clearTimeout(deadline);
  // Only delete the fresh directory created by this script under the known workspace root.
  if (dirname(root) !== localRoot || !root.startsWith(join(localRoot, 'verification-'))) throw new Error('Unexpected verification directory.');
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ results, liveRequested: live, documentLlmImplemented: true, documentLlmDefaultWired: false, candidateReviewMounted: false,
  langGraphInstalled, note: 'Core analysis uses LangGraph. The AI extraction adapter exists; default document wiring, teammate data adapters and real-user onboarding remain separate integration work.' }, null, 2));
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
