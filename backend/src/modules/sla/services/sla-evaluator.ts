import type { SlaPolicy } from '../domain/sla-policy.js';
import {
  addBusinessMinutes,
  businessMinutesBetween,
} from './business-calendar.js';

export type SlaPausePeriod = {
  startedAt: string;
  endedAt: string;
};

export type SlaMetricResult = {
  targetMinutes: number;
  elapsedMinutes: number;
  deadlineAt: string | null;
  completedAt: string | null;
  remainingMinutes: number;
  state: 'on_track' | 'at_risk' | 'breached' | 'met' | 'paused';
  explanation: string;
};

export type SlaEvaluationInput = {
  ticketId: string;
  organisationId: string;
  priority: string;
  createdAt: string;
  firstResponseAt?: string;
  resolvedAt?: string;
  now: string;
  isPaused?: boolean;
  activePauseStartedAt?: string;
  pauses?: SlaPausePeriod[];
};

export type SlaEvaluation = {
  ticketId: string;
  organisationId: string;
  policyId: string;
  policyVersionId: string;
  policyVersion: number;
  evaluatedAt: string;
  metrics: {
    firstResponse: SlaMetricResult;
    resolution: SlaMetricResult;
  };
};

export class SlaEvaluationError extends Error {}

export function evaluateTicketSla(
  policy: SlaPolicy,
  input: SlaEvaluationInput,
): SlaEvaluation {
  if (policy.organisationId !== input.organisationId) {
    throw new SlaEvaluationError(
      'SLA policy organisation does not match the ticket organisation.',
    );
  }
  const evaluatedAt = parseTimestamp(input.now, 'now');
  const createdAt = parseTimestamp(input.createdAt, 'createdAt');
  if (createdAt > evaluatedAt) {
    throw new SlaEvaluationError('Ticket creation time is in the future.');
  }
  const effectiveFrom = parseTimestamp(policy.effectiveFrom, 'effectiveFrom');
  const effectiveTo =
    policy.effectiveTo === null
      ? null
      : parseTimestamp(policy.effectiveTo, 'effectiveTo');
  if (
    createdAt < effectiveFrom ||
    (effectiveTo !== null && createdAt >= effectiveTo)
  ) {
    throw new SlaEvaluationError(
      'SLA policy is not effective for the ticket creation time.',
    );
  }

  const targets = policy.targetsByPriority[input.priority];
  if (!targets) {
    throw new SlaEvaluationError(
      `No SLA targets are configured for priority ${input.priority}.`,
    );
  }
  const pauses = (input.pauses ?? []).map((pause) => ({
    start: parseTimestamp(pause.startedAt, 'pause.startedAt'),
    end: parseTimestamp(pause.endedAt, 'pause.endedAt'),
  }));
  if (
    pauses.some(
      (pause) =>
        pause.end < pause.start ||
        pause.start < createdAt ||
        pause.end > evaluatedAt,
    )
  ) {
    throw new SlaEvaluationError(
      'Completed SLA pauses must be within the ticket and evaluation time range.',
    );
  }
  const activePauseStartedAt =
    input.activePauseStartedAt === undefined
      ? undefined
      : parseTimestamp(input.activePauseStartedAt, 'activePauseStartedAt');
  if (
    activePauseStartedAt !== undefined &&
    (activePauseStartedAt < createdAt || activePauseStartedAt > evaluatedAt)
  ) {
    throw new SlaEvaluationError(
      'Active pause must be between ticket creation and evaluation time.',
    );
  }
  const effectivePauses =
    activePauseStartedAt === undefined
      ? pauses
      : [...pauses, { start: activePauseStartedAt, end: evaluatedAt }];

  const firstResponseAt = input.firstResponseAt
    ? parseTimestamp(input.firstResponseAt, 'firstResponseAt')
    : undefined;
  const resolvedAt = input.resolvedAt
    ? parseTimestamp(input.resolvedAt, 'resolvedAt')
    : undefined;
  for (const [field, timestamp] of [
    ['firstResponseAt', firstResponseAt],
    ['resolvedAt', resolvedAt],
  ] as const) {
    if (
      timestamp !== undefined &&
      (timestamp < createdAt || timestamp > evaluatedAt)
    ) {
      throw new SlaEvaluationError(
        `${field} must be between ticket creation and evaluation time.`,
      );
    }
  }
  if (input.isPaused && activePauseStartedAt === undefined) {
    throw new SlaEvaluationError(
      'An active pause start time is required while the SLA is paused.',
    );
  }
  const isPaused =
    input.isPaused === true || activePauseStartedAt !== undefined;
  const firstResponse = evaluateMetric({
    startAt: input.createdAt,
    ...(firstResponseAt === undefined ? {} : { completedAt: firstResponseAt }),
    now: input.now,
    targetMinutes: targets.firstResponseMinutes,
    policy,
    pauses: effectivePauses,
    isPaused,
  });
  const resolution = evaluateMetric({
    startAt: input.createdAt,
    ...(resolvedAt === undefined ? {} : { completedAt: resolvedAt }),
    now: input.now,
    targetMinutes: targets.resolutionMinutes,
    policy,
    pauses: effectivePauses,
    isPaused,
  });

  return {
    ticketId: input.ticketId,
    organisationId: input.organisationId,
    policyId: policy.id,
    policyVersionId: policy.versionId,
    policyVersion: policy.version,
    evaluatedAt: input.now,
    metrics: { firstResponse, resolution },
  };
}

function evaluateMetric(input: {
  startAt: string;
  completedAt?: number;
  now: string;
  targetMinutes: number;
  policy: SlaPolicy;
  pauses: Array<{ start: number; end: number }>;
  isPaused: boolean;
}): SlaMetricResult {
  const endAt =
    input.completedAt === undefined
      ? input.now
      : new Date(input.completedAt).toISOString();
  const elapsedMinutes = businessMinutesBetween(
    input.startAt,
    endAt,
    input.policy.calendar,
    input.pauses,
  );
  const remainingMinutes = Math.max(0, input.targetMinutes - elapsedMinutes);
  let state: SlaMetricResult['state'];
  let deadlineAt: string | null = null;
  let explanation: string;

  if (input.completedAt !== undefined) {
    state = elapsedMinutes <= input.targetMinutes ? 'met' : 'breached';
    explanation =
      state === 'met'
        ? 'Completed within the configured working-time target.'
        : 'Completed after the configured working-time target.';
  } else if (input.isPaused) {
    state = 'paused';
    explanation = 'The SLA clock is paused by the active ticket status.';
  } else if (elapsedMinutes >= input.targetMinutes) {
    state = 'breached';
    explanation = 'The configured working-time target has elapsed.';
  } else {
    state =
      (elapsedMinutes / input.targetMinutes) * 100 >=
      input.policy.riskAtPercent
        ? 'at_risk'
        : 'on_track';
    deadlineAt = addBusinessMinutes(
      input.startAt,
      input.targetMinutes,
      input.policy.calendar,
      input.pauses,
    );
    explanation =
      state === 'at_risk'
        ? 'The configured risk threshold has been reached.'
        : 'Within the configured working-time target.';
  }

  return {
    targetMinutes: input.targetMinutes,
    elapsedMinutes,
    deadlineAt,
    completedAt:
      input.completedAt === undefined
        ? null
        : new Date(input.completedAt).toISOString(),
    remainingMinutes,
    state,
    explanation,
  };
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new SlaEvaluationError(`${field} must be a valid date-time.`);
  }
  return timestamp;
}
