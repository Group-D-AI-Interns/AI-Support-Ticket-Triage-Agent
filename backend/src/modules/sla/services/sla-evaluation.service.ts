import { randomUUID } from 'node:crypto';

import type { TenantContext } from '../../../shared/tenant.js';
import type {
  TicketHistoryEvent,
  TicketRecord,
} from '../../tickets/domain/ticket.js';
import type { JsonTicketStore } from '../../tickets/repositories/json-ticket.store.js';
import type { SlaEvaluationRecord } from '../domain/sla-evaluation.js';
import type { SlaPolicy } from '../domain/sla-policy.js';
import {
  SLA_EVIDENCE_ACTIONS,
  SLA_EXCLUSION_REASON_CODES,
  SLA_PAUSE_REASON_CODES,
} from '../domain/sla-evidence.js';
import type { SlaEvaluationRepository } from '../repositories/sla-evaluation.repository.js';
import type { RepositorySlaPolicyResolver } from './sla-policy-resolver.js';
import {
  evaluateTicketSla,
  SlaEvaluationError,
  type SlaEvaluationInput,
  type SlaPausePeriod,
} from './sla-evaluator.js';

export class SlaEvaluationService {
  constructor(
    private readonly tickets: JsonTicketStore,
    private readonly policies: RepositorySlaPolicyResolver,
    private readonly evaluations: SlaEvaluationRepository,
  ) {}

  async evaluateTicket(
    tenant: TenantContext,
    ticketId: string,
    now = new Date().toISOString(),
  ): Promise<SlaEvaluationRecord | null> {
    const ticket = await this.tickets.findTicket(tenant, ticketId);
    if (!ticket || !ticket.priority) {
      return null;
    }
    const policy = await this.resolvePolicyForTicket(tenant, ticket);
    if (!policy) {
      return null;
    }

    const input = evaluationInput(ticket, policy, now);
    const result = evaluateTicketSla(policy, input);
    const record: SlaEvaluationRecord = {
      id: `sla_eval_${randomUUID().replace(/-/g, '')}`,
      organisationId: tenant.organisationId,
      ticketId: ticket.id,
      policyId: policy.id,
      policyVersionId: policy.versionId,
      evaluatedAt: now,
      input,
      result,
    };
    await this.evaluations.append(tenant, record);
    return record;
  }

  async resolvePolicyForTicket(
    tenant: TenantContext,
    ticket: Pick<TicketRecord, 'priority' | 'createdAt' | 'teamId'>,
  ): Promise<SlaPolicy | null> {
    if (!ticket.priority) {
      return null;
    }
    return this.policies.resolve(tenant, {
      priority: ticket.priority,
      createdAt: ticket.createdAt,
      ...(ticket.teamId == null ? {} : { teamId: ticket.teamId }),
    });
  }

  async evaluateTenantTickets(
    tenant: TenantContext,
    now = new Date().toISOString(),
  ): Promise<SlaEvaluationRecord[]> {
    const results: SlaEvaluationRecord[] = [];
    for (const ticket of await this.tickets.listTickets(tenant)) {
      const evaluation = await this.evaluateTicket(tenant, ticket.id, now);
      if (evaluation) {
        results.push(evaluation);
      }
    }
    return results;
  }
}

