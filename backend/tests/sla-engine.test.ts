import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseSlaPolicy,
  SlaPolicyValidationError,
} from '../src/modules/sla/domain/sla-policy.js';
import {
  addBusinessMinutes,
  businessMinutesBetween,
} from '../src/modules/sla/services/business-calendar.js';
import {
  evaluateTicketSla,
  SlaEvaluationError,
} from '../src/modules/sla/services/sla-evaluator.js';

const source = {
  id: 'policy-1',
  versionId: 'policy-version-1',
  version: 1,
  organisationId: 'org-1',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
};

const payload = {
  calendar: {
    timeZone: 'America/New_York',
    weeklySchedule: {
      monday: [{ startMinute: 540, endMinute: 1020 }],
      tuesday: [{ startMinute: 540, endMinute: 1020 }],
      wednesday: [{ startMinute: 540, endMinute: 1020 }],
      thursday: [{ startMinute: 540, endMinute: 1020 }],
      friday: [{ startMinute: 540, endMinute: 1020 }],
    },
    holidays: ['2026-01-05'],
  },
  targetsByPriority: {
    high: { firstResponseMinutes: 60, resolutionMinutes: 240 },
  },
  pausedStatuses: ['PENDING'],
  resolvedStatuses: ['RESOLVED', 'CLOSED'],
  riskAtPercent: 75,
};

test('parses an approved SLA payload without supplying default targets', () => {
  const policy = parseSlaPolicy(payload, source);
  assert.equal(policy.targetsByPriority.high?.firstResponseMinutes, 60);
  assert.equal(policy.calendar.timeZone, 'America/New_York');
  assert.throws(
    () => parseSlaPolicy({ ...payload, targetsByPriority: {} }, source),
    SlaPolicyValidationError,
  );
  assert.throws(
    () =>
      parseSlaPolicy(
        {
          ...payload,
          calendar: { ...payload.calendar, timeZone: 'Mars/Olympus' },
        },
        source,
      ),
    SlaPolicyValidationError,
  );
});

test('adds only configured working minutes and skips configured holidays', () => {
  const policy = parseSlaPolicy(payload, source);
  assert.equal(
    addBusinessMinutes(
      '2026-01-02T21:00:00.000Z',
      120,
      policy.calendar,
    ),
    '2026-01-06T15:00:00.000Z',
  );
  assert.equal(
    businessMinutesBetween(
      '2026-01-02T21:00:00.000Z',
      '2026-01-06T16:00:00.000Z',
      policy.calendar,
    ),
    180,
  );
});

test('calendar deadlines honor timezone daylight-saving transitions', () => {
  const calendar = {
    timeZone: 'America/New_York',
    weeklySchedule: {
      sunday: [{ startMinute: 60, endMinute: 240 }],
    },
    holidays: [],
  };
  assert.equal(
    businessMinutesBetween(
      '2026-03-08T06:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
      calendar,
    ),
    120,
  );
  assert.equal(
    addBusinessMinutes(
      '2026-03-08T06:00:00.000Z',
      120,
      calendar,
    ),
    '2026-03-08T08:00:00.000Z',
  );
});

test('pauses are excluded from elapsed working time and extend deadlines', () => {
  const policy = parseSlaPolicy(payload, source);
  const pause = [
    {
      startedAt: '2026-01-06T15:00:00.000Z',
      endedAt: '2026-01-06T16:00:00.000Z',
    },
  ];
  assert.equal(
    businessMinutesBetween(
      '2026-01-06T14:00:00.000Z',
      '2026-01-06T18:00:00.000Z',
      policy.calendar,
      pause.map((item) => ({
        start: Date.parse(item.startedAt),
        end: Date.parse(item.endedAt),
      })),
    ),
    180,
  );
  const evaluation = evaluateTicketSla(policy, {
    ticketId: 'ticket-1',
    organisationId: 'org-1',
    priority: 'high',
    createdAt: '2026-01-06T14:00:00.000Z',
    now: '2026-01-06T16:00:00.000Z',
    pauses: pause,
  });
  assert.equal(
    evaluation.metrics.resolution.deadlineAt,
    '2026-01-06T19:00:00.000Z',
  );
});

test('evaluates response and resolution against versioned targets', () => {
  const policy = parseSlaPolicy(payload, source);
  const evaluation = evaluateTicketSla(policy, {
    ticketId: 'ticket-1',
    organisationId: 'org-1',
    priority: 'high',
    createdAt: '2026-01-06T14:00:00.000Z',
    firstResponseAt: '2026-01-06T15:00:00.000Z',
    now: '2026-01-06T17:00:00.000Z',
  });
  assert.equal(evaluation.metrics.firstResponse.state, 'met');
  assert.equal(evaluation.metrics.resolution.state, 'at_risk');
  assert.equal(evaluation.policyVersionId, source.versionId);
  assert.throws(
    () =>
      evaluateTicketSla(policy, {
        ticketId: 'ticket-2',
        organisationId: 'org-2',
        priority: 'high',
        createdAt: '2026-01-06T14:00:00.000Z',
        now: '2026-01-06T14:00:00.000Z',
      }),
    SlaEvaluationError,
  );
});

test('active pauses stop elapsed time and suppress a projected deadline', () => {
  const policy = parseSlaPolicy(payload, source);
  const evaluation = evaluateTicketSla(policy, {
    ticketId: 'ticket-1',
    organisationId: 'org-1',
    priority: 'high',
    createdAt: '2026-01-06T14:00:00.000Z',
    now: '2026-01-06T18:00:00.000Z',
    activePauseStartedAt: '2026-01-06T16:00:00.000Z',
  });
  assert.equal(evaluation.metrics.resolution.state, 'paused');
  assert.equal(evaluation.metrics.resolution.elapsedMinutes, 120);
  assert.equal(evaluation.metrics.resolution.deadlineAt, null);
});

test('does not silently evaluate priorities absent from the approved policy', () => {
  const policy = parseSlaPolicy(payload, source);
  assert.throws(
    () =>
      evaluateTicketSla(policy, {
        ticketId: 'ticket-1',
        organisationId: 'org-1',
        priority: 'urgent',
        createdAt: '2026-01-06T14:00:00.000Z',
        now: '2026-01-06T14:00:00.000Z',
      }),
    /No SLA targets are configured/,
  );
});
