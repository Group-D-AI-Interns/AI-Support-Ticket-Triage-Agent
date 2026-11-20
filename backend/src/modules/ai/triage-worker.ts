import type { TenantContext } from '../../shared/tenant.js';
import type { AutomationConfiguration, TriageJobs } from './triage-jobs.js';

/** Opt-in intake reconciler. Persisted jobs contain actor IDs, never tokens or roles. */
export function createTriageWorker(configuration: AutomationConfiguration, jobs: TriageJobs,
  resolve: (organisationId: string, userId: string) => Promise<TenantContext | null>,
  tickets: (tenant: TenantContext) => Promise<Array<{ id: string; createdAt: string }>>) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let stopped = false;
  const cursors = new Map<string, number>();
  // Trusted injected test configurations default to this process's startup boundary.
  const createdAfter = Date.parse(configuration.createdAfter ?? new Date().toISOString());
  async function intake(organisationId: string, ticketId: string, ticketCreatedAt = new Date().toISOString()) {
    if (!configuration.enabled || !(Date.parse(ticketCreatedAt) >= createdAfter)) return;
    const userId = configuration.actors[organisationId];
    if (!userId) return;
    const actor = await resolve(organisationId, userId);
    if (actor) await jobs.enqueue(actor, ticketId, true);
  }
  async function tick() {
    if (busy || stopped || !configuration.enabled) return;
    busy = true;
    try {
      for (const [organisationId, userId] of Object.entries(configuration.actors)) {
        const actor = await resolve(organisationId, userId);
        if (stopped) return;
        if (!actor) continue;
        const rows = (await tickets(actor)).filter(ticket => Date.parse(ticket.createdAt) >= createdAfter);
        if (stopped) return;
        const start = cursors.get(organisationId) ?? 0;
        for (const item of rows.slice(start, start + 50)) {
          if (stopped) return;
          try { await jobs.enqueue(actor, item.id, true); }
          catch { /* Individual inaccessible tickets never stop other jobs. */ }
        }
        cursors.set(organisationId, start + 50 >= rows.length ? 0 : start + 50);
      }
      if (!stopped) await jobs.tick();
    } finally { busy = false; }
  }
  const safeTick = () => { void tick().catch(() => { if (!stopped) console.warn('AI worker tick failed; pending jobs remain recoverable.'); }); };
  return { intake, tick, start() {
    if (!configuration.enabled || timer) return;
    stopped = false;
    safeTick(); timer = setInterval(safeTick, configuration.intervalMs); timer.unref();
  }, stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; } };
}
