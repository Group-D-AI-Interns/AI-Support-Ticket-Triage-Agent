import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createTicketApp } from '../src/modules/tickets/api.js';
import {
  ConfigurationError,
  jiraSettingsFromEnvironment,
  type JiraSettings,
} from '../src/modules/tickets/config.js';
import {
  developmentPrincipalFromEnvironment,
  DevelopmentAuthConfigurationError,
  type DevelopmentPrincipal,
} from '../src/modules/tickets/development-auth.js';
import { createLocalPrivateStorageAdapter } from '../src/modules/documents/storage/document-storage.js';
import { JsonTicketStore } from '../src/modules/tickets/repositories/json-ticket.store.js';

const JIRA_SECRET = 'local-test-secret-with-at-least-32-characters';
const DEV_TOKEN = 'local-development-token-with-at-least-32-characters';
const jiraPath = `/api/v1/tickets/ingest/jira/${JIRA_SECRET}`;

const settings: JiraSettings = {
  dataDirectory: '',
  projectMappings: { SUP: 'org_support' },
  organisations: {
    org_support: {
      webhookSecret: JIRA_SECRET,
      reporterMappings: { 'jira-account-1': 'user_requester_1' },
    },
  },
};

const staffPrincipal: DevelopmentPrincipal = {
  bearerToken: DEV_TOKEN,
  organisationId: 'org_support',
  userId: 'user_requester_1',
  roles: ['requester', 'support_lead'],
  teamIds: ['team_support'],
};

const workflowConfig = {
  sourceReference: 'Tenant Ticket Workflow Policy v1',
  initialStatus: 'NEW',
  reopenStatus: 'REOPENED',
  statuses: [
    'NEW',
    'OPEN',
    'IN_PROGRESS',
    'PENDING',
    'RESOLVED',
    'CLOSED',
    'REOPENED',
  ],
  transitions: {
    NEW: ['OPEN'],
    OPEN: ['IN_PROGRESS', 'PENDING', 'RESOLVED'],
    IN_PROGRESS: ['PENDING', 'RESOLVED', 'OPEN'],
    PENDING: ['IN_PROGRESS', 'OPEN'],
    RESOLVED: ['CLOSED', 'REOPENED'],
    CLOSED: ['REOPENED'],
    REOPENED: ['OPEN', 'IN_PROGRESS'],
  },
  requestableReopenFrom: ['RESOLVED'],
  restrictedReopenFrom: ['CLOSED'],
  permissions: {
    directStatusChangeRoles: ['support_agent', 'support_lead'],
    closedReopenRoles: ['support_lead', 'organisation_admin'],
    reopenRequestRoles: ['requester'],
    reopenApprovalRoles: ['support_lead', 'organisation_admin'],
    administratorOverrideRoles: ['organisation_admin'],
  },
};

function principal(
  userId: string,
  roles: string[],
): DevelopmentPrincipal {
  return {
    bearerToken: `${userId}-token-with-at-least-32-characters`,
    organisationId: 'org_support',
    userId,
    roles,
    teamIds: ['team_support'],
  };
}

function jiraPayload(
  webhookEvent = 'jira:issue_created',
  issueId = '10042',
  issueKey = 'SUP-42',
) {
  return {
    webhookEvent,
    issue: {
      id: issueId,
      key: issueKey,
      fields: {
        project: { key: 'SUP' },
        summary: 'Jira imported ticket',
        description: {
          type: 'doc',
          content: [{ type: 'paragraph', text: 'Imported from Jira' }],
        },
        reporter: { accountId: 'jira-account-1' },
        status: { name: 'Open' },
        priority: { name: 'High' },
      },
    },
  };
}

async function createFixture(options: {
  root?: string;
  principal?: DevelopmentPrincipal | null;
} = {}) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'ticket-api-')));
  const fixtureSettings = { ...settings, dataDirectory: root };
  const app = createTicketApp({
    settings: fixtureSettings,
    ticketStore: new JsonTicketStore(root),
    developmentPrincipal:
      options.principal === undefined ? staffPrincipal : options.principal,
  });
  const defaultToken =
    options.principal === undefined
      ? staffPrincipal.bearerToken
      : options.principal?.bearerToken ?? null;
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  let closed = false;

  return {
    root,
    url: `http://127.0.0.1:${address.port}`,
    async close(removeRoot = true) {
      if (!closed) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        closed = true;
      }
      if (removeRoot) {
        await rm(root, { recursive: true, force: true });
      }
    },
    request(
      path: string,
      init: RequestInit = {},
      token: string | null = defaultToken,
    ) {
      const headers = new Headers(init.headers);
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      if (
        init.body !== undefined &&
        !(init.body instanceof FormData) &&
        !headers.has('content-type')
      ) {
        headers.set('content-type', 'application/json');
      }
      return fetch(`${`http://127.0.0.1:${address.port}`}${path}`, {
        ...init,
        headers,
      });
    },
  };
}

