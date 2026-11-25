import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createTicketApp } from '../src/modules/tickets/api.js';
import type { DevelopmentPrincipal } from '../src/modules/tickets/development-auth.js';
import { JsonTicketStore } from '../src/modules/tickets/repositories/json-ticket.store.js';
import { ticketAiDemoConfigurationFromEnvironment } from '../src/modules/ai/local-demo-runtime.js';

const categories = [
  {
    id: 'ACCOUNT_ACCESS',
    name: 'Account access',
    description: 'Login, password reset, and account lockout issues.',
  },
  {
    id: 'BILLING',
    name: 'Billing',
    description: 'Invoices and payment issues.',
  },
];

function makePrincipal(
  organisationId: string,
  userId: string,
  roles: string[] = ['requester'],
): DevelopmentPrincipal {
  return {
    bearerToken: `${organisationId}-${userId}-token-with-at-least-32-characters`,
    organisationId,
    userId,
    roles,
    teamIds: [],
  };
}

async function createFixture(
  principal: DevelopmentPrincipal,
  root?: string,
  enableAi = true,
) {
  const dataDirectory = root ?? (await mkdtemp(join(tmpdir(), 'ticket-ai-api-')));
  const app = createTicketApp({
    dataDirectory,
    ticketStore: new JsonTicketStore(dataDirectory),
    developmentPrincipal: principal,
    ...(enableAi ? { ticketAiDemo: { categories } } : {}),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  let closed = false;

  return {
    root: dataDirectory,
    request(path: string, init: RequestInit = {}, token: string | null = principal.bearerToken) {
      const headers = new Headers(init.headers);
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      if (init.body !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers });
    },
    async close(removeRoot = true) {
      if (!closed) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        closed = true;
      }
      if (removeRoot) {
        await rm(dataDirectory, { recursive: true, force: true });
      }
    },
  };
}

test('analyzes an authorized ticket end-to-end and keeps the ticket unchanged', async () => {
  const fixture = await createFixture(makePrincipal('org_support', 'user-requester'));
  let analyst: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const createResponse = await fixture.request('/api/v1/tickets', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Unable to access my account',
        description: 'The account is locked after I reset my password twice.',
      }),
    });
    const created = await createResponse.json();
    assert.equal(createResponse.status, 201);
    await fixture.close(false);
    analyst = await createFixture(
      makePrincipal('org_support', 'user-analyst', ['organisation_admin']),
      fixture.root,
    );

    const beforeResponse = await analyst.request(`/api/v1/tickets/${created.data.id}`);
    const before = await beforeResponse.json();
    const analysisResponse = await analyst.request(
      `/api/v1/tickets/${created.data.id}/analyze`,
      { method: 'POST', body: '{}' },
    );
    const analysisEnvelope = await analysisResponse.json();

    assert.equal(analysisResponse.status, 200);
    assert.equal(analysisEnvelope.data.ticketId, created.data.id);
    assert.equal(analysisEnvelope.data.organisationId, 'org_support');
    assert.ok(analysisEnvelope.data.classification.categories.includes('ACCOUNT_ACCESS'));
    assert.ok(analysisEnvelope.data.classification.evidence.length > 0);
    assert.equal(analysisEnvelope.data.classification.confidence, null);
    assert.equal(analysisEnvelope.data.classification.requiresHumanReview, true);
    assert.ok(
      analysisEnvelope.data.classification.warnings.some((warning: string) =>
        warning.startsWith('DEMO_ONLY:'),
      ),
    );
    assert.match(analysisEnvelope.data.summary.summary, /account is locked/i);
    assert.equal(analysisEnvelope.data.summary.affectedFunctionality, null);
    assert.equal(analysisEnvelope.data.executions.length, 2);
    assert.ok(
      analysisEnvelope.data.executions.every(
        (execution: { provider: string }) => execution.provider === 'local-demo-heuristic',
      ),
    );

    const historyResponse = await analyst.request(
      `/api/v1/tickets/${created.data.id}/analyses`,
    );
    const history = await historyResponse.json();
    const afterResponse = await analyst.request(`/api/v1/tickets/${created.data.id}`);
    const after = await afterResponse.json();

    assert.equal(historyResponse.status, 200);
    assert.equal(history.data.length, 1);
    assert.equal(after.data.title, before.data.title);
    assert.equal(after.data.description, before.data.description);
    assert.equal(after.data.status, before.data.status);
    assert.equal(after.data.updatedAt, before.data.updatedAt);
  } finally {
    if (analyst) {
      await analyst.close();
      await fixture.close();
    } else {
      await fixture.close();
    }
  }
});

