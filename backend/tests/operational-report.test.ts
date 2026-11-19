import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOperationalReport } from '../src/modules/reporting/domain/operational-report.js';
import type { SlaEvaluationRecord } from '../src/modules/sla/domain/sla-evaluation.js';
import type { TicketRecord } from '../src/modules/tickets/domain/ticket.js';

const ticket = (
  id: string,
  createdAt: string,
  status = 'OPEN',
): TicketRecord => ({
  id,
  organisationId: 'org-1',
  requesterId: `requester-${id}`,
  title: `Ticket ${id}`,
  status,
  priority: 'high',
  createdAt,
  updatedAt: createdAt,
});

const evaluation = (
  ticketId: string,
  evaluatedAt: string,
  state: 'on_track' | 'at_risk' | 'breached' | 'met' | 'paused',
): SlaEvaluationRecord => {
  return {
    id: `${ticketId}-${evaluatedAt}`,
    organisationId: 'org-1',
    ticketId,
    policyId: 'sla-policy',
    policyVersionId: 'sla-policy-v1',
    evaluatedAt,
    input: {
      ticketId,
      organisationId: 'org-1',
      priority: 'high',
      createdAt: '2026-01-02T10:00:00.000Z',
      now: evaluatedAt,
    },
    result: {
      ticketId,
      organisationId: 'org-1',
      policyId: 'sla-policy',
      policyVersionId: 'sla-policy-v1',
      policyVersion: 1,
      evaluatedAt,
      metrics: {
        firstResponse: {
          targetMinutes: 60,
          elapsedMinutes: 30,
          deadlineAt: null,
          completedAt: null,
          remainingMinutes: 30,
          state,
          explanation: 'Test evaluation',
        },
        resolution: {
          targetMinutes: 240,
          elapsedMinutes: 30,
          deadlineAt: null,
          completedAt: null,
          remainingMinutes: 210,
          state: 'on_track',
          explanation: 'Test evaluation',
        },
      },
    },
  };
};

test('builds a tenant-provided period report from latest SLA evaluations', () => {
  const report = buildOperationalReport(
    [
      ticket('1', '2026-01-02T10:00:00.000Z'),
      ticket('2', '2026-01-03T10:00:00.000Z', 'RESOLVED'),
      ticket('outside', '2025-12-31T23:59:59.000Z'),
    ],
    [
      evaluation('1', '2026-01-02T11:00:00.000Z', 'at_risk'),
      evaluation('1', '2026-01-02T12:00:00.000Z', 'breached'),
      evaluation('outside', '2026-01-01T00:00:00.000Z', 'met'),
    ],
    '2026-01-01T00:00:00.000Z',
    '2026-02-01T00:00:00.000Z',
  );

  assert.equal(report.ticketVolume, 2);
  assert.deepEqual(report.ticketsByStatus, { OPEN: 1, RESOLVED: 1 });
  assert.deepEqual(report.ticketsByPriority, { high: 2 });
  assert.deepEqual(report.slaByState, { breached: 1 });
  assert.equal(report.ticketsWithoutEvaluation, 1);
});

test('rejects invalid report periods', () => {
  assert.throws(
    () =>
      buildOperationalReport(
        [],
        [],
        '2026-02-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      ),
    /Report period/,
  );
});