test('creates tickets using the authenticated tenant and stores the existing JSON format', async () => {
  const fixture = await createFixture();
  try {
    const response = await fixture.request('/api/v1/tickets', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Unable to sign in',
        description: 'The sign-in page returns an error.',
        product: 'Customer Portal',
        affectedService: 'Authentication',
        organisationId: 'org_attacker',
      }),
    });
    const result = await response.json();

    assert.equal(response.status, 400);
    assert.equal(result.error.code, 'VALIDATION_ERROR');

    const created = await fixture.request('/api/v1/tickets', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Unable to sign in',
        description: 'The sign-in page returns an error.',
        product: 'Customer Portal',
        affectedService: 'Authentication',
      }),
    });
    const createdResult = await created.json();
    const saved = JSON.parse(
      await readFile(join(fixture.root, 'tickets.json'), 'utf8'),
    );

    assert.equal(created.status, 201);
    assert.equal(created.headers.get('x-request-id'), createdResult.requestId);
    assert.equal(createdResult.data.organisationId, 'org_support');
    assert.equal(createdResult.data.requesterId, 'user_requester_1');
    assert.equal(createdResult.data.status, 'new');
    assert.equal(createdResult.data.product, 'Customer Portal');
    assert.equal(createdResult.data.createdAt, createdResult.data.updatedAt);
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.records.length, 1);
  } finally {
    await fixture.close();
  }
});

test('ticket workflow drafts require organisation-admin approval and stay tenant-scoped', async () => {
  const admin = await createFixture({
    principal: principal('user_admin', ['organisation_admin', 'requester']),
  });
  let otherTenantAdmin: Awaited<ReturnType<typeof createFixture>> | undefined;
  let supportFixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const invalidConfig = {
      ...workflowConfig,
      transitions: {
        ...workflowConfig.transitions,
        NEW: ['MISSING_STATUS'],
      },
    };
    const invalidDraft = await admin.request('/api/v1/ticket-workflows', {
      method: 'POST',
      body: JSON.stringify({ config: invalidConfig }),
    });
    assert.equal(invalidDraft.status, 400);
    assert.equal((await invalidDraft.json()).error.code, 'VALIDATION_ERROR');

    const draftResponse = await admin.request('/api/v1/ticket-workflows', {
      method: 'POST',
      body: JSON.stringify({ config: workflowConfig }),
    });
    const draftResult = await draftResponse.json();
    const workflowId = draftResult.data.id as string;
    assert.equal(draftResponse.status, 201);
    assert.equal(draftResult.data.status, 'draft');
    assert.equal(draftResult.data.initialStatus, 'NEW');

    const createdBeforeApproval = await admin.request('/api/v1/tickets', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Ticket before workflow approval',
        description: 'The draft must not affect ticket behavior.',
      }),
    });
    const preApprovalTicket = (await createdBeforeApproval.json()).data;
    const blockedTransition = await admin.request(
      `/api/v1/tickets/${preApprovalTicket.id}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'OPEN' }),
      },
    );
    assert.equal(blockedTransition.status, 409);
    assert.equal(
      (await blockedTransition.json()).error.code,
      'WORKFLOW_NOT_ACTIVE',
    );

    otherTenantAdmin = await createFixture({
      root: admin.root,
      principal: {
        ...principal('user_other_admin', ['organisation_admin']),
        organisationId: 'org_other',
      },
    });
    const hidden = await otherTenantAdmin.request('/api/v1/ticket-workflows');
    assert.equal((await hidden.json()).data.length, 0);

    supportFixture = await createFixture({
      root: admin.root,
      principal: staffPrincipal,
    });
    const blockedApproval = await supportFixture.request(
      `/api/v1/ticket-workflows/${workflowId}/approve`,
      { method: 'POST' },
    );
    assert.equal(blockedApproval.status, 403);

    const approved = await admin.request(
      `/api/v1/ticket-workflows/${workflowId}/approve`,
      { method: 'POST' },
    );
    const approvedResult = await approved.json();
    assert.equal(approved.status, 200);
    assert.equal(approvedResult.data.status, 'active');
    assert.equal(approvedResult.data.approvedBy, 'user_admin');

    const transitionAfterApproval = await admin.request(
      `/api/v1/tickets/${preApprovalTicket.id}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'OPEN' }),
      },
    );
    assert.equal(transitionAfterApproval.status, 200);
    assert.equal((await transitionAfterApproval.json()).data.status, 'OPEN');
  } finally {
    if (otherTenantAdmin) {
      await otherTenantAdmin.close(false);
    }
    if (supportFixture) {
      await supportFixture.close(false);
    }
    await admin.close();
  }
});

