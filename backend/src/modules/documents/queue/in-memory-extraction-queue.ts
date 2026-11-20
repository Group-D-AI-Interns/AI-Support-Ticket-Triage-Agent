import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import { assertTenantAccess, type TenantContext } from '../../../shared/tenant.js';
import type { ExtractionJobRecord } from '../domain/extraction-job.js';
import type { ExtractionJobQueue } from './extraction-queue.js';

export class InMemoryExtractionQueue implements ExtractionJobQueue {
  constructor(private readonly store: JsonTenantStore) {}

  async enqueue(job: ExtractionJobRecord): Promise<ExtractionJobRecord> {
    return this.store.withCollectionLock('extractionJobs', async () => {
      const jobs = await this.store.readCollection<ExtractionJobRecord>('extractionJobs');
      if (jobs.some((item) => item.id === job.id)) {
        throw new Error(`Extraction job ${job.id} already exists.`);
      }

      jobs.push(job);
      await this.store.writeCollection('extractionJobs', jobs);
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
    return this.store.withCollectionLock('extractionJobs', async () => {
      const jobs = await this.store.readCollection<ExtractionJobRecord>('extractionJobs');
      const queuedJobs = jobs
        .filter((job) => job.organisationId === tenant.organisationId)
        .filter((job) => jobId === undefined || job.id === jobId)
        .filter((job) => job.status === 'queued' || job.status === 'retrying')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      if (queuedJobs.length === 0) {
        return null;
      }

      const target = queuedJobs[0];
      if (!target) {
        return null;
      }
      const index = jobs.findIndex((job) => job.id === target.id);
      if (index < 0) {
        return null;
      }
      const nextVersion: ExtractionJobRecord = {
        ...target,
        attempts: target.attempts + 1,
        status: 'processing',
        claimedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      jobs[index] = nextVersion;
      await this.store.writeCollection('extractionJobs', jobs);
      return nextVersion;
    });
  }

  async getById(tenant: TenantContext, jobId: string): Promise<ExtractionJobRecord | null> {
    const jobs = await this.store.readCollection<ExtractionJobRecord>('extractionJobs');
    const record = jobs.find((item) => item.id === jobId);
    return assertTenantAccess(tenant, record) ?? null;
  }

  async update(jobId: string, updates: Partial<ExtractionJobRecord>): Promise<ExtractionJobRecord | null> {
    return this.store.withCollectionLock('extractionJobs', async () => {
      const jobs = await this.store.readCollection<ExtractionJobRecord>('extractionJobs');
      const index = jobs.findIndex((job) => job.id === jobId);
      const current = jobs[index];
      if (index === -1 || !current) {
        return null;
      }

      const updated: ExtractionJobRecord = {
        ...current,
        ...updates,
        updatedAt: new Date().toISOString(),
      };

      jobs[index] = updated;
      await this.store.writeCollection('extractionJobs', jobs);
      return updated;
    });
  }
}
