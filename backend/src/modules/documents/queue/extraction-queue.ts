import type { TenantContext } from '../../../shared/tenant.js';
import type { ExtractionJobRecord } from '../domain/extraction-job.js';

export interface ExtractionJobQueue {
  enqueue(job: ExtractionJobRecord): Promise<ExtractionJobRecord>;
  claimNext(tenant: TenantContext): Promise<ExtractionJobRecord | null>;
  getById(tenant: TenantContext, jobId: string): Promise<ExtractionJobRecord | null>;
  update(jobId: string, updates: Partial<ExtractionJobRecord>): Promise<ExtractionJobRecord | null>;
}