function evaluationInput(
  ticket: TicketRecord,
  policy: Parameters<typeof evaluateTicketSla>[0],
  now: string,
): SlaEvaluationInput {
  const history = [...(ticket.history ?? [])].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const transitions = history
    .map(statusTransition)
    .filter((transition) => transition !== null);
  const acknowledgementCandidate = firstHistoryEvent(
    history,
    SLA_EVIDENCE_ACTIONS.acknowledgement,
  );
  const assessmentCandidate = firstHistoryEvent(
    history,
    SLA_EVIDENCE_ACTIONS.assessment,
  );
  const assignmentCandidate = firstHistoryEvent(
    history,
    SLA_EVIDENCE_ACTIONS.assignment,
  );
  const acknowledgement = acknowledgementCandidate
    ? requireAcknowledgementEvidence(ticket, acknowledgementCandidate)
    : undefined;
  const assessment = assessmentCandidate
    ? requireTextEvidence(assessmentCandidate, 'assessment')
    : undefined;
  const assignment = assignmentCandidate
    ? requireTextEvidence(assignmentCandidate, 'assignment', 'teamId')
    : undefined;
  const responseEvidence =
    acknowledgement && assessment && assignment
      ? {
          acknowledgementEventId: acknowledgement.id,
          assessmentEventId: assessment.id,
          assignmentEventId: assignment.id,
        }
      : undefined;
  const responseEvents = [acknowledgement, assessment, assignment];
  const responseTimes =
    responseEvidence === undefined
      ? []
      : responseEvents
          .filter((event): event is TicketHistoryEvent => event !== undefined)
          .map((event) => event.createdAt)
          .sort((left, right) => Date.parse(left) - Date.parse(right));
  const firstResponseAt = responseTimes[responseTimes.length - 1];

  const resolutionEvents = history.filter(
    (event) => event.action === SLA_EVIDENCE_ACTIONS.resolution,
  );
  for (const event of resolutionEvents) {
    if (
      (event.changes.outcome !== 'service_restored' &&
        event.changes.outcome !== 'agreed_solution') ||
      typeof event.changes.note !== 'string' ||
      !event.changes.note.trim() ||
      (event.changes.customerConfirmation !== 'received' &&
        event.changes.customerConfirmation !== 'not_applicable') ||
      typeof event.changes.customerConfirmationEvidence !== 'string' ||
      !event.changes.customerConfirmationEvidence.trim() ||
      typeof event.changes.statusEventId !== 'string'
    ) {
      throw new SlaEvaluationError('Resolution evidence is incomplete.');
    }
  }
  const resolutionEventsByStatusEventId = new Map(
    resolutionEvents
      .map((event) => {
        const statusEventId = event.changes.statusEventId;
        return typeof statusEventId === 'string'
          ? [statusEventId, event] as const
          : null;
      })
      .filter((entry) => entry !== null),
  );
  let openResolution:
    | { at: string; event: TicketHistoryEvent }
    | undefined;
  const resolutionPauses: SlaPausePeriod[] = [];
  for (const transition of transitions) {
    const wasResolved = policy.resolvedStatuses.includes(transition.before);
    const isResolved = policy.resolvedStatuses.includes(transition.after);
    if (!wasResolved && isResolved) {
      const event = resolutionEventsByStatusEventId.get(transition.event.id);
      if (event) {
        openResolution = { at: event.createdAt, event };
      }
    } else if (wasResolved && !isResolved && openResolution) {
      resolutionPauses.push({
        startedAt: openResolution.at,
        endedAt: transition.at,
      });
      openResolution = undefined;
    }
  }
  const isCurrentlyResolved =
    ticket.status !== undefined &&
    policy.resolvedStatuses.includes(ticket.status);
  const resolvedAt = isCurrentlyResolved ? openResolution?.at : undefined;
  if (!isCurrentlyResolved) {
    openResolution = undefined;
  }
  const resolutionEvidenceEventId = resolvedAt
    ? openResolution?.event.id
    : undefined;

  const pauseEvidence = collectSlaIntervals(
    history,
    SLA_EVIDENCE_ACTIONS.pauseStarted,
    SLA_EVIDENCE_ACTIONS.pauseEnded,
    SLA_PAUSE_REASON_CODES,
  );
  const exclusionEvidence = collectSlaIntervals(
    history,
    SLA_EVIDENCE_ACTIONS.exclusionStarted,
    SLA_EVIDENCE_ACTIONS.exclusionEnded,
    SLA_EXCLUSION_REASON_CODES,
  );
  if (pauseEvidence.active && exclusionEvidence.active) {
    throw new SlaEvaluationError(
      'SLA pause and exclusion intervals cannot overlap.',
    );
  }
  const activePause = pauseEvidence.active ?? exclusionEvidence.active;
  const pauses = [...pauseEvidence.completed, ...exclusionEvidence.completed];
  const currentStatusIsPaused =
    ticket.status !== undefined &&
    policy.pausedStatuses.includes(ticket.status);
  if (
    pauseEvidence.active &&
    !currentStatusIsPaused
  ) {
    throw new SlaEvaluationError(
      'An active SLA pause is not reflected in the current ticket status.',
    );
  }

  return {
    ticketId: ticket.id,
    organisationId: ticket.organisationId,
    priority: ticket.priority ?? '',
    createdAt: ticket.createdAt,
    now,
    ...(firstResponseAt === undefined
      ? {}
      : { firstResponseAt }),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(responseEvidence === undefined ? {} : { responseEvidence }),
    ...(resolutionEvidenceEventId === undefined
      ? {}
      : { resolutionEvidenceEventId }),
    ...(activePause === undefined
      ? {}
      : { isPaused: true, activePauseStartedAt: activePause.startedAt }),
    ...(pauses.length === 0 ? {} : { pauses }),
    ...(resolutionPauses.length === 0 ? {} : { resolutionPauses }),
  };
}