test('enforces tenant workflow transitions, reopening approval, role limits, and audit', async () => {
  const rootFixture = await createFixture({
    principal: principal('user_admin', ['organisation_admin']),
  });
  let requesterFixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  let agentFixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  let supervisorFixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const workflowResponse = await rootFixture.request(
      '/api/v1/ticket-workflows',
      {
        method: 'POST',
        body: JSON.stringify({ config: workflowConfig }),
      },
    );
    const workflow = (await workflowResponse.json()).data;
    await rootFixture.request(
      `/api/v1/ticket-workflows/${workflow.id}/approve`,
      { method: 'POST' },
    );

    requesterFixture = await createFixture({
      root: rootFixture.root,
      principal: principal('user_requester_1', ['requester']),
    });
    agentFixture = await createFixture({
      root: rootFixture.root,
      principal: principal('user_agent_1', ['support_agent']),
    });
    supervisorFixture = await createFixture({
      root: rootFixture.root,
      principal: principal('user_supervisor', ['support_lead']),
    });

    const created = await requesterFixture.request('/api/v1/tickets', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Workflow test',
        description: 'Exercise tenant-approved status transitions.',
      }),
    });
    const ticket = (await created.json()).data;
    assert.equal(created.status, 201);
    assert.equal(ticket.status, 'NEW');

    const activeWorkflow = await requesterFixture.request(
      '/api/v1/ticket-workflows/active',
    );
    assert.equal(activeWorkflow.status, 200);
    assert.equal((await activeWorkflow.json()).data.status, 'active');

    const requesterStatusChange = await requesterFixture.request(
      `/api/v1/tickets/${ticket.id}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'OPEN' }),
      },
    );
    assert.equal(requesterStatusChange.status, 403);

    const assignment = await supervisorFixture.request(
      `/api/v1/tickets/${ticket.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ teamId: 'team_support' }),
      },
    );
    assert.equal(assignment.status, 200);

    const opened = await agentFixture.request(
      `/api/v1/tickets/${ticket.id}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'OPEN' }),
      },
    );
    assert.equal(opened.status, 200);
    assert.equal((await opened.json()).data.status, 'OPEN');

    const invalidTransition = await agentFixture.request(
      `/api/v1/tickets/${ticket.id}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'CLOSED' }),
      },
    );
    assert.equal(invalidTransition.status, 409);
    assert.equal(
      (await invalidTransition.json()).error.code,
      'INVALID_STATUS_TRANSITION',
    );

    await agentFixture.request(`/api/v1/tickets/${ticket.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'IN_PROGRESS' }),
    });
    await agentFixture.request(`/api/v1/tickets/${ticket.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'RESOLVED' }),
    });

    const missingReopenReason = await supervisorFixture.request(
      `/api/v1/tickets/${ticket.id}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'REOPENED' }),
      },
    );
    assert.equal(missingReopenReason.status, 400);

    const requested = await requesterFixture.request(
      `/api/v1/tickets/${ticket.id}/reopen-requests`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: 'The issue is still occurring.' }),
      },
    );
    const reopenRequest = (await requested.json()).data;
    assert.equal(requested.status, 201);
    assert.equal(reopenRequest.status, 'pending');
    const duplicateRequest = await requesterFixture.request(
      `/api/v1/tickets/${ticket.id}/reopen-requests`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: 'Duplicate request.' }),
      },
    );
    assert.equal(duplicateRequest.status, 409);
    const pendingTicket = await requesterFixture.request(
      `/api/v1/tickets/${ticket.id}`,
    );
    assert.equal((await pendingTicket.json()).data.status, 'RESOLVED');

    const approvedReopen = await supervisorFixture.request(
      `/api/v1/tickets/${ticket.id}/reopen-requests/${reopenRequest.id}/approve`,
      { method: 'POST' },
    );
    const approvalResult = await approvedReopen.json();
    assert.equal(approvedReopen.status, 200);
    assert.equal(approvalResult.data.ticket.status, 'REOPENED');
    assert.equal(approvalResult.data.reopenRequest.status, 'approved');

    await supervisorFixture.request(`/api/v1/tickets/${ticket.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'OPEN' }),
    });
    await agentFixture.request(`/api/v1/tickets/${ticket.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'IN_PROGRESS' }),
    });
    await agentFixture.request(`/api/v1/tickets/${ticket.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'RESOLVED' }),
    });
    await agentFixture.request(`/api/v1/tickets/${ticket.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'CLOSED' }),
    });

    const agentClosedReopen = await agentFixture.request(
      `/api/v1/tickets/${ticket.id}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'REOPENED',
          reason: 'Attempt without supervisor privileges.',
        }),
      },
    );
    assert.equal(agentClosedReopen.status, 403);

    const supervisorClosedReopen = await supervisorFixture.request(
      `/api/v1/tickets/${ticket.id}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'REOPENED',
          reason: 'Approved by the supervisor.',
        }),
      },
    );
    assert.equal(supervisorClosedReopen.status, 200);
    assert.equal((await supervisorClosedReopen.json()).data.status, 'REOPENED');

    const audit = await supervisorFixture.request(
      `/api/v1/tickets/${ticket.id}/audit`,
    );
    const events = (await audit.json()).data;
    assert.equal(audit.status, 200);
    assert.ok(
      events.some(
        (event: { action: string; changes: Record<string, unknown> }) =>
          event.action === 'ticket.status_changed' &&
          'reason' in event.changes,
      ),
    );
  } finally {
    if (requesterFixture) {
      await requesterFixture.close(false);
    }
    if (agentFixture) {
      await agentFixture.close(false);
    }
    if (supervisorFixture) {
      await supervisorFixture.close(false);
    }
    await rootFixture.close();
  }
});

test('Jira source status remains separate from the tenant workflow status', async () => {
  const fixture = await createFixture({
    principal: principal('user_admin', ['organisation_admin']),
  });
  try {
    const workflowResponse = await fixture.request(
      '/api/v1/ticket-workflows',
      {
        method: 'POST',
        body: JSON.stringify({ config: workflowConfig }),
      },
    );
    const workflow = (await workflowResponse.json()).data;
    await fixture.request(`/api/v1/ticket-workflows/${workflow.id}/approve`, {
      method: 'POST',
    });

    const created = await fixture.request(
      jiraPath,
      {
        method: 'POST',
        body: JSON.stringify(jiraPayload()),
      },
      null,
    );
    const ticketId = (await created.json()).data.id as string;
    const firstRecord = JSON.parse(
      await readFile(join(fixture.root, 'tickets.json'), 'utf8'),
    ).records[0];
    assert.equal(firstRecord.status, 'NEW');
    assert.equal(firstRecord.source.status, 'Open');

    const internalChange = await fixture.request(
      `/api/v1/tickets/${ticketId}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'OPEN' }),
      },
    );
    assert.equal(internalChange.status, 200);

    const jiraUpdate = jiraPayload('jira:issue_updated');
    jiraUpdate.issue.fields.status = { name: 'In Progress' };
    const updated = await fixture.request(
      jiraPath,
      {
        method: 'POST',
        body: JSON.stringify(jiraUpdate),
      },
      null,
    );
    assert.equal(updated.status, 200);
    const finalRecord = JSON.parse(
      await readFile(join(fixture.root, 'tickets.json'), 'utf8'),
    ).records[0];
    assert.equal(finalRecord.status, 'OPEN');
    assert.equal(finalRecord.source.status, 'In Progress');
  } finally {
    await fixture.close();
  }
});