test('does not expose ticket analysis to another requester or tenant', async () => {
  const owner = await createFixture(makePrincipal('org_support', 'user-owner'));
  let otherRequester: Awaited<ReturnType<typeof createFixture>> | undefined;
  let otherTenant: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const createResponse = await owner.request('/api/v1/tickets', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Private account issue',
        description: 'The account cannot be accessed.',
      }),
    });
    const created = await createResponse.json();
    assert.equal(createResponse.status, 201);
    await owner.close(false);

    otherRequester = await createFixture(
      makePrincipal('org_support', 'user-other'),
      owner.root,
    );
    const sameTenantResponse = await otherRequester.request(
      `/api/v1/tickets/${created.data.id}/analyze`,
      { method: 'POST', body: '{}' },
    );
    assert.equal(sameTenantResponse.status, 403);

    otherTenant = await createFixture(
      makePrincipal('org_other', 'user-other-tenant', ['organisation_admin']),
      owner.root,
    );
    const crossTenantResponse = await otherTenant.request(
      `/api/v1/tickets/${created.data.id}/analyze`,
      { method: 'POST', body: '{}' },
    );
    assert.equal(crossTenantResponse.status, 404);
  } finally {
    if (otherRequester) {
      await otherRequester.close(false);
    }
    if (otherTenant) {
      await otherTenant.close();
    } else {
      await rm(owner.root, { recursive: true, force: true });
    }
  }
});

test('requires authentication and keeps the demo disabled by default', async () => {
  const fixture = await createFixture(makePrincipal('org_support', 'user-requester', ['support_agent']), undefined, false);
  try {
    const unauthenticated = await fixture.request(
      '/api/v1/tickets/ticket_missing/analyze',
      { method: 'POST', body: '{}' },
      null,
    );
    assert.equal(unauthenticated.status, 401);

    const disabled = await fixture.request(
      '/api/v1/tickets/ticket_missing/analyze',
      { method: 'POST', body: '{}' },
    );
    const result = await disabled.json();
    assert.equal(disabled.status, 503);
    assert.equal(result.error.code, 'TICKET_AI_NOT_CONFIGURED');
  } finally {
    await fixture.close();
  }
});

test('enables demo configuration only in development and validates its categories', () => {
  const rawCategories = JSON.stringify(categories);
  assert.throws(
    () =>
      ticketAiDemoConfigurationFromEnvironment({
        APP_ENV: 'production',
        TICKET_AI_DEMO_ENABLED: 'true',
        TICKET_AI_CATEGORIES: rawCategories,
      }),
    /only when APP_ENV=development/,
  );
  assert.deepEqual(
    ticketAiDemoConfigurationFromEnvironment({
      APP_ENV: 'development',
      TICKET_AI_DEMO_ENABLED: 'true',
      TICKET_AI_CATEGORIES: rawCategories,
    }),
    { categories },
  );
  assert.throws(
    () =>
      ticketAiDemoConfigurationFromEnvironment({
        APP_ENV: 'development',
        TICKET_AI_DEMO_ENABLED: 'true',
        TICKET_AI_CATEGORIES: '{"id":"not-an-array"}',
      }),
    /must be a JSON array/,
  );
});
