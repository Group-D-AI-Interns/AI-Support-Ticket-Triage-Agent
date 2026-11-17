import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import { JsonDocumentRepository } from '../repositories/json-document.repository.js';
import type { ExtractionJobQueue } from '../queue/extraction-queue.js';
import type { ExtractionJobRecord } from '../domain/extraction-job.js';
import type { TenantContext } from '../../../shared/tenant.js';
import type { ExtractionAdapter } from '../services/mock-extraction-adapter.js';

export class ExtractionWorker {
  constructor(
    private readonly store: JsonTenantStore,
    private readonly queue: ExtractionJobQueue,
    private readonly adapter: ExtractionAdapter,
  ) {}

  private get documentRepository(): JsonDocumentRepository {
    return new JsonDocumentRepository(this.store);
  }

  async processNextForTenant(tenant: TenantContext): Promise<ExtractionJobRecord | null> {
    const job = await this.queue.claimNext(tenant);
    if (!job) {
      return null;
    }

    try {
      const document = await this.documentRepository.getById(tenant, job.documentId);
      if (!document) {
        throw new Error('Document not found for tenant or inaccessible.');
      }

      const result = await this.adapter.extract({
        tenant,
        documentId: job.documentId,
        documentVersionId: job.documentVersionId,
        executionId: job.executionId,
      });

      const completed = await this.queue.update(job.id, {
        status: result.status === 'succeeded' ? 'succeeded' : 'failed',
        completedAt: new Date().toISOString(),
        lastError: result.status === 'failed' ? 'Extraction failed.' : undefined,
      });

      if (!completed) {
        return null;
      }

      if (result.status === 'succeeded') {
        await this.documentRepository.updateStatus(tenant, job.documentId, 'processed', 'completed');
        return completed;
      }

      await this.documentRepository.updateStatus(tenant, job.documentId, 'failed', 'failed');
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown extraction failure';
      const attempts = job.attempts;

      if (attempts >= job.maxAttempts) {
        const failed = await this.queue.update(job.id, {
          status: 'failed',
          lastError: message,
          completedAt: new Date().toISOString(),
        });
        await this.documentRepository.updateStatus(tenant, job.documentId, 'failed', 'failed');
        return failed;
      }

      const retried = await this.queue.update(job.id, {
        status: 'queued',
        lastError: message,
      });
      await this.documentRepository.updateStatus(tenant, job.documentId, 'failed', 'failed');
      return retried;
    }
  }
}
