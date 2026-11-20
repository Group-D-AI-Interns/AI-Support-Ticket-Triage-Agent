import { createHash, randomUUID } from 'node:crypto';
import type { TenantContext } from '../../shared/tenant.js';
import { AiExecutionError } from './ai-execution-runner.js';
import { AiOperationsError, AiOperationsService } from './operations-service.js';
import type { OfKind } from './operations-store.js';
import { ticketSnapshotHash } from './ticket-analysis.graph.js';

export class TriageJobs {
  constructor(private readonly operations: AiOperationsService,
    private readonly resolveActor: (organisationId: string, userId: string) => Promise<TenantContext | null>,
    private readonly leaseMs = 300_000, private readonly clock = () => Date.now()) {}
  async enqueue(tenant: TenantContext, ticketId: string, automatic = false,
    limits = { maxJobsPerDay: 10, maxAttemptsPerJob: 1 }) {
    if (!Number.isInteger(limits.maxJobsPerDay) || limits.maxJobsPerDay < 1 || limits.maxJobsPerDay > 1000 ||
      !Number.isInteger(limits.maxAttemptsPerJob) || limits.maxAttemptsPerJob < 1 || limits.maxAttemptsPerJob > 3) throw new Error('Invalid automatic job budget.');
    const actor = await this.resolveActor(tenant.organisationId, tenant.userId);
    if (!actor) throw new AiOperationsError(403, 'AI_ACTOR_UNAVAILABLE', 'The processing user is not currently authorized.');
    const ticket = await this.operations.ticket(actor, ticketId);
    const snapshotHash = ticketSnapshotHash(this.operations.deps.project(ticket));
    const key = JSON.stringify([tenant.organisationId, tenant.userId, ticketId, snapshotHash, this.operations.deps.categories(), 'triage-v1']);
    const id = automatic ? `job_${createHash('sha256').update(key).digest('hex')}` : `job_${randomUUID()}`;
    const now = new Date(this.clock()).toISOString();
    const job: OfKind<'job'> = { id, kind: 'job', organisationId: tenant.organisationId, actorId: tenant.userId, createdAt: now, updatedAt: now,
      data: { ticketId, snapshotHash, automatic, status: 'queued', attempts: 0, maxAttempts: automatic ? limits.maxAttemptsPerJob : 3, availableAt: now, leaseUntil: null, leaseToken: null, reportId: null, errorCode: null } };
    return this.operations.store.change(rows => {
      const existing = rows.find(item => item.kind === 'job' && item.id === id && item.organisationId === tenant.organisationId);
      if (existing) return existing as OfKind<'job'>;
      if (automatic && rows.filter(row => row.kind === 'job' && row.organisationId === tenant.organisationId && row.data.automatic !== false && row.createdAt.slice(0, 10) === now.slice(0, 10)).length >= limits.maxJobsPerDay) {
        throw new AiOperationsError(429, 'AI_DAILY_JOB_LIMIT_REACHED', 'The organisation automatic-job budget for this UTC day is exhausted.');
      }
      rows.push(job); return job;
    });
  }
  async get(tenant: TenantContext, id: string) {
    const job = (await this.operations.store.list(tenant.organisationId, 'job')).find(item => item.id === id);
    if (!job) throw new AiOperationsError(404, 'NOT_FOUND', 'AI job not found.');
    await this.operations.ticket(tenant, job.data.ticketId);
    if (job.actorId !== tenant.userId && !this.operations.deps.can(tenant, 'configuration.manage')) throw new AiOperationsError(403, 'FORBIDDEN', 'This job belongs to another processing user.');
    return job;
  }
  async process(id: string) {
    const token = randomUUID();
    const job = await this.operations.store.change(rows => {
      const target = rows.find(item => item.kind === 'job' && item.id === id) as OfKind<'job'> | undefined;
      if (!target || target.data.status === 'completed' || target.data.status === 'failed') return null;
      if (target.data.status === 'running' && Date.parse(target.data.leaseUntil!) > this.clock()) return null;
      if (target.data.status === 'queued' && Date.parse(target.data.availableAt) > this.clock()) return null;
      if (target.data.attempts >= target.data.maxAttempts) { target.data.status = 'failed'; target.data.errorCode = 'ATTEMPTS_EXHAUSTED'; return null; }
      target.data.status = 'running'; target.data.attempts++;
      target.data.leaseToken = token; target.data.leaseUntil = new Date(this.clock() + this.leaseMs).toISOString();
      target.updatedAt = new Date(this.clock()).toISOString();
      return structuredClone(target);
    });
    if (!job) return;
    try {
      const actor = await this.resolveActor(job.organisationId, job.actorId);
      if (!actor) throw new AiOperationsError(403, 'ACCESS_REVOKED', 'The processing user is no longer authorized.');
      const ticket = await this.operations.ticket(actor, job.data.ticketId);
      if (ticketSnapshotHash(this.operations.deps.project(ticket)) !== job.data.snapshotHash) throw new AiOperationsError(409, 'STALE_JOB', 'Ticket changed after enqueue.');
      const reportId = `report_${job.id}`;
      let report = (await this.operations.store.list(job.organisationId, 'report')).find(item => item.id === reportId);
      report ??= await this.operations.computeReport(actor, job.data.ticketId, reportId);
      const currentActor = await this.resolveActor(job.organisationId, job.actorId);
      if (!currentActor) throw new AiOperationsError(403, 'ACCESS_REVOKED', 'Processing access was revoked.');
      const latest = await this.operations.ticket(currentActor, job.data.ticketId);
      if (ticketSnapshotHash(this.operations.deps.project(latest)) !== job.data.snapshotHash) throw new AiOperationsError(409, 'STALE_JOB', 'Ticket changed during processing.');
      await this.operations.store.change(rows => {
        const current = rows.find(item => item.kind === 'job' && item.id === id) as OfKind<'job'>;
        if (current.data.leaseToken !== token || current.data.status !== 'running') return;
        if (!rows.some(item => item.kind === 'report' && item.id === reportId)) rows.push(report!);
        current.data = { ...current.data, status: 'completed', leaseToken: null, leaseUntil: null, reportId, errorCode: null };
        current.updatedAt = new Date(this.clock()).toISOString();
      });
    } catch (error) {
      const transient = error instanceof AiExecutionError && ['TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE'].includes(error.code);
      await this.operations.store.change(rows => {
        const current = rows.find(item => item.kind === 'job' && item.id === id) as OfKind<'job'>;
        if (current.data.leaseToken !== token || current.data.status !== 'running') return;
        current.data.status = transient && current.data.attempts < current.data.maxAttempts ? 'queued' : 'failed';
        current.data.availableAt = new Date(this.clock() + Math.min(30_000, 1_000 * 2 ** current.data.attempts)).toISOString();
        current.data.errorCode = error instanceof AiExecutionError || error instanceof AiOperationsError ? error.code : 'AI_JOB_FAILED';
        current.data.leaseUntil = null; current.data.leaseToken = null; current.updatedAt = new Date(this.clock()).toISOString();
      });
    }
  }
  async tick() {
    const jobs = (await this.operations.store.all()).filter((row): row is OfKind<'job'> => row.kind === 'job' &&
      ((row.data.status === 'queued' && Date.parse(row.data.availableAt) <= this.clock()) ||
       (row.data.status === 'running' && Date.parse(row.data.leaseUntil!) <= this.clock())));
    for (const job of jobs.slice(0, 20)) await this.process(job.id);
  }
}

