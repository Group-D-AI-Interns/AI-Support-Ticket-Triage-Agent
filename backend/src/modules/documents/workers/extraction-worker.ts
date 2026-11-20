import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import { JsonDocumentRepository } from '../repositories/json-document.repository.js';
import type { ExtractionJobQueue } from '../queue/extraction-queue.js';
import type { ExtractionJobRecord } from '../domain/extraction-job.js';
import type { TenantContext } from '../../../shared/tenant.js';
import type { ExtractionAdapter } from '../services/extraction-adapter.js';
import { validateExtractionAdapterResult } from '../services/extraction-adapter.js';
import type { DocumentStorageAdapter } from '../storage/document-storage.js';
import type { CandidateRuleService } from '../services/candidate-rule-service.js';
import type { DocumentExtractionRecord } from '../services/document-processing.service.js';
import type { DocumentRecord } from '../domain/document.js';
import {
  LocalDocumentTextConverter,
  type DocumentTextConverter,
} from '../services/document-text-converter.js';

class PermanentExtractionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PermanentExtractionError';
  }
}

export class ExtractionWorker {
  constructor(
    private readonly store: JsonTenantStore,
    private readonly queue: ExtractionJobQueue,
    private readonly adapter: ExtractionAdapter,
    private readonly storage: DocumentStorageAdapter,
    private readonly candidateRules: CandidateRuleService,
    private readonly textConverter: DocumentTextConverter = new LocalDocumentTextConverter(),
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
        throw new PermanentExtractionError(
          'DOCUMENT_NOT_FOUND',
          'Document not found for tenant or inaccessible.',
        );
      }

      const version = await this.documentRepository.getVersionById(tenant, job.documentVersionId);
      if (
        !version
        || version.documentId !== document.id
        || version.organisationId !== tenant.organisationId
        || version.version !== document.version
      ) {
        throw new PermanentExtractionError(
          'DOCUMENT_VERSION_NOT_FOUND',
          'Document version not found for the extraction job.',
        );
      }
      if (
        !['txt', 'pdf', 'docx'].includes(version.fileName.split('.').pop()?.toLowerCase() ?? '')
      ) {
        throw new PermanentExtractionError(
          'UNSUPPORTED_DOCUMENT_TYPE',
          'Only TXT, PDF and DOCX documents are supported. Legacy DOC conversion remains deferred.',
        );
      }

      try {
        await this.candidateRules.assertPolicyVersionTarget(
          tenant,
          job.policyId,
          job.policyVersionId,
        );
      } catch {
        throw new PermanentExtractionError(
          'POLICY_VERSION_NOT_FOUND',
          'The extraction job policy version is missing or inaccessible.',
        );
      }

      const storedContent = await this.storage.getDocument(tenant, version.storageKey);
      if (!storedContent) {
        throw new Error('Document content could not be loaded from private storage.');
      }

      let converted;
      try {
        converted = await this.textConverter.convert(storedContent, version);
      } catch (error) {
        throw new PermanentExtractionError(
          'DOCUMENT_CONVERSION_FAILED',
          error instanceof Error ? error.message : 'Document text conversion failed.',
        );
      }

      const result = validateExtractionAdapterResult(await this.adapter.extract({
        tenant,
        documentId: job.documentId,
        documentVersionId: job.documentVersionId,
        executionId: job.executionId,
        content: converted.content,
        segments: converted.segments,
      }));
      if (result.executionId !== job.executionId) {
        throw new Error('Extraction result execution ID does not match the claimed job.');
      }
      if (result.rules.some((rule) => (
        rule.documentId !== job.documentId
        || rule.documentVersionId !== job.documentVersionId
        || !rule.evidence.some((item) => (
          item.sourceType === 'document'
          && item.sourceId === job.documentId
          && item.versionId === job.documentVersionId
        ))
      ))) {
        throw new PermanentExtractionError(
          'EXTRACTION_PROVENANCE_MISMATCH',
          'Extraction result provenance does not match the claimed document version.',
        );
      }

      if (result.status === 'failed') {
        return this.recordFailure(
          tenant,
          job,
          result.failure.code,
          result.failure.retryable,
          result.executionMetadata,
          result.warnings,
        );
      }

      const currentDocument = await this.documentRepository.getById(tenant, job.documentId);
      if (!currentDocument || currentDocument.version !== version.version) {
        throw new PermanentExtractionError('DOCUMENT_VERSION_CHANGED', 'The source document version changed during extraction.');
      }
      await this.candidateRules.persistCandidateRules({
        tenant,
        policyId: job.policyId,
        policyVersionId: job.policyVersionId,
        executionId: job.executionId,
        rules: result.rules,
      });

      // Make worker extraction visible through the existing document detail/history API.
      await this.store.withCollectionLock('documentExtractions', async () => {
        const records = await this.store.readCollection<DocumentExtractionRecord>('documentExtractions');
        const id = `document-extraction-${job.executionId}`;
        if (!records.some(record => record.id === id && record.organisationId === tenant.organisationId)) {
          records.push({ id, organisationId: tenant.organisationId, documentId: job.documentId,
            documentVersionId: job.documentVersionId, createdAt: new Date().toISOString(), result });
          await this.store.writeCollection('documentExtractions', records);
        }
      });

      const completed = await this.queue.update(job.id, {
        status: 'succeeded',
        completedAt: new Date().toISOString(),
        lastError: undefined,
        warnings: result.warnings,
        executionMetadata: result.executionMetadata,
      });

      if (!completed) {
        return null;
      }

      await this.updateJobDocument(tenant, job, 'processed', 'completed');
      return completed;
    } catch (error) {
      const retryable = !(error instanceof PermanentExtractionError);
      const errorCode = error instanceof PermanentExtractionError
        ? error.code
        : 'EXTRACTION_ATTEMPT_FAILED';
      return this.recordFailure(tenant, job, errorCode, retryable);
    }
  }

  private async recordFailure(
    tenant: TenantContext,
    job: ExtractionJobRecord,
    errorCode: string,
    retryable: boolean,
    executionMetadata?: ExtractionJobRecord['executionMetadata'],
    warnings?: string[],
  ): Promise<ExtractionJobRecord | null> {
    const shouldRetry = retryable && job.attempts < job.maxAttempts;
    const updated = await this.queue.update(job.id, {
      status: shouldRetry ? 'queued' : 'failed',
      lastError: errorCode,
      completedAt: shouldRetry ? undefined : new Date().toISOString(),
      executionMetadata,
      warnings,
    });
    if (!updated) {
      return null;
    }

    await this.updateJobDocument(
      tenant, job,
      shouldRetry ? 'processing' : 'failed',
      shouldRetry ? 'queued' : 'failed',
    );
    return updated;
  }

  private async updateJobDocument(tenant: TenantContext, job: ExtractionJobRecord, status: DocumentRecord['status'], processingStatus: DocumentRecord['processingStatus']) {
    const document = await this.documentRepository.getById(tenant, job.documentId);
    const version = await this.documentRepository.getVersionById(tenant, job.documentVersionId);
    if (document && version && document.version === version.version) {
      await this.documentRepository.updateStatus(tenant, document.id, status, processingStatus);
    }
  }
}