test('Jira ingestion is tenant-mapped, idempotent, and updates the same ticket', async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.request(jiraPath, {
      method: 'POST',
      body: JSON.stringify(jiraPayload()),
    }, null);
    const duplicate = await fixture.request(jiraPath, {
      method: 'POST',
      body: JSON.stringify(jiraPayload()),
    }, null);
    const updatePayload = jiraPayload('jira:issue_updated');
    updatePayload.issue.fields.summary = 'Updated Jira title';
    updatePayload.issue.fields.status = { name: 'In Progress' };
    const updated = await fixture.request(jiraPath, {
      method: 'POST',
      body: JSON.stringify(updatePayload),
    }, null);
    const createdResult = await created.json();
    const updatedResult = await updated.json();
    const records = JSON.parse(
      await readFile(join(fixture.root, 'tickets.json'), 'utf8'),
    ).records;

    assert.equal(created.status, 201);
    assert.equal(createdResult.data.outcome, 'created');
    assert.equal(createdResult.data.sourceIssueKey, 'SUP-42');
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).data.outcome, 'duplicate');
    assert.equal(updated.status, 200);
    assert.equal(updatedResult.data.outcome, 'updated');
    assert.equal(updatedResult.data.id, createdResult.data.id);
    assert.equal(records.length, 1);
    assert.equal(records[0].organisationId, 'org_support');
    assert.equal(records[0].requesterId, 'user_requester_1');
    assert.equal(records[0].source.status, 'In Progress');
    assert.equal(records[0].source.priority, 'High');
    assert.equal(records[0].title, 'Updated Jira title');
  } finally {
    await fixture.close();
  }
});

