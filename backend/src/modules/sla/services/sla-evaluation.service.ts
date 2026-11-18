import { randomUUID } from 'node:crypto';

import type { TenantContext } from '../../../shared/tenant.js';
import type { TicketRecord } from '../../tickets/domain/ticket.js';
import type { JsonTicketStore } from '../../tickets/repositories/json-ticket.store.js';
import type { SlaEvaluationRecord } from '../domain/sla-evaluation.js';
import type { SlaEvaluationRepository } from '../repositories/sla-evaluation.repository.js';
import type { RepositorySlaPolicyResolver } from './sla-policy-resolver.js';
import {
  evaluateTicketSla,
  type SlaEvaluationInput,
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
    const policy = await this.policies.resolve(tenant, {
      priority: ticket.priority,
      createdAt: ticket.createdAt,
      ...(ticket.teamId == null ? {} : { teamId: ticket.teamId }),
    });
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
    .map((event) => {
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
        at: event.createdAt,
        before: status.before,
        after: status.after,
      };
    })
    .filter((transition) => transition !== null);

  const pauses: SlaEvaluationInput['pauses'] = [];
  let activePauseStartedAt: string | undefined;
  const firstStatus = transitions[0]?.before;
  if (firstStatus && policy.pausedStatuses.includes(firstStatus)) {
    activePauseStartedAt = ticket.createdAt;
  }
  for (const transition of transitions) {
    const wasPaused = policy.pausedStatuses.includes(transition.before);
    const isPaused = policy.pausedStatuses.includes(transition.after);
    if (!wasPaused && isPaused) {
      activePauseStartedAt = transition.at;
    } else if (wasPaused && !isPaused && activePauseStartedAt) {
      pauses.push({
        startedAt: activePauseStartedAt,
        endedAt: transition.at,
      });
      activePauseStartedAt = undefined;
    }
  }
  const isCurrentlyPaused =
    ticket.status !== undefined &&
    policy.pausedStatuses.includes(ticket.status);
  if (!isCurrentlyPaused) {
    activePauseStartedAt = undefined;
  } else if (activePauseStartedAt === undefined) {
    activePauseStartedAt = ticket.createdAt;
  }

  const resolvedTransition = [...transitions]
    .reverse()
    .find((transition) => policy.resolvedStatuses.includes(transition.after));
  const resolvedAt =
    ticket.status !== undefined &&
    policy.resolvedStatuses.includes(ticket.status)
      ? resolvedTransition?.at
      : undefined;
  const firstResponse = (ticket.comments ?? [])
    .filter(
      (comment) =>
        comment.visibility === 'public' &&
        comment.authorId !== ticket.requesterId,
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

  return {
    ticketId: ticket.id,
    organisationId: ticket.organisationId,
    priority: ticket.priority ?? '',
    createdAt: ticket.createdAt,
    now,
    ...(firstResponse === undefined
      ? {}
      : { firstResponseAt: firstResponse.createdAt }),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    isPaused: isCurrentlyPaused,
    ...(activePauseStartedAt === undefined ? {} : { activePauseStartedAt }),
    ...(pauses.length === 0 ? {} : { pauses }),
  };
}
