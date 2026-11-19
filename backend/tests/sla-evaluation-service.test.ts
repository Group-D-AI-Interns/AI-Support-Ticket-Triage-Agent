import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { JsonPolicyRepository } from '../src/modules/policies/repositories/json-policy.repository.js';
import { JsonTicketStore } from '../src/modules/tickets/repositories/json-ticket.store.js';
import { JsonSlaEvaluationRepository } from '../src/modules/sla/repositories/sla-evaluation.repository.js';
import { SlaEvaluationService } from '../src/modules/sla/services/sla-evaluation.service.js';
import { RepositorySlaPolicyResolver } from '../src/modules/sla/services/sla-policy-resolver.js';

const tenant = {
  organisationId: 'org-sla-test',
  userId: 'requester-1',
  roles: ['requester'],
};

const payload = {
  calendar: {
    timeZone: 'UTC',
    weeklySchedule: Object.fromEntries(
      [
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
        'sunday',
      ].map((day) => [day, [{ startMinute: 0, endMinute: 1440 }]]),
    ),
    holidays: [],
  },
  targetsByPriority: {
    high: { firstResponseMinutes: 60, resolutionMinutes: 240 },
  },
  pausedStatuses: ['PENDING'],
  resolvedStatuses: ['RESOLVED', 'CLOSED'],
  riskAtPercent: 75,
};

test('evaluates a tenant ticket against its active policy version and persists input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sla-service-'));
  try {
    const policyRepository = new JsonPolicyRepository(
      createJsonTenantStore(root),
    );
    const policy = await policyRepository.createPolicy(
      {
        id: 'sla-policy',
        organisationId: tenant.organisationId,
        policyType: 'sla',
        ownerId: tenant.userId,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        description: 'Policy normalized from approved uploaded guidance',
      },
      tenant,
    );
    await policyRepository.createVersion(
      policy.id,
      {
        id: 'sla-policy-v1',
        organisationId: tenant.organisationId,
        policyId: policy.id,
        version: 1,
        status: 'active',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        payload,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      tenant,
    );

    const tickets = new JsonTicketStore(root);
    const ticket = await tickets.createTicket(
      {
        organisationId: tenant.organisationId,
        requesterId: tenant.userId,
        title: 'Unable to access service',
        status: 'OPEN',
        priority: 'high',
      },
      tenant,
    );
    await tickets.addComment(tenant, ticket.id, {
      authorId: 'agent-1',
      body: 'We are investigating.',
      visibility: 'public',
    });

    const evaluationRepository = new JsonSlaEvaluationRepository(
      createJsonTenantStore(root),
    );
    const service = new SlaEvaluationService(
      tickets,
      new RepositorySlaPolicyResolver(policyRepository),
      evaluationRepository,
    );
    const record = await service.evaluateTicket(
      tenant,
      ticket.id,
      new Date(Date.now() + 1000).toISOString(),
    );

    assert.equal(record?.policyVersionId, 'sla-policy-v1');
    assert.equal(record?.input.firstResponseAt !== undefined, true);
    assert.equal(
      (await evaluationRepository.list(tenant, ticket.id)).length,
      1,
    );
    assert.equal(
      (await evaluationRepository.list({
        ...tenant,
        organisationId: 'other-org',
      })).length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
