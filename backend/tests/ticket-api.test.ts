import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DevelopmentPrincipal, TicketRole } from '../src/modules/tickets/development-auth.js';
import type { JiraSettings } from '../src/modules/tickets/jira-config.js';
import { createTicketApi } from '../src/modules/tickets/ticket-api.js';
import { TicketJsonStore } from '../src/modules/tickets/ticket-json-store.js';

const staffToken = 'local-support-lead-token-long-enough-for-tests';
const requesterToken = 'local-requester-token-long-enough-for-tests';
const webhookSecret = 'local-jira-webhook-secret-long-enough-for-tests';

const settings: JiraSettings = {
  projectMappings: new Map([['SUP', 'org-support']]),
  organisations: new Map([[
    'org-support',
    {
      webhookSecret,
      reporterMappings: new Map([['jira-account-1', 'user-requester']]),
    },
  ]]),
};

function principal(
  token: string,
  userId: string,
  roles: TicketRole[],
  organisationId = 'org-support',
  teamIds: string[] = [],
): DevelopmentPrincipal {
  return {
    bearerToken: token,
    organisationId,
    userId,
    roles: new Set(roles),
    teamIds: new Set(teamIds),
  };
}

async function withApi<T>(
  principalValue: DevelopmentPrincipal | null,
  run: (baseUrl: string, store: TicketJsonStore) => Promise<T>,
  sharedStore?: TicketJsonStore,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'ticket-api-'));
  const store = sharedStore ?? new TicketJsonStore(directory);
  const server: Server = createServer(createTicketApi({
    store,
    jiraSettings: settings,
    developmentPrincipal: principalValue,
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port.');
  }

  try {
    return await run(`http://127.0.0.1:${address.port}`, store);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  }
}

function authorization(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

test('preserves ticket creation, filtering, updates, comments, audit, and team access', async () => {
  await withApi(
    principal(staffToken, 'user-lead', ['support_lead'], 'org-support', ['team-support']),
    async (baseUrl, store) => {
      const createdResponse = await fetch(`${baseUrl}/api/v1/tickets`, {
        method: 'POST',
        headers: { ...authorization(staffToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Unable to sign in',
          description: '  Password reset did not unlock the account.  ',
        }),
      });
      assert.equal(createdResponse.status, 201);
      assert.ok(createdResponse.headers.get('x-request-id'));
      const createdBody = await createdResponse.json() as { data: Record<string, unknown> };
      const ticketId = String(createdBody.data.id);
      assert.equal(createdBody.data.organisationId, 'org-support');
      assert.equal(createdBody.data.requesterId, 'user-lead');
      assert.equal(createdBody.data.status, 'new');
      assert.equal(createdBody.data.product, null);
      assert.equal(createdBody.data.description, '  Password reset did not unlock the account.  ');

      const invalid = await fetch(`${baseUrl}/api/v1/tickets`, {
        method: 'POST',
        headers: { ...authorization(staffToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Invalid tenant override',
          description: 'Should be rejected.',
          organisationId: 'org-other',
        }),
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR');

      const forbiddenAssignment = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}`, {
        method: 'PATCH',
        headers: { ...authorization(staffToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: 'team-other' }),
      });
      assert.equal(forbiddenAssignment.status, 403);
      assert.equal(
        (await forbiddenAssignment.json() as { error: { code: string } }).error.code,
        'TEAM_SCOPE_FORBIDDEN',
      );

      const emptyTeamAssignment = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}`, {
        method: 'PATCH',
        headers: { ...authorization(staffToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: '' }),
      });
      assert.equal(emptyTeamAssignment.status, 403);
      assert.equal(
        (await emptyTeamAssignment.json() as { error: { code: string } }).error.code,
        'TEAM_SCOPE_FORBIDDEN',
      );

      const nullTitle = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}`, {
        method: 'PATCH',
        headers: { ...authorization(staffToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: null }),
      });
      assert.equal(nullTitle.status, 400);

      const assigned = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}`, {
        method: 'PATCH',
        headers: { ...authorization(staffToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Sign-in still failing', teamId: 'team-support' }),
      });
      assert.equal(assigned.status, 200);

      for (const visibility of ['internal', 'public']) {
        const comment = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}/comments`, {
          method: 'POST',
          headers: { ...authorization(staffToken), 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: `${visibility} note`, visibility }),
        });
        assert.equal(comment.status, 201);
      }

      const detail = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}`, {
        headers: authorization(staffToken),
      });
      const detailBody = await detail.json() as {
        data: { title: string; comments: Array<{ visibility: string }>; history?: unknown };
      };
      assert.equal(detail.status, 200);
      assert.equal(detailBody.data.title, 'Sign-in still failing');
      assert.equal(detailBody.data.comments.length, 2);
      assert.equal('history' in detailBody.data, false);

      const page = await fetch(
        `${baseUrl}/api/v1/tickets?q=sign-in&status=new&limit=1&offset=0`,
        { headers: authorization(staffToken) },
      );
      const pageBody = await page.json() as {
        data: unknown[];
        pagination: { limit: number; offset: number; total: number };
      };
      assert.equal(page.status, 200);
      assert.deepEqual(pageBody.pagination, { limit: 1, offset: 0, total: 1 });
      assert.equal(pageBody.data.length, 1);

      const emptyStatus = await fetch(
        `${baseUrl}/api/v1/tickets?status=`,
        { headers: authorization(staffToken) },
      );
      assert.equal(
        (await emptyStatus.json() as { pagination: { total: number } }).pagination.total,
        0,
      );

      const audit = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}/audit`, {
        headers: authorization(staffToken),
      });
      const auditBody = await audit.json() as { data: Array<{ action: string }> };
      assert.equal(audit.status, 200);
      assert.equal(auditBody.data.at(-1)?.action, 'ticket.comment_added');

      const requesterAccess = await withApi(
        principal(requesterToken, 'user-lead', ['requester'], 'org-support', ['team-support']),
        async (requesterUrl) => {
          const visible = await fetch(`${requesterUrl}/api/v1/tickets/${ticketId}`, {
            headers: authorization(requesterToken),
          });
          const visibleBody = await visible.json() as {
            data: { comments: Array<{ visibility: string }> };
          };
          assert.equal(visible.status, 200);
          assert.deepEqual(visibleBody.data.comments.map((comment) => comment.visibility), ['public']);

          const internalComment = await fetch(
            `${requesterUrl}/api/v1/tickets/${ticketId}/comments`,
            {
              method: 'POST',
              headers: { ...authorization(requesterToken), 'Content-Type': 'application/json' },
              body: JSON.stringify({ body: 'Not allowed', visibility: 'internal' }),
            },
          );
          assert.equal(internalComment.status, 403);

          const audit = await fetch(`${requesterUrl}/api/v1/tickets/${ticketId}/audit`, {
            headers: authorization(requesterToken),
          });
          assert.equal(audit.status, 403);
          return visible.status;
        },
        store,
      );
      assert.equal(requesterAccess, 200);
    },
  );
});

test('hides another tenant ticket and fails closed when development auth is absent', async () => {
  await withApi(
    principal(staffToken, 'user-lead', ['support_lead'], 'org-support', ['team-support']),
    async (baseUrl, store) => {
      const created = await store.createTicket({
        organisationId: 'org-support',
        requesterId: 'user-lead',
        title: 'Tenant scoped',
        description: 'Private ticket.',
        status: 'new',
      }, 'user-lead');

      const otherTenant = await withApi(
        principal(requesterToken, 'user-other', ['requester'], 'org-other'),
        async (otherUrl) => fetch(`${otherUrl}/api/v1/tickets/${created.id}`, {
          headers: authorization(requesterToken),
        }),
        store,
      );
      assert.equal(otherTenant.status, 404);

      const unauthenticated = await withApi(null, async (url) => {
        const response = await fetch(`${url}/api/v1/tickets`);
        return {
          status: response.status,
          body: await response.json() as { error: { code: string } },
        };
      });
      assert.equal(unauthenticated.status, 503);
      assert.equal(unauthenticated.body.error.code, 'AUTHENTICATION_NOT_CONFIGURED');

      const invalidToken = await fetch(`${baseUrl}/api/v1/tickets`, {
        headers: authorization('wrong-token'),
      });
      assert.equal(invalidToken.status, 401);
    },
  );
});

test('Jira ingestion maps trusted tenant and reporter, preserves source fields, and is idempotent', async () => {
  await withApi(
    null,
    async (baseUrl) => {
      const path = `/api/v1/tickets/ingest/jira/${webhookSecret}`;
      const payload = {
        webhookEvent: 'jira:issue_created',
        organisationId: 'org-attacker',
        issue: {
          id: '1001',
          key: 'SUP-1',
          fields: {
            project: { key: 'SUP' },
            summary: 'Jira account issue',
            description: {
              type: 'doc',
              content: [{ type: 'paragraph', text: 'Account locked.' }],
            },
            reporter: { accountId: 'jira-account-1' },
            status: { name: 'Open' },
            priority: { name: 'High' },
          },
        },
      };

      const created = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const createdBody = await created.json() as {
        data: { id: string; outcome: string; sourceIssueKey: string };
      };
      assert.equal(created.status, 201);
      assert.equal(createdBody.data.outcome, 'created');
      assert.equal(createdBody.data.sourceIssueKey, 'SUP-1');

      const duplicate = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(duplicate.status, 200);
      assert.equal(
        (await duplicate.json() as { data: { outcome: string } }).data.outcome,
        'duplicate',
      );
    },
  );
});

test('rejects invalid Jira secrets and unsupported events', async () => {
  await withApi(null, async (baseUrl) => {
    const body = {
      webhookEvent: 'jira:issue_deleted',
      issue: {
        id: '1001',
        key: 'SUP-1',
        fields: {
          project: { key: 'SUP' },
          summary: 'Deleted issue',
          reporter: { accountId: 'jira-account-1' },
        },
      },
    };
    const invalidSecret = await fetch(
      `${baseUrl}/api/v1/tickets/ingest/jira/${'x'.repeat(webhookSecret.length)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    assert.equal(invalidSecret.status, 401);

    const unsupportedEvent = await fetch(
      `${baseUrl}/api/v1/tickets/ingest/jira/${webhookSecret}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    assert.equal(unsupportedEvent.status, 400);
    assert.equal(
      (await unsupportedEvent.json() as { error: { code: string } }).error.code,
      'UNSUPPORTED_JIRA_EVENT',
    );
  });
});

test('development principal configuration is environment-gated and validates values', async () => {
  const { loadDevelopmentPrincipal } = await import('../src/modules/tickets/development-auth.js');

  assert.throws(
    () => loadDevelopmentPrincipal({
      APP_ENV: 'production',
      TICKET_DEV_PRINCIPAL: JSON.stringify({
        bearerToken: staffToken,
        organisationId: 'org-support',
        userId: 'user-lead',
        roles: ['support_lead'],
      }),
    }),
    /only when APP_ENV=development/,
  );

  const configured = loadDevelopmentPrincipal({
    APP_ENV: 'development',
    TICKET_DEV_PRINCIPAL: JSON.stringify({
      bearerToken: staffToken,
      organisationId: 'org-support',
      userId: 'user-lead',
      roles: ['support_lead'],
      teamIds: ['team-support'],
    }),
  });
  assert.ok(configured?.roles.has('support_lead'));
  assert.ok(configured?.teamIds.has('team-support'));
});