test('rejects invalid Jira secrets, unmapped reporters, and unsupported events', async () => {
  const fixture = await createFixture();
  try {
    const invalidSecret = await fixture.request(
      `/api/v1/tickets/ingest/jira/${'x'.repeat(JIRA_SECRET.length)}`,
      { method: 'POST', body: JSON.stringify(jiraPayload()) },
      null,
    );
    const unmappedPayload = jiraPayload();
    unmappedPayload.issue.fields.reporter.accountId = 'unknown-account';
    const unmapped = await fixture.request(jiraPath, {
      method: 'POST',
      body: JSON.stringify(unmappedPayload),
    }, null);
    const unsupported = await fixture.request(jiraPath, {
      method: 'POST',
      body: JSON.stringify(jiraPayload('jira:issue_deleted')),
    }, null);

    assert.equal(invalidSecret.status, 401);
    assert.equal((await invalidSecret.json()).error.code, 'JIRA_WEBHOOK_UNAUTHORIZED');
    assert.equal(unmapped.status, 403);
    assert.equal((await unmapped.json()).error.code, 'JIRA_REPORTER_UNMAPPED');
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json()).error.code, 'UNSUPPORTED_JIRA_EVENT');
    await assert.rejects(readFile(join(fixture.root, 'tickets.json'), 'utf8'));
  } finally {
    await fixture.close();
  }
});

test('search, role scope, pagination, details, and team assignment stay enforced', async () => {
  const fixture = await createFixture();
  const agent: DevelopmentPrincipal = {
    bearerToken: 'support-agent-token-with-at-least-32-characters',
    organisationId: 'org_support',
    userId: 'user_agent_1',
    roles: ['support_agent'],
    teamIds: ['team_support'],
  };
  let agentFixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const imported = await fixture.request(jiraPath, {
      method: 'POST',
      body: JSON.stringify(jiraPayload()),
    }, null);
    const ticketId = (await imported.json()).data.id as string;
    agentFixture = await createFixture({ root: fixture.root, principal: agent });

    const hidden = await agentFixture.request(`/api/v1/tickets/${ticketId}`);
    const assignment = await fixture.request(`/api/v1/tickets/${ticketId}`, {
      method: 'PATCH',
      body: JSON.stringify({ teamId: 'team_support' }),
    });
    const visible = await agentFixture.request(`/api/v1/tickets?priority=high&limit=1`);
    const detail = await agentFixture.request(`/api/v1/tickets/${ticketId}`);
    const missing = await fixture.request('/api/v1/tickets/ticket_unknown');

    assert.equal(hidden.status, 404);
    assert.equal(assignment.status, 200);
    assert.equal(visible.status, 200);
    const page = await visible.json();
    assert.equal(page.pagination.total, 1);
    assert.equal(page.data[0].id, ticketId);
    assert.equal(detail.status, 200);
    const detailResult = await detail.json();
    assert.equal(detailResult.data.source.issueKey, 'SUP-42');
    assert.equal('history' in detailResult.data, false);
    assert.equal(missing.status, 404);
  } finally {
    if (agentFixture) {
      await agentFixture.close(false);
    }
    await fixture.close();
  }
});

