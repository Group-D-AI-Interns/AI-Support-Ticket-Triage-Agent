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
const supportActor = {
  ...tenant,
  userId: 'agent-1',
  roles: ['support_agent'],
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
        teamId: 'team-support',
      },
      tenant,
    );
    await tickets.addComment(supportActor, ticket.id, {
      authorId: 'agent-1',
      body: 'We are investigating.',
      visibility: 'public',
    }, true);

    const evaluationRepository = new JsonSlaEvaluationRepository(
      createJsonTenantStore(root),
    );
    const service = new SlaEvaluationService(
      tickets,
      new RepositorySlaPolicyResolver(policyRepository),
      evaluationRepository,
    );
    const incompleteRecord = await service.evaluateTicket(
      tenant,
      ticket.id,
      new Date(Date.now() + 1000).toISOString(),
    );
    assert.equal(incompleteRecord?.input.firstResponseAt, undefined);
    await tickets.recordSlaEvidence(supportActor, ticket.id, {
      type: 'assessment_completed',
      evidence: 'Impact and affected service assessed.',
    });
    const record = await service.evaluateTicket(
      tenant,
      ticket.id,
      new Date(Date.now() + 1000).toISOString(),
    );
    const updatedTicket = await tickets.findTicket(tenant, ticket.id);
    const assessmentEvent = updatedTicket?.history?.find(
      (event) => event.action === 'ticket.sla.assessment_recorded',
    );

    assert.equal(record?.policyVersionId, 'sla-policy-v1');
    assert.equal(record?.input.firstResponseAt, assessmentEvent?.createdAt);
    assert.deepEqual(
      Object.keys(record?.input.responseEvidence ?? {}).sort(),
      [
        'acknowledgementEventId',
        'assessmentEventId',
        'assignmentEventId',
      ].sort(),
    );
    assert.equal(
      (await evaluationRepository.list(tenant, ticket.id)).length,
      2,
    );
    const resolved = await tickets.changeStatus(
      tenant,
      ticket.id,
      'OPEN',
      'RESOLVED',
      undefined,
      'workflow-test',
      {
        resolution: {
          outcome: 'service_restored',
          note: 'Service access was restored.',
          customerConfirmation: 'not_applicable',
          customerConfirmationEvidence:
            'No customer confirmation was required by the agreed process.',
        },
      },
    );
    assert.ok(resolved);
    const resolutionEvent = resolved.history?.find(
      (event) => event.action === 'ticket.sla.resolution_recorded',
    );
    assert.ok(resolutionEvent);
    const resolvedEvaluation = await service.evaluateTicket(
      tenant,
      ticket.id,
      new Date(Date.now() + 1000).toISOString(),
    );
    assert.equal(
      resolvedEvaluation?.input.resolvedAt,
      resolutionEvent.createdAt,
    );
    assert.equal(
      resolvedEvaluation?.input.resolutionEvidenceEventId,
      resolutionEvent.id,
    );
    const reopenRequest = {
      id: 'reopen_sla_evidence_test',
      requestedBy: tenant.userId,
      fromStatus: 'RESOLVED',
      toStatus: 'REOPENED',
      reason: 'Issue returned.',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    };
    const requestedReopen = await tickets.requestReopen(
      tenant,
      ticket.id,
      'RESOLVED',
      reopenRequest,
      'workflow-test',
    );
    assert.ok(requestedReopen);
    const reopened = await tickets.approveReopen(
      supportActor,
      ticket.id,
      reopenRequest.id,
      supportActor.userId,
    );
    assert.ok(reopened);
    const reopenedEvaluation = await service.evaluateTicket(
      tenant,
      ticket.id,
      new Date(Date.now() + 1000).toISOString(),
    );
    assert.equal(reopenedEvaluation?.input.resolvedAt, undefined);
    assert.equal(reopenedEvaluation?.input.resolutionPauses?.length, 1);
    assert.equal(
      reopenedEvaluation?.input.resolutionPauses?.[0]?.startedAt,
      resolutionEvent.createdAt,
    );
    assert.ok(
      Date.parse(
        reopenedEvaluation?.input.resolutionPauses?.[0]?.endedAt ?? '',
      ) >= Date.parse(resolutionEvent.createdAt),
    );
    const exclusion = await tickets.recordSlaEvidence(tenant, ticket.id, {
      type: 'exclusion_started',
      intervalId: 'sla_exclusion_test',
      reasonCode: 'approved_waiting_period',
      evidence: 'Customer-approved waiting period.',
      contractReference: 'CONTRACT-TEST',
    });
    assert.ok(exclusion);
    const activeExclusionEvaluation = await service.evaluateTicket(
      tenant,
      ticket.id,
      new Date(Date.now() + 1000).toISOString(),
    );
    assert.equal(activeExclusionEvaluation?.input.isPaused, true);
    assert.equal(
      activeExclusionEvaluation?.input.activePauseStartedAt,
      exclusion[1].createdAt,
    );
    await tickets.recordSlaEvidence(tenant, ticket.id, {
      type: 'exclusion_ended',
      intervalId: 'sla_exclusion_test',
    });
    const completedExclusionEvaluation = await service.evaluateTicket(
      tenant,
      ticket.id,
      new Date(Date.now() + 1000).toISOString(),
    );
    assert.equal(completedExclusionEvaluation?.input.pauses?.length, 1);
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