function firstHistoryEvent(
  history: TicketHistoryEvent[],
  action: string,
): TicketHistoryEvent | undefined {
  return history.find((event) => event.action === action);
}

function requireAcknowledgementEvidence(
  ticket: TicketRecord,
  event: TicketHistoryEvent,
): TicketHistoryEvent {
  const commentId = event.changes.commentId;
  const comment = typeof commentId === 'string'
    ? (ticket.comments ?? []).find((item) => item.id === commentId)
    : undefined;
  if (
    !comment ||
    comment.visibility !== 'public' ||
    comment.authorId !== event.actorId
  ) {
    throw new SlaEvaluationError(
      'Acknowledgement evidence must reference a public comment by its recorded actor.',
    );
  }
  return event;
}

function requireTextEvidence(
  event: TicketHistoryEvent,
  name: string,
  field = 'evidence',
): TicketHistoryEvent {
  const value = event.changes[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new SlaEvaluationError(`${name} evidence is incomplete.`);
  }
  return event;
}

function statusTransition(
  event: TicketHistoryEvent,
): { event: TicketHistoryEvent; at: string; before: string; after: string } | null {
  if (event.action !== 'ticket.status_changed') {
    return null;
  }
  const status = event.changes.status;
  if (
    status === null ||
    typeof status !== 'object' ||
    Array.isArray(status) ||
    typeof status.before !== 'string' ||
    typeof status.after !== 'string'
  ) {
    return null;
  }
  return {
    event,
    at: event.createdAt,
    before: status.before,
    after: status.after,
  };
}

function collectSlaIntervals(
  history: TicketHistoryEvent[],
  startAction: string,
  endAction: string,
  validReasonCodes: readonly string[],
): {
  completed: SlaPausePeriod[];
  active?: { intervalId: string; startedAt: string };
} {
  const starts = new Map<
    string,
    { startedAt: string }
  >();
  const seenIntervals = new Set<string>();
  const completed: SlaPausePeriod[] = [];
  let active: { intervalId: string; startedAt: string } | undefined;
  for (const event of history) {
    if (event.action === startAction) {
      const intervalId = event.changes.intervalId;
      if (
        typeof intervalId !== 'string' ||
        seenIntervals.has(intervalId) ||
        active
      ) {
        throw new SlaEvaluationError('SLA interval evidence has an invalid identifier.');
      }
      const reasonCode = event.changes.reasonCode;
      const evidence = event.changes.evidence;
      const contractReference = event.changes.contractReference;
      if (
        typeof reasonCode !== 'string' ||
        !validReasonCodes.includes(reasonCode) ||
        typeof evidence !== 'string' ||
        !evidence.trim() ||
        typeof contractReference !== 'string' ||
        !contractReference.trim()
      ) {
        throw new SlaEvaluationError(
          'SLA pause/exclusion evidence is incomplete.',
        );
      }
      starts.set(intervalId, { startedAt: event.createdAt });
      seenIntervals.add(intervalId);
      active = { intervalId, startedAt: event.createdAt };
    } else if (event.action === endAction) {
      const intervalId = event.changes.intervalId;
      if (typeof intervalId !== 'string') {
        throw new SlaEvaluationError('SLA interval end has an invalid identifier.');
      }
      const start = starts.get(intervalId);
      if (!start) {
        throw new SlaEvaluationError('SLA interval end has no matching start.');
      }
      starts.delete(intervalId);
      completed.push({ startedAt: start.startedAt, endedAt: event.createdAt });
      if (active?.intervalId === intervalId) {
        active = undefined;
      }
    }
  }
  if (active) {
    return { completed, active };
  }
  return { completed };
}