export type AutomationConfiguration = { enabled: boolean; actors: Record<string, string>; intervalMs: number; createdAfter?: string; maxJobsPerDay?: number; maxAttemptsPerJob?: number };
export function automationFromEnvironment(environment: NodeJS.ProcessEnv = process.env): AutomationConfiguration {
  if (environment.AI_AUTOMATION_ENABLED === undefined || environment.AI_AUTOMATION_ENABLED === 'false') return { enabled: false, actors: {}, intervalMs: 2_000 };
  if (environment.AI_AUTOMATION_ENABLED !== 'true') throw new Error('AI_AUTOMATION_ENABLED must be true or false.');
  const actors: unknown = JSON.parse(environment.AI_AUTOMATION_ACTORS ?? '{}');
  if (!actors || typeof actors !== 'object' || Array.isArray(actors) || !Object.keys(actors).length || Object.entries(actors).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())) throw new Error('Configure explicit AI_AUTOMATION_ACTORS organisation/user mappings.');
  const intervalMs = Number(environment.AI_AUTOMATION_INTERVAL_MS ?? 2_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000) throw new Error('AI_AUTOMATION_INTERVAL_MS must be 1000..60000.');
  const createdAfter = environment.AI_AUTOMATION_CREATED_AFTER;
  if (!createdAfter || !Number.isFinite(Date.parse(createdAfter)) || !/^\d{4}-\d{2}-\d{2}T/.test(createdAfter)) throw new Error('AI_AUTOMATION_CREATED_AFTER must explicitly bound intake with an ISO timestamp.');
  const maxJobsPerDay = Number(environment.AI_AUTOMATION_MAX_JOBS_PER_DAY);
  const maxAttemptsPerJob = Number(environment.AI_AUTOMATION_MAX_ATTEMPTS_PER_JOB);
  if (!Number.isInteger(maxJobsPerDay) || maxJobsPerDay < 1 || maxJobsPerDay > 1000 || !Number.isInteger(maxAttemptsPerJob) || maxAttemptsPerJob < 1 || maxAttemptsPerJob > 3) throw new Error('Explicitly configure AI_AUTOMATION_MAX_JOBS_PER_DAY (1..1000) and AI_AUTOMATION_MAX_ATTEMPTS_PER_JOB (1..3).');
  return { enabled: true, actors: actors as Record<string, string>, intervalMs, createdAfter, maxJobsPerDay, maxAttemptsPerJob };
}
