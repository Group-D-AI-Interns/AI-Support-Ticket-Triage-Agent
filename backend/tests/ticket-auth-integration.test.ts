import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.ts';
import { loadEnvironment } from '../src/config/env.ts';

test('unified server authenticates tickets and enforces active organisation membership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'triage-ticket-auth-'));
  const timestamp = new Date().toISOString();
  const writeCollection = async (name: string, records: unknown[]) => {
    await writeFile(join(directory, name), `${JSON.stringify({ schemaVersion: 1, records })}\n`, 'utf8');
  };

  await writeCollection('users.json', [
    { id: 'user-a', email: 'a@example.test', displayName: 'User A', status: 'active', createdAt: timestamp, updatedAt: timestamp },
    { id: 'inactive-member', email: 'inactive@example.test', displayName: 'Inactive Member', status: 'active', createdAt: timestamp, updatedAt: timestamp },
    { id: 'requester', email: 'requester@example.test', displayName: 'Requester', status: 'active', createdAt: timestamp, updatedAt: timestamp },
    { id: 'lead', email: 'lead@example.test', displayName: 'Lead', status: 'active', createdAt: timestamp, updatedAt: timestamp },
    { id: 'admin', email: 'admin@example.test', displayName: 'Admin', status: 'active', createdAt: timestamp, updatedAt: timestamp },
  ]);
  await writeCollection('organisations.json', [
    { id: 'org-a', name: 'Organisation A', status: 'active', settings: {}, createdAt: timestamp, updatedAt: timestamp },
    { id: 'org-b', name: 'Organisation B', status: 'active', settings: {}, createdAt: timestamp, updatedAt: timestamp },
  ]);
  await writeCollection('memberships.json', [
    { id: 'membership-a', organisationId: 'org-a', userId: 'user-a', status: 'active', roles: ['support_agent'], createdAt: timestamp, updatedAt: timestamp },
    { id: 'membership-inactive', organisationId: 'org-a', userId: 'inactive-member', status: 'inactive', roles: ['organisation_admin'], createdAt: timestamp, updatedAt: timestamp },
    { id: 'membership-requester', organisationId: 'org-a', userId: 'requester', status: 'active', roles: ['requester'], createdAt: timestamp, updatedAt: timestamp },
    { id: 'membership-lead', organisationId: 'org-a', userId: 'lead', status: 'active', roles: ['support_lead'], createdAt: timestamp, updatedAt: timestamp },
    { id: 'membership-admin', organisationId: 'org-a', userId: 'admin', status: 'active', roles: ['organisation_admin'], createdAt: timestamp, updatedAt: timestamp },
  ]);
  await writeCollection('tickets.json', [
    { id: 'ticket-org-b', organisationId: 'org-b', requesterId: 'user-b', title: 'Private ticket', description: 'Organisation B data', createdAt: timestamp, updatedAt: timestamp },
    { id: 'ticket-org-a', organisationId: 'org-a', requesterId: 'requester', title: 'Audit test ticket', description: 'Ticket for role checks', history: [], createdAt: timestamp, updatedAt: timestamp },
    { id: 'ticket-org-a-other-team', organisationId: 'org-a', requesterId: 'requester', title: 'Other team ticket', description: 'Must not appear in the lead report', teamId: 'team-outside-scope', createdAt: timestamp, updatedAt: timestamp },
  ]);
  await writeCollection('teams.json', [
    { id: 'team-org-b', organisationId: 'org-b', departmentId: null, name: 'Foreign team', createdAt: timestamp, updatedAt: timestamp },
  ]);
  await writeCollection('slaEvaluations.json', [
    {
      id: 'evaluation-other-team',
      organisationId: 'org-a',
      ticketId: 'ticket-org-a-other-team',
      evaluatedAt: timestamp,
      result: { metrics: { firstResponse: { state: 'breached' }, resolution: { state: 'on_track' } } },
    },
  ]);

  const server = createApp(loadEnvironment({ NODE_ENV: 'test', DATA_DIRECTORY: directory, PORT: '0' }), {
    authenticator: {
      authenticate: async (request) => {
        const tokens: Record<string, string> = {
          'Bearer valid-user-a': 'user-a',
          'Bearer inactive-member': 'inactive-member',
          'Bearer requester': 'requester',
          'Bearer lead': 'lead',
          'Bearer admin': 'admin',
        };
        const token = request.headers.authorization;
        return typeof token === 'string' && tokens[token] ? { userId: tokens[token]! } : null;
      },
    },
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = (path: string, token?: string, organisationId = 'org-a') => fetch(`${baseUrl}${path}`, {
      headers: {
        ...(token ? { authorization: token } : {}),
        'x-organisation-id': organisationId,
      },
    });

    assert.equal((await request('/api/v1/tickets', 'Bearer valid-user-a')).status, 200, 'active member can use the selected tenant');

    const inactive = await request('/api/v1/tickets', 'Bearer inactive-member');
    assert.equal(inactive.status, 403, 'inactive organisation membership is rejected');

    const otherTenant = await request('/api/v1/tickets', 'Bearer valid-user-a', 'org-b');
    assert.equal(otherTenant.status, 403, 'a tenant selector does not grant membership');

    const crossTenantTicket = await request('/api/v1/tickets/ticket-org-b', 'Bearer valid-user-a');
    assert.equal(crossTenantTicket.status, 404, 'Organisation A cannot read Organisation B ticket');

    const deniedPermission = await request('/api/v1/ticket-workflows', 'Bearer valid-user-a');
    assert.equal(deniedPermission.status, 403, 'shared permission policy denies support agent workflow administration');

    assert.equal((await request('/api/v1/documents', 'Bearer valid-user-a')).status, 403, 'support agent cannot read organisation documents');
    assert.equal((await request('/api/v1/documents', 'Bearer admin')).status, 200, 'organisation administrator can read tenant documents');
    assert.equal((await request('/api/v1/sla-policies', 'Bearer valid-user-a')).status, 403, 'support agent cannot read organisation policies');
    assert.equal((await request('/api/v1/sla-policies', 'Bearer admin')).status, 200, 'organisation administrator can read tenant policies');
    const roleCapabilities = await request('/api/v1/roles', 'Bearer admin');
    const roleBody = await roleCapabilities.json() as { data: Array<{ id: string; permissions: Array<{ id: string }> }> };
    const administratorRole = roleBody.data.find((role) => role.id === 'organisation_admin');
    assert.ok(administratorRole?.permissions.some((permission) => permission.id === 'policies.candidates.review'));
    assert.ok(administratorRole?.permissions.some((permission) => permission.id === 'policies.activate'));
    const deniedActivation = await fetch(`${baseUrl}/api/v1/sla-policies/policy-a/versions/version-a/activate`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid-user-a', 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(deniedActivation.status, 403, 'support agent cannot activate an organisation policy');
    await writeFile(join(directory, 'documents.json'), '{malformed', 'utf8');
    assert.equal((await request('/api/v1/documents', 'Bearer admin')).status, 503, 'malformed document storage is surfaced, not treated as an empty collection');
    await writeCollection('documents.json', []);

    const requesterCreate = await fetch(`${baseUrl}/api/v1/tickets`, {
      method: 'POST',
      headers: { authorization: 'Bearer requester', 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Requester ticket', description: 'Created by requester' }),
    });
    assert.equal(requesterCreate.status, 201, 'requester has tickets.create.own');
    const agentCreate = await fetch(`${baseUrl}/api/v1/tickets`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid-user-a', 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Agent ticket', description: 'Should be denied' }),
    });
    assert.equal(agentCreate.status, 403, 'support agent is denied requester-only create permission');

    const agentAudit = await request('/api/v1/tickets/ticket-org-a/audit', 'Bearer valid-user-a');
    assert.equal(agentAudit.status, 403, 'support agent lacks tickets.audit.read');
    const leadAudit = await request('/api/v1/tickets/ticket-org-a/audit', 'Bearer lead');
    assert.equal(leadAudit.status, 200, 'support lead has tickets.audit.read');
    const requesterAudit = await request('/api/v1/tickets/ticket-org-a/audit', 'Bearer requester');
    assert.equal(requesterAudit.status, 403, 'requester lacks tickets.audit.read');

    async function createTeam(name: string) {
      const response = await fetch(`${baseUrl}/api/v1/teams`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin', 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      assert.equal(response.status, 201);
      return (await response.json() as { data: { id: string } }).data;
    }
    const team = await createTeam('Lead reporting team');
    const outsideTeam = await createTeam('Another reporting team');
    const memberResponse = await fetch(`${baseUrl}/api/v1/teams/${team.id}/members`, {
      method: 'PUT',
      headers: { authorization: 'Bearer admin', 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'lead', role: 'support_lead', status: 'active' }),
    });
    assert.equal(memberResponse.status, 200);
    const ticketAssignment = await fetch(`${baseUrl}/api/v1/tickets/ticket-org-a`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer admin', 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: team.id }),
    });
    assert.equal(ticketAssignment.status, 200);
    const foreignTeamAssignment = await fetch(`${baseUrl}/api/v1/tickets/ticket-org-a`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer admin', 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: 'team-org-b' }),
    });
    assert.equal(foreignTeamAssignment.status, 404, 'administrator cannot route a ticket to another organisation team');
    const otherTicketAssignment = await fetch(`${baseUrl}/api/v1/tickets/ticket-org-a-other-team`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer admin', 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: outsideTeam.id }),
    });
    assert.equal(otherTicketAssignment.status, 200);
    const outOfScopeAssignment = await fetch(`${baseUrl}/api/v1/tickets/ticket-org-a`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer lead', 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: outsideTeam.id }),
    });
    assert.equal(outOfScopeAssignment.status, 403, 'support leads cannot route tickets outside their active teams');

    const reportFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const reportTo = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const reportQuery = `from=${encodeURIComponent(reportFrom)}&to=${encodeURIComponent(reportTo)}`;
    const leadReport = await request(`/api/v1/reports?${reportQuery}`, 'Bearer lead');
    assert.equal(leadReport.status, 200, 'support lead can read reports for their active team');
    const leadReportBody = await leadReport.json() as { data: { ticketVolume: number; slaByState: Record<string, number> } };
    assert.equal(leadReportBody.data.ticketVolume, 1, 'team report excludes unassigned and other-team tickets');
    assert.deepEqual(leadReportBody.data.slaByState, {}, 'team report excludes other-team SLA evaluations');
    const agentReport = await request(`/api/v1/reports?${reportQuery}`, 'Bearer valid-user-a');
    assert.equal(agentReport.status, 403, 'support agent without report permission is denied');
    const adminReport = await request(`/api/v1/reports?${reportQuery}`, 'Bearer admin');
    assert.equal(adminReport.status, 200, 'organisation administrator has reports.read.all');
    const adminReportBody = await adminReport.json() as { data: { ticketVolume: number; slaByState: Record<string, number> } };
    assert.equal(adminReportBody.data.ticketVolume, 3, 'organisation report includes every tenant ticket');
    assert.deepEqual(adminReportBody.data.slaByState, { breached: 1 });

    const agentSlaPolicies = await request('/api/v1/sla-policies', 'Bearer valid-user-a');
    assert.equal(agentSlaPolicies.status, 403, 'support agent cannot manage SLA policies');
    const adminSlaPolicy = await fetch(`${baseUrl}/api/v1/sla-policies`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin',
        'x-organisation-id': 'org-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        description: 'Organisation A SLA',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        payload: {
          calendar: {
            timeZone: 'Africa/Johannesburg',
            weeklySchedule: {
              monday: [{ startMinute: 540, endMinute: 1020 }],
            },
            holidays: [],
          },
          targetsByPriority: {
            high: { firstResponseMinutes: 60, resolutionMinutes: 240 },
          },
          pausedStatuses: ['PENDING'],
          resolvedStatuses: ['RESOLVED'],
          riskAtPercent: 75,
        },
      }),
    });
    const createdSlaPolicy = await adminSlaPolicy.json();
    assert.equal(adminSlaPolicy.status, 201, 'tenant admin creates SLA through the unified auth path');
    assert.equal(createdSlaPolicy.data.policy.organisationId, 'org-a');
    assert.equal(createdSlaPolicy.data.version.status, 'pending_approval');

    const foundationRoute = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { authorization: 'Bearer valid-user-a' },
    });
    assert.equal(foundationRoute.status, 200, 'foundation and Express routes share the same server');
    for (let attempt = 0; attempt < 9; attempt++) {
      const repeatedCreate = await fetch(`${baseUrl}/api/v1/tickets`, {
        method: 'POST',
        headers: { authorization: 'Bearer requester', 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
        body: JSON.stringify({ title: `Rate limit ticket ${attempt}`, description: 'Synthetic rate-limit coverage' }),
      });
      assert.equal(repeatedCreate.status, 201);
    }
    const createLimited = await fetch(`${baseUrl}/api/v1/tickets`, {
      method: 'POST',
      headers: { authorization: 'Bearer requester', 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Over-limit ticket', description: 'Must be rejected before persistence' }),
    });
    assert.equal(createLimited.status, 429, 'ticket creation is limited per authenticated user and tenant');
    assert.ok(Number(createLimited.headers.get('retry-after')) > 0);
    const aiLimitedByActor = await Promise.all(Array.from({ length: 6 }, () => fetch(`${baseUrl}/api/v1/tickets/ticket-org-a/triage`, {
      method: 'POST',
      headers: { authorization: 'Bearer requester', 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
      body: '{}',
    })));
    assert.deepEqual(aiLimitedByActor.slice(0, 5).map(response => response.status), [403, 403, 403, 403, 403]);
    assert.equal(aiLimitedByActor[5]?.status, 429, 'expensive AI operations are limited per authenticated user and tenant');
    assert.equal((await request('/api/v1/tickets')).status, 401, 'missing bearer token is rejected');
    const publicIntakeAttempt = await fetch(`${baseUrl}/api/v1/tickets`, {
      method: 'POST',
      headers: { 'x-organisation-id': 'org-a', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Unauthenticated intake', description: 'Must require sign-in' }),
    });
    assert.equal(publicIntakeAttempt.status, 401, 'ticket intake is not exposed as a public route');
    assert.equal((await request('/api/v1/tickets', 'Bearer wrong-token')).status, 401, 'invalid bearer token is rejected');
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await request('/api/v1/tickets', 'Bearer wrong-token')).status, 401);
    }
    const authLimited = await request('/api/v1/tickets', 'Bearer wrong-token');
    assert.equal(authLimited.status, 429, 'repeated invalid bearer tokens are throttled by client IP');
    assert.ok(Number(authLimited.headers.get('retry-after')) > 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
