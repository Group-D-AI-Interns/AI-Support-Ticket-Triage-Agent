import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createIntegratedApp } from '../src/integrated-app.js';
import { loadEnvironment } from '../src/config/env.js';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';
import { KeycloakAuthenticationProvider } from '../src/infrastructure/auth/keycloak-authentication.js';
import { validatePriorityCandidate } from '../src/modules/ai/components/priority-matrix.js';

// Explicit offline demonstration. Never used by normal application startup.
const port = Number(process.env.DEMO_PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DEMO_PORT.');
const root = resolve('.local-data', `demo-${Date.now()}`);
const store = new JsonFileStore(root);
const now = new Date().toISOString();
const dates = { createdAt: now, updatedAt: now };
await store.write('organisations.json', { schemaVersion: 1, records: [{ id: 'org_demo', name: 'Demo Support', status: 'active', settings: {}, ...dates }] });
await store.write('users.json', { schemaVersion: 1, records: [{ id: 'demo_admin', email: 'admin@example.test', displayName: 'Demo Administrator', status: 'active', ...dates }] });
await store.write('memberships.json', { schemaVersion: 1, records: [{ id: 'demo_membership', userId: 'demo_admin', organisationId: 'org_demo', status: 'active', roles: ['organisation_admin', 'requester'], ...dates }] });
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://offline-demo.invalid/realms/support';
const authenticator = new KeycloakAuthenticationProvider({ issuer, audience: 'support-api', jwksUri: `${issuer}/certs`,
  fetcher: async () => Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'demo', alg: 'RS256', use: 'sig' }] }),
});
const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'demo' })).toString('base64url');
const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: 'support-api', typ: 'Bearer', sub: 'demo_admin', exp: Math.floor(Date.now() / 1000) + 8 * 3600 })).toString('base64url');
const input = `${head}.${claims}`;
const token = `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
const baseUrl = `http://127.0.0.1:${port}`;
const priorityCandidate = validatePriorityCandidate(JSON.parse(await readFile(resolve('data/reference/candidates/priority-policy.json'), 'utf8')));
const app = createIntegratedApp(loadEnvironment({ DATA_DIRECTORY: root, PORT: String(port), LOG_LEVEL: 'error' }), { authenticator }, {
  priorityPreview: { candidate: priorityCandidate, minimumConfidence: 0.75 }, // Synthetic demo setting only, not calibrated policy.
  settings: { dataDirectory: root, projectMappings: {}, organisations: {} },
  ticketAiDemo: { categories: [{ id: 'ACCOUNT_ACCESS', name: 'Account access', description: 'Login and password reset issues' }, { id: 'BILLING', name: 'Billing', description: 'Invoices and payments' }] }, ticketAiLive: null,
});
app.on('error', (error) => { console.error('Cannot start demo:', error.message); process.exitCode = 1; });
await new Promise<void>((done, fail) => { app.once('error', fail); app.listen(port, '127.0.0.1', done); });
async function request(path: string, method = 'GET', body?: unknown) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'X-Organisation-ID': 'org_demo' };
  let payload: string | FormData | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result.error)}`);
  console.log(`${method} ${path} -> ${response.status}`);
  return result.data;
}
try {
  await request('/api/v1/me');
  await request('/api/v1/teams', 'POST', { name: 'Support Desk' });
  const ticket = await request('/api/v1/tickets', 'POST', { title: 'Unable to access my account', description: 'My account is locked. I reset my password twice but still cannot log in.' });
  const analysis = await request(`/api/v1/tickets/${ticket.id}/analyze`, 'POST', {});
  console.log(`Classification: ${analysis.classification.category}; review required: ${analysis.classification.requiresHumanReview}`);
  console.log(`Summary: ${analysis.summary.summary}`);
  const priorityPreview = await request(`/api/v1/tickets/${ticket.id}/recommend-priority`, 'POST', {});
  console.log(`Draft priority preview: ${priorityPreview.status}; priority: ${priorityPreview.priority}. Demo does not infer factors.`);
  const form = new FormData();
  form.append('title', 'Synthetic demo SLA');
  form.append('file', new Blob(['Respond within two hours.'], { type: 'text/plain' }), 'demo-policy.txt');
  const source = await request('/api/v1/documents', 'POST', form);
  await request(`/api/v1/documents/${source.document.id}/process`, 'POST', {});
  const payload = { calendar: { timeZone: 'Africa/Johannesburg', weeklySchedule: Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(day => [day, [{ startMinute: 0, endMinute: 1440 }]])), holidays: [] }, targetsByPriority: { high: { firstResponseMinutes: 120, resolutionMinutes: 480 } }, pausedStatuses: ['PENDING'], resolvedStatuses: ['RESOLVED', 'CLOSED'], riskAtPercent: 75 };
  const policy = await request('/api/v1/sla-policies', 'POST', { description: 'Synthetic demonstration targets only', sourceDocumentId: source.document.id, sourceDocumentVersionId: source.version.id, effectiveFrom: '2020-01-01T00:00:00.000Z', payload });
  const path = `/api/v1/sla-policies/${policy.policy.id}/versions/${policy.version.id}`;
  await request(`${path}/approve`, 'POST', { reason: 'Explicit local demo administrator approval' });
  await request(`${path}/activate`, 'POST', {});
  await request(`/api/v1/tickets/${ticket.id}`, 'PATCH', {
    priority: 'P2',
    priorityOverride: {
      reason: 'Synthetic local demo priority review.',
      businessJustification: 'The requester is unable to access their account.',
    },
  });
  await request('/api/v1/sla/evaluations/run', 'POST', {});
  const report = await request('/api/v1/reports?from=2020-01-01T00:00:00.000Z&to=2099-01-01T00:00:00.000Z');
  console.log('Report:', JSON.stringify(report, null, 2));
  await mkdir(resolve('.local-data'), { recursive: true });
  await writeFile(resolve('.local-data/demo-session.json'), JSON.stringify({ baseUrl, token, organisationId: 'org_demo', ticketId: ticket.id, dataDirectory: root }, null, 2), { mode: 0o600 });
  console.log(`\nOFFLINE DEMO running at ${baseUrl}. No external AI calls or real Keycloak login.`);
  console.log(`Data: ${root}\nExplore: run ./scripts/explore-demo.ps1 from backend/. Token expires in 8 hours.`);
} catch (error) {
  app.closeAllConnections(); app.close();
  throw error;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { app.closeAllConnections(); app.close(); });
