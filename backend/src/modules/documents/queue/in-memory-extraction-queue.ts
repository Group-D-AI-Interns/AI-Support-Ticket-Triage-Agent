import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import { assertTenantAccess, type TenantContext } from '../../../shared/tenant.js';
import type { ExtractionJobRecord } from '../domain/extraction-job.js';
import type { ExtractionJobQueue } from './extraction-queue.js';

export class InMemoryExtractionQueue implements ExtractionJobQueue {
  constructor(private readonly store: JsonTenantStore) {}

  async enqueue(job: ExtractionJobRecord): Promise<ExtractionJobRecord> {
    return this.store.updateTenantCollection<ExtractionJobRecord, ExtractionJobRecord>('extractionJobs', job.organisationId, (jobs) => {
      if (jobs.some((item) => item.id === job.id)) {
        throw new Error(`Extraction job ${job.id} already exists.`);
      }
      jobs.push(job);
      return job;
    });
  }

  async claimNext(tenant: TenantContext): Promise<ExtractionJobRecord | null> {
    return this.claim(tenant);
  }

  async claimById(tenant: TenantContext, jobId: string): Promise<ExtractionJobRecord | null> {
    return this.claim(tenant, jobId);
  }

  private async claim(tenant: TenantContext, jobId?: string): Promise<ExtractionJobRecord | null> {
    return this.store.updateTenantCollection<ExtractionJobRecord, ExtractionJobRecord | null>('extractionJobs', tenant.organisationId, (jobs) => {
      const target = jobs
        .filter((job) => jobId === undefined || job.id === jobId)
        .filter((job) => job.status === 'queued' || job.status === 'retrying')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!target) return null;

      const index = jobs.findIndex((job) => job.id === target.id);
      if (index < 0) return null;
      const nextVersion: ExtractionJobRecord = {
        ...target,
        attempts: target.attempts + 1,
        status: 'processing',
        claimedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      jobs[index] = nextVersion;
      return nextVersion;
    });
  }

  async getById(tenant: TenantContext, jobId: string): Promise<ExtractionJobRecord | null> {
    const [record] = await this.store.queryCollection<ExtractionJobRecord>('extractionJobs', {
      id: jobId,
      organisationId: tenant.organisationId,
    });
    return assertTenantAccess(tenant, record) ?? null;
  }

  async update(jobId: string, updates: Partial<ExtractionJobRecord>): Promise<ExtractionJobRecord | null> {
    const [existing] = await this.store.queryCollection<ExtractionJobRecord>('extractionJobs', { id: jobId });
    if (!existing) return null;
    return this.store.updateTenantCollection<ExtractionJobRecord, ExtractionJobRecord | null>('extractionJobs', existing.organisationId, (jobs) => {
      const index = jobs.findIndex((job) => job.id === jobId);
      const current = jobs[index];
      if (index === -1 || !current) return null;

      const updated: ExtractionJobRecord = {
        ...current,
        ...updates,
        id: current.id,
        organisationId: current.organisationId,
        updatedAt: new Date().toISOString(),
      };

      jobs[index] = updated;
      return updated;
    });
  }
}
