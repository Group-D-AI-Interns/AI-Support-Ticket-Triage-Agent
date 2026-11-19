import type { SlaEvaluationRecord } from '../../sla/domain/sla-evaluation.js';
import type { TicketRecord } from '../../tickets/domain/ticket.js';

export type OperationalReport = {
  period: { from: string; to: string };
  ticketVolume: number;
  ticketsByStatus: Record<string, number>;
  ticketsByPriority: Record<string, number>;
  slaByState: Record<string, number>;
  ticketsWithoutEvaluation: number;
};

export function buildOperationalReport(
  tickets: TicketRecord[],
  evaluations: SlaEvaluationRecord[],
  from: string,
  to: string,
): OperationalReport {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new RangeError('Report period must have valid increasing timestamps.');
  }
  const included = tickets.filter((ticket) => {
    const createdAt = Date.parse(ticket.createdAt);
    return Number.isFinite(createdAt) && createdAt >= start && createdAt < end;
  });
  const includedIds = new Set(included.map((ticket) => ticket.id));
  const latestByTicket = new Map<string, SlaEvaluationRecord>();
  for (const evaluation of evaluations) {
    const evaluatedAt = Date.parse(evaluation.evaluatedAt);
    if (
      !includedIds.has(evaluation.ticketId) ||
      !Number.isFinite(evaluatedAt) ||
      evaluatedAt >= end
    ) {
      continue;
    }
    const previous = latestByTicket.get(evaluation.ticketId);
    if (
      !previous ||
      evaluation.evaluatedAt.localeCompare(previous.evaluatedAt) > 0
    ) {
      latestByTicket.set(evaluation.ticketId, evaluation);
    }
  }
  const latestEvaluations = [...latestByTicket.values()].sort((left, right) =>
    left.ticketId.localeCompare(right.ticketId),
  );
  const ticketsByStatus: Record<string, number> = {};
  const ticketsByPriority: Record<string, number> = {};
  for (const ticket of included) {
    increment(ticketsByStatus, ticket.status ?? 'UNSPECIFIED');
    increment(ticketsByPriority, ticket.priority ?? 'UNSPECIFIED');
  }
  const slaByState: Record<string, number> = {};
  for (const evaluation of latestEvaluations) {
    const worstState = [
      evaluation.result.metrics.firstResponse.state,
      evaluation.result.metrics.resolution.state,
    ].sort((left, right) => stateRank(right) - stateRank(left))[0];
    if (worstState) {
      increment(slaByState, worstState);
    }
  }

  return {
    period: { from: new Date(start).toISOString(), to: new Date(end).toISOString() },
    ticketVolume: included.length,
    ticketsByStatus,
    ticketsByPriority,
    slaByState,
    ticketsWithoutEvaluation: included.length - latestEvaluations.length,
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function stateRank(state: string): number {
  switch (state) {
    case 'breached':
      return 4;
    case 'at_risk':
      return 3;
    case 'paused':
      return 2;
    case 'on_track':
      return 1;
    case 'met':
      return 0;
    default:
      return -1;
  }
}
