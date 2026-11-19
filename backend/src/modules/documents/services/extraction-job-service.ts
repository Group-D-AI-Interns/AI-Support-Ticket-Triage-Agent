import { randomUUID } from 'node:crypto';

import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import type { TenantContext } from '../../../shared/tenant.js';
import type { ExtractionJobRecord } from '../domain/extraction-job.js';
import { JsonDocumentRepository } from '../repositories/json-document.repository.js';
import { InMemoryExtractionQueue } from '../queue/in-memory-extraction-queue.js';
import type { JsonPolicyRepository } from '../../policies/repositories/json-policy.repository.js';

export type ProcessDocumentInput = {
  tenant: TenantContext;
  documentId: string;
  policyId: string;
  policyVersionId: string;
  maxAttempts?: number;
};

export class ExtractionJobService {
  constructor(
    private readonly store: JsonTenantStore,
    private readonly policyRepository: JsonPolicyRepository,
  ) {}

  async processDocument(input: ProcessDocumentInput): Promise<ExtractionJobRecord> {
    const documentRepository = new JsonDocumentRepository(this.store);
    const document = await documentRepository.getById(input.tenant, input.documentId);
    if (!document) {
      throw new Error('Document does not exist for this tenant.');
    }

    const versions = await this.store.readCollection<{ id: string; documentId: string; organisationId: string }>('documentVersions');
    const version = versions
      .filter((item) => item.organisationId === input.tenant.organisationId)
      .find((item) => item.documentId === document.id);
    if (!version) {
      throw new Error('Document version does not exist for this tenant.');
    }

    const policyVersion = await this.policyRepository.getVersionById(input.tenant, input.policyVersionId);
    if (!policyVersion || policyVersion.policyId !== input.policyId) {
      throw new Error('Policy version is missing or outside the requested policy.');
    }

    const timestamp = new Date().toISOString();
    const job: ExtractionJobRecord = {
      id: `extraction-${randomUUID()}`,
      organisationId: input.tenant.organisationId,
      policyId: input.policyId,
      policyVersionId: input.policyVersionId,
      documentId: document.id,
      documentVersionId: version.id,
      status: 'queued',
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      correlationId: `corr-${randomUUID()}`,
      executionId: `exec-${randomUUID()}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await documentRepository.updateStatus(input.tenant, document.id, 'processing', 'queued');
    return new InMemoryExtractionQueue(this.store).enqueue(job);
  }
}
