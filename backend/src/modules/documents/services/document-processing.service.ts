import { randomUUID } from 'node:crypto';

import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import type { TenantContext } from '../../../shared/tenant.js';
import type { DocumentRecord } from '../domain/document.js';
import type { DocumentLifecycleService } from './document-lifecycle.service.js';
import {
  validateExtractionAdapterResult,
  type ExtractionAdapterResult,
} from './extraction-adapter.js';
import {
  ProvisionalExtractionAdapter,
} from './provisional-extraction-adapter.js';
import type { DocumentStorageAdapter } from '../storage/document-storage.js';
import {
  LocalDocumentTextConverter,
  type DocumentTextConverter,
} from './document-text-converter.js';

export type DocumentExtractionRecord = {
  id: string;
  organisationId: string;
  documentId: string;
  documentVersionId: string;
  createdAt: string;
  result: ExtractionAdapterResult;
};

export class DocumentProcessingError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_EXTRACTION_FORMAT'
      | 'INVALID_TEXT_ENCODING'
      | 'DOCUMENT_NOT_READY'
      | 'EXTRACTION_FAILED',
    message: string,
  ) {
    super(message);
  }
}

export class DocumentProcessingService {
  constructor(
    private readonly store: JsonTenantStore,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly storage: DocumentStorageAdapter,
    private readonly adapter = new ProvisionalExtractionAdapter(),
    private readonly converter: DocumentTextConverter = new LocalDocumentTextConverter(),
  ) {}

  async processDocument(
    tenant: TenantContext,
    documentId: string,
  ): Promise<{ document: DocumentRecord; extraction: DocumentExtractionRecord } | null> {
    const document = await this.lifecycle.getDocument(tenant, documentId);
    if (!document) {
      return null;
    }

    if (document.status === 'processed' && document.processingStatus === 'completed') {
      const existing = await this.getExtraction(tenant, documentId);
      if (existing) {
        return { document, extraction: existing };
      }
    }

    if (document.processingStatus === 'processing') {
      throw new DocumentProcessingError('DOCUMENT_NOT_READY', 'Document processing is already in progress.');
    }

    const versions = await this.store.readCollection<{
      id: string;
      documentId: string;
      organisationId: string;
      version: number;
    }>('documentVersions');
    const version = versions.find(
      (item) =>
        item.documentId === document.id &&
        item.organisationId === tenant.organisationId &&
        item.version === document.version,
    );
    if (!version) {
      throw new DocumentProcessingError('DOCUMENT_NOT_READY', 'The current document version is unavailable.');
    }

    if (!['txt', 'pdf', 'docx'].includes(document.fileName.split('.').pop()?.toLowerCase() ?? '')) {
      await this.lifecycle.updateProcessingStatus(tenant, document.id, 'failed', 'failed');
      throw new DocumentProcessingError(
        'UNSUPPORTED_EXTRACTION_FORMAT',
        'Only TXT, PDF and DOCX source documents are supported. Legacy DOC conversion remains deferred.',
      );
    }

    await this.lifecycle.updateProcessingStatus(tenant, document.id, 'processing', 'processing');
    try {
      const content = await this.storage.getDocument(tenant, document.storageKey);
      if (!content) {
        throw new DocumentProcessingError('DOCUMENT_NOT_READY', 'The stored source document is unavailable.');
      }

      let converted;
      try {
        const versionRecord = {
          id: version.id,
          documentId: document.id,
          organisationId: tenant.organisationId,
          version: document.version,
          checksumSha256: document.checksumSha256,
          fileName: document.fileName,
          mimeType: document.mimeType,
          storageKey: document.storageKey,
          fileSizeBytes: document.fileSizeBytes,
          createdAt: document.createdAt,
          createdBy: document.createdBy,
        };
        converted = await this.converter.convert(content, versionRecord);
      } catch (error) {
        if (error instanceof TypeError) {
          throw new DocumentProcessingError('INVALID_TEXT_ENCODING', 'The source document is not valid UTF-8 text.');
        }
        throw new DocumentProcessingError(
          'EXTRACTION_FAILED',
          error instanceof Error ? error.message : 'Document text conversion failed.',
        );
      }

      const executionId = `exec-${randomUUID()}`;
      const result = validateExtractionAdapterResult(await this.adapter.extract({
        tenant,
        documentId: document.id,
        documentVersionId: version.id,
        executionId,
        content: converted.content,
        segments: converted.segments,
      }));
      if (result.status === 'failed') {
        throw new DocumentProcessingError(
          'EXTRACTION_FAILED',
          'The document could not be processed.',
        );
      }
      const extraction: DocumentExtractionRecord = {
        id: `document-extraction-${randomUUID()}`,
        organisationId: tenant.organisationId,
        documentId: document.id,
        documentVersionId: version.id,
        createdAt: new Date().toISOString(),
        result,
      };
      const extractions = await this.store.readCollection<DocumentExtractionRecord>('documentExtractions');
      extractions.push(extraction);
      await this.store.writeCollection('documentExtractions', extractions);

      const processedDocument = await this.lifecycle.updateProcessingStatus(
        tenant,
        document.id,
        'processed',
        'completed',
      );
      if (!processedDocument) {
        throw new DocumentProcessingError('DOCUMENT_NOT_READY', 'The source document is no longer available.');
      }
      return { document: processedDocument, extraction };
    } catch (error) {
      await this.lifecycle.updateProcessingStatus(tenant, document.id, 'failed', 'failed');
      throw error;
    }
  }

  async getExtraction(
    tenant: TenantContext,
    documentId: string,
  ): Promise<DocumentExtractionRecord | null> {
    const extractions = await this.store.readCollection<DocumentExtractionRecord>('documentExtractions');
    return extractions
      .filter(
        (item) =>
          item.organisationId === tenant.organisationId &&
          item.documentId === documentId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }
}