test('ticket changes are audited and comments honor visibility and role rules', async () => {
  const fixture = await createFixture();
  let requesterFixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const imported = await fixture.request(jiraPath, {
      method: 'POST',
      body: JSON.stringify(jiraPayload()),
    }, null);
    const ticketId = (await imported.json()).data.id as string;
    const updated = await fixture.request(`/api/v1/tickets/${ticketId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Updated title' }),
    });
    const internal = await fixture.request(`/api/v1/tickets/${ticketId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Staff note', visibility: 'internal' }),
    });
    const publicComment = await fixture.request(`/api/v1/tickets/${ticketId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Customer update', visibility: 'public' }),
    });
    requesterFixture = await createFixture({
      root: fixture.root,
      principal: {
        bearerToken: 'requester-token-with-at-least-32-characters',
        organisationId: 'org_support',
        userId: 'user_requester_1',
        roles: ['requester'],
        teamIds: [],
      },
    });
    const visibleComments = await requesterFixture.request(
      `/api/v1/tickets/${ticketId}/comments`,
    );
    const internalAttempt = await requesterFixture.request(
      `/api/v1/tickets/${ticketId}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ body: 'No', visibility: 'internal' }),
      },
    );
    const audit = await fixture.request(`/api/v1/tickets/${ticketId}/audit`);
    const comments = await visibleComments.json();
    const auditResult = await audit.json();

    assert.equal(updated.status, 200);
    assert.equal(internal.status, 201);
    assert.equal(publicComment.status, 201);
    assert.deepEqual(
      comments.data.map((comment: { body: string }) => comment.body),
      ['Customer update'],
    );
    assert.equal(internalAttempt.status, 403);
    assert.equal(audit.status, 200);
    assert.equal(auditResult.data.at(-1).action, 'ticket.comment_added');
    assert.equal(auditResult.data.at(-1).actorId, 'user_requester_1');
  } finally {
    if (requesterFixture) {
      await requesterFixture.close(false);
    }
    await fixture.close();
  }
});

