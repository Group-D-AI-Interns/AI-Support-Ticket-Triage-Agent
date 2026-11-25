import type { TenantContext } from '../../../shared/auth/authentication.js';
import type { JsonTicketStore } from '../../tickets/repositories/json-ticket.store.js';
import type { SlaEvaluationService } from './sla-evaluation.service.js';

export type SlaEvaluationWorkerLogger = {
  error(message: string, fields?: Record<string, unknown>): void;
};

export type SlaEvaluationWorkerOptions = {
  intervalMs: number;
  listOrganisationIds: () => Promise<string[]>;
  logger: SlaEvaluationWorkerLogger;
};

const workerTenant = (organisationId: string): TenantContext => ({
  organisationId,
  userId: 'sla-evaluation-worker',
  roles: [],
});

export class SlaEvaluationWorker {
  private readonly pendingTickets = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private pendingRunScheduled = false;
  private stopped = false;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;

  constructor(
    private readonly service: Pick<
      SlaEvaluationService,
      'evaluateTicket'
    >,
    private readonly tickets: Pick<JsonTicketStore, 'listTickets'>,
    private readonly options: SlaEvaluationWorkerOptions,
  ) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new RangeError('SLA evaluation interval must be a positive integer.');
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.runScheduledEvaluation();
    }, this.options.intervalMs);
    this.timer.unref();
    void this.runScheduledEvaluation();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.pendingTickets.clear();
    await this.idle;
  }

  enqueue(organisationId: string, ticketId: string): void {
    if (this.stopped) return;
    const tickets =
      this.pendingTickets.get(organisationId) ?? new Set<string>();
    tickets.add(ticketId);
    this.pendingTickets.set(organisationId, tickets);
    this.schedulePendingEvaluation();
  }

  private async runScheduledEvaluation(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.beginRun();
    try {
      const organisationIds = await this.options.listOrganisationIds();
      for (const organisationId of organisationIds) {
        if (this.stopped) return;
        const tenant = workerTenant(organisationId);
        let tickets;
        try {
          tickets = await this.tickets.listTickets(tenant);
        } catch (error) {
          this.options.logger.error(
            'Could not list tickets for scheduled SLA evaluation.',
            { organisationId, errorType: errorType(error) },
          );
          continue;
        }
        for (const ticket of tickets) {
          if (this.stopped) return;
          try {
            await this.service.evaluateTicket(tenant, ticket.id);
          } catch (error) {
            this.options.logger.error('Scheduled SLA evaluation failed.', {
              organisationId,
              ticketId: ticket.id,
              errorType: errorType(error),
            });
          }
        }
      }
    } catch (error) {
      this.options.logger.error(
        'Could not list organisations for scheduled SLA evaluation.',
        { errorType: errorType(error) },
      );
    } finally {
      this.finishRun();
      this.schedulePendingEvaluation();
    }
  }

  private schedulePendingEvaluation(): void {
    if (
      this.stopped ||
      this.pendingTickets.size === 0 ||
      this.pendingRunScheduled
    ) {
      return;
    }
    this.pendingRunScheduled = true;
    queueMicrotask(() => {
      this.pendingRunScheduled = false;
      void this.runPendingEvaluations();
    });
  }

  private async runPendingEvaluations(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.beginRun();
    try {
      while (!this.stopped && this.pendingTickets.size > 0) {
        const next = this.pendingTickets.entries().next().value;
        if (!next) break;
        const [organisationId, ticketIds] = next;
        this.pendingTickets.delete(organisationId);
        for (const ticketId of ticketIds) {
          try {
            await this.service.evaluateTicket(
              workerTenant(organisationId),
              ticketId,
            );
          } catch (error) {
            this.options.logger.error('Event-triggered SLA evaluation failed.', {
              organisationId,
              ticketId,
              errorType: errorType(error),
            });
          }
        }
      }
    } finally {
      this.finishRun();
      this.schedulePendingEvaluation();
    }
  }

  private beginRun(): void {
    this.busy = true;
    this.idle = new Promise(resolve => { this.resolveIdle = resolve; });
  }

  private finishRun(): void {
    this.busy = false;
    this.resolveIdle?.();
    this.resolveIdle = undefined;
  }
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