test('uploads private ticket attachments and enforces ticket scope on download', async () => {
  const fixture = await createFixture();
  let agentFixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  let otherTenantFixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const imported = await fixture.request(
      jiraPath,
      {
        method: 'POST',
        body: JSON.stringify(jiraPayload()),
      },
      null,
    );
    const ticketId = (await imported.json()).data.id as string;
    const uploadedContent = Buffer.from('%PDF-1.4\nTicket attachment\n%%EOF');
    const form = new FormData();
    form.append(
      'file',
      new Blob([uploadedContent], { type: 'application/pdf' }),
      'error-report.pdf',
    );
    const uploaded = await fixture.request(
      `/api/v1/tickets/${ticketId}/attachments`,
      { method: 'POST', body: form },
    );
    const uploadResult = await uploaded.json();
    const attachmentId = uploadResult.data.id as string;
    const detailResponse = await fixture.request(
      `/api/v1/tickets/${ticketId}`,
    );
    const detail = await detailResponse.json();
    const download = await fixture.request(
      `/api/v1/tickets/${ticketId}/attachments/${attachmentId}`,
    );
    const downloadedContent = Buffer.from(await download.arrayBuffer());
    const persisted = JSON.parse(
      await readFile(join(fixture.root, 'tickets.json'), 'utf8'),
    );

    assert.equal(uploaded.status, 201);
    assert.equal(uploadResult.data.fileName, 'error-report.pdf');
    assert.equal(uploadResult.data.mimeType, 'application/pdf');
    assert.equal(uploadResult.data.fileSizeBytes, uploadedContent.length);
    assert.equal(typeof uploadResult.data.checksumSha256, 'string');
    assert.equal('storageKey' in uploadResult.data, false);
    assert.equal(detail.data.attachments.length, 1);
    assert.equal('storageKey' in detail.data.attachments[0], false);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-disposition'), 'attachment; filename="error-report.pdf"');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(downloadedContent, uploadedContent);
    assert.equal(
      persisted.records[0].history.at(-1).action,
      'ticket.attachment_added',
    );
    const storage = createLocalPrivateStorageAdapter(fixture.root);
    assert.equal(
      await storage.getDocument(
        staffPrincipal,
        'private/org_support/../../tickets.json',
      ),
      null,
    );
    await assert.rejects(
      storage.deleteDocument(
        staffPrincipal,
        'private/org_support/../../tickets.json',
      ),
      /outside the tenant private storage directory/,
    );

    const assignment = await fixture.request(
      `/api/v1/tickets/${ticketId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ teamId: 'team_support' }),
      },
    );
    assert.equal(assignment.status, 200);
    agentFixture = await createFixture({
      root: fixture.root,
      principal: {
        bearerToken: 'support-agent-token-with-at-least-32-characters',
        organisationId: 'org_support',
        userId: 'user_agent_1',
        roles: ['support_agent'],
        teamIds: ['team_support'],
      },
    });
    const agentDownload = await agentFixture.request(
      `/api/v1/tickets/${ticketId}/attachments/${attachmentId}`,
    );
    assert.equal(agentDownload.status, 200);

    otherTenantFixture = await createFixture({
      root: fixture.root,
      principal: {
        bearerToken: 'other-tenant-token-with-at-least-32-characters',
        organisationId: 'org_other',
        userId: 'user_other',
        roles: ['support_lead'],
        teamIds: ['team_support'],
      },
    });
    const blockedDownload = await otherTenantFixture.request(
      `/api/v1/tickets/${ticketId}/attachments/${attachmentId}`,
    );
    assert.equal(blockedDownload.status, 404);
  } finally {
    if (agentFixture) {
      await agentFixture.close(false);
    }
    if (otherTenantFixture) {
      await otherTenantFixture.close(false);
    }
    await fixture.close();
  }
});

test('uploads, processes, inspects, and downloads a tenant SLA source document', async () => {
  const fixture = await createFixture({
    principal: principal('user_admin', ['organisation_admin']),
  });
  try {
    const form = new FormData();
    form.append('title', 'Support SLA source');
    form.append(
      'file',
      new Blob(
        ['High priority requests receive a response within two hours.'],
        { type: 'text/plain' },
      ),
      'support-sla.txt',
    );
    const uploaded = await fixture.request('/api/v1/documents', {
      method: 'POST',
      body: form,
    });
    const uploadResult = await uploaded.json();
    const documentId = uploadResult.data.document.id as string;
    const versionId = uploadResult.data.version.id as string;

    const processed = await fixture.request(
      `/api/v1/documents/${documentId}/process`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    const processResult = await processed.json();
    const detail = await fixture.request(`/api/v1/documents/${documentId}`);
    const detailResult = await detail.json();
    const tokenResponse = await fixture.request(
      `/api/v1/documents/${documentId}/download-token`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    const tokenResult = await tokenResponse.json();
    const download = await fixture.request(tokenResult.data.downloadPath);
    const downloadedText = await download.text();

    assert.equal(uploaded.status, 201);
    assert.equal(uploadResult.data.document.status, 'uploaded');
    assert.equal('storageKey' in uploadResult.data.document, false);
    assert.equal('storageKey' in uploadResult.data.version, false);
    assert.equal(processed.status, 200);
    assert.equal(processResult.data.document.status, 'processed');
    assert.equal(processResult.data.extraction.documentVersionId, versionId);
    assert.equal(processResult.data.extraction.result.rules[0]?.payload.targetHours, 2);
    assert.equal(detailResult.data.extraction.documentId, documentId);
    assert.equal(download.status, 200);
    assert.equal(downloadedText, 'High priority requests receive a response within two hours.');
  } finally {
    await fixture.close();
  }
});

test('accepts PNG, JPEG, and WebP ticket images with matching content signatures', async () => {
  const fixture = await createFixture();
  try {
    const imported = await fixture.request(
      jiraPath,
      {
        method: 'POST',
        body: JSON.stringify(jiraPayload()),
      },
      null,
    );
    const ticketId = (await imported.json()).data.id as string;
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    const webp = Buffer.alloc(16);
    webp.write('RIFF', 0, 'ascii');
    webp.writeUInt32LE(8, 4);
    webp.write('WEBP', 8, 'ascii');
    webp.write('VP8X', 12, 'ascii');
    const samples = [
      {
        name: 'screenshot.png',
        mimeType: 'image/png',
        content: png,
      },
      {
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        content: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]),
      },
      {
        name: 'preview.webp',
        mimeType: 'image/webp',
        content: webp,
      },
    ];

    for (const sample of samples) {
      const form = new FormData();
      form.append(
        'file',
        new Blob([sample.content], { type: sample.mimeType }),
        sample.name,
      );
      const uploaded = await fixture.request(
        `/api/v1/tickets/${ticketId}/attachments`,
        { method: 'POST', body: form },
      );
      const result = await uploaded.json();
      const downloaded = await fixture.request(
        `/api/v1/tickets/${ticketId}/attachments/${result.data.id}`,
      );

      assert.equal(uploaded.status, 201);
      assert.equal(result.data.fileName, sample.name);
      assert.equal(result.data.mimeType, sample.mimeType);
      assert.equal(downloaded.status, 200);
      assert.deepEqual(
        Buffer.from(await downloaded.arrayBuffer()),
        sample.content,
      );
    }

    const mismatchForm = new FormData();
    mismatchForm.append(
      'file',
      new Blob([Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9])], {
        type: 'image/png',
      }),
      'spoofed.png',
    );
    const mismatchedImage = await fixture.request(
      `/api/v1/tickets/${ticketId}/attachments`,
      { method: 'POST', body: mismatchForm },
    );
    assert.equal(mismatchedImage.status, 400);
    assert.equal(
      (await mismatchedImage.json()).error.fields[0].message,
      'Image content does not match the selected file type.',
    );
  } finally {
    await fixture.close();
  }
});

test('rejects disallowed and oversized ticket attachments without storing them', async () => {
  const fixture = await createFixture();
  try {
    const imported = await fixture.request(
      jiraPath,
      {
        method: 'POST',
        body: JSON.stringify(jiraPayload()),
      },
      null,
    );
    const ticketId = (await imported.json()).data.id as string;
    const unsupportedForm = new FormData();
    unsupportedForm.append(
      'file',
      new Blob(['not permitted'], { type: 'application/octet-stream' }),
      'script.exe',
    );
    const unsupported = await fixture.request(
      `/api/v1/tickets/${ticketId}/attachments`,
      { method: 'POST', body: unsupportedForm },
    );

    const oversizedForm = new FormData();
    oversizedForm.append(
      'file',
      new Blob([Buffer.alloc(25 * 1024 * 1024 + 1)], {
        type: 'application/pdf',
      }),
      'large.pdf',
    );
    const oversized = await fixture.request(
      `/api/v1/tickets/${ticketId}/attachments`,
      { method: 'POST', body: oversizedForm },
    );

    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json()).error.code, 'VALIDATION_ERROR');
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, 'PAYLOAD_TOO_LARGE');
    const saved = JSON.parse(
      await readFile(join(fixture.root, 'tickets.json'), 'utf8'),
    );
    assert.deepEqual(saved.records[0].attachments ?? [], []);
  } finally {
    await fixture.close();
  }
});

test('authentication fails closed, validates input, and reports corrupt storage', async () => {
  const noAuth = await createFixture({ principal: null });
  const fixture = await createFixture();
  try {
    const unavailable = await noAuth.request('/api/v1/tickets', {}, null);
    const unauthenticated = await fixture.request('/api/v1/tickets', {}, null);
    const invalidBody = await fixture.request('/api/v1/tickets', {
      method: 'POST',
      body: JSON.stringify({ title: '   ', description: 'description' }),
    });
    await writeFile(
      join(fixture.root, 'tickets.json'),
      '{"schemaVersion":1,"records":',
    );
    const storageError = await fixture.request(jiraPath, {
      method: 'POST',
      body: JSON.stringify(jiraPayload()),
    }, null);

    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error.code, 'AUTHENTICATION_NOT_CONFIGURED');
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.code, 'UNAUTHENTICATED');
    assert.equal(invalidBody.status, 400);
    assert.equal((await invalidBody.json()).error.code, 'VALIDATION_ERROR');
    assert.equal(storageError.status, 500);
    assert.equal((await storageError.json()).error.code, 'STORAGE_ERROR');
    assert.equal(
      await readFile(join(fixture.root, 'tickets.json'), 'utf8'),
      '{"schemaVersion":1,"records":',
    );
  } finally {
    await noAuth.close();
    await fixture.close();
  }
});

test('environment configuration rejects invalid Jira and non-development principals', () => {
  assert.throws(
    () => jiraSettingsFromEnvironment({}),
    ConfigurationError,
  );
  assert.throws(
    () =>
      jiraSettingsFromEnvironment({
        JIRA_TENANT_CONFIG: JSON.stringify({
          projectMappings: { SUP: 'org_unknown' },
          organisations: {},
        }),
      }),
    ConfigurationError,
  );
  assert.throws(
    () =>
      developmentPrincipalFromEnvironment({
        APP_ENV: 'production',
        TICKET_DEV_PRINCIPAL: JSON.stringify({
          bearerToken: DEV_TOKEN,
          organisationId: 'org_support',
          userId: 'user_requester_1',
          roles: ['requester'],
        }),
      }),
    DevelopmentAuthConfigurationError,
  );
});
