import { randomUUID } from 'node:crypto';

import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import type { TenantContext } from '../../../shared/tenant.js';
import { JsonDocumentRepository } from '../repositories/json-document.repository.js';
import type { DocumentRecord, DocumentVersionRecord } from '../domain/document.js';
import type { DocumentStorageAdapter } from '../storage/document-storage.js';
import { validateDocumentUpload } from '../validators/document-validation.js';

export type UploadDocumentInput = {
  tenant: TenantContext;
  title: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
  createdBy: string;
};

export class DocumentLifecycleService {
  constructor(
    private readonly store: JsonTenantStore,
    private readonly storage: DocumentStorageAdapter,
  ) {}

  private get repository(): JsonDocumentRepository {
    return new JsonDocumentRepository(this.store);
  }

  async uploadDocument(input: UploadDocumentInput): Promise<{
    document: DocumentRecord;
    version: DocumentVersionRecord;
    downloadToken: string;
  }> {
    const { tenant, title, fileName, mimeType, content, createdBy } = input;
    validateDocumentUpload(tenant, fileName, mimeType, content);

    const documentId = `doc-${randomUUID()}`;
    const storageInfo = await this.storage.storeDocument(tenant, documentId, fileName, content, mimeType);

    const timestamp = new Date().toISOString();
    const document: DocumentRecord = {
      id: documentId,
      organisationId: tenant.organisationId,
      title,
      status: 'uploaded',
      fileName,
      mimeType,
      storageKey: storageInfo.storageKey,
      checksumSha256: storageInfo.checksumSha256,
      createdBy,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      fileSizeBytes: storageInfo.fileSizeBytes,
      provider: 'private-storage',
      processingStatus: 'queued',
    };

    await this.repository.create(document, tenant);

    const version: DocumentVersionRecord = {
      id: `doc-version-${randomUUID()}`,
      documentId: documentId,
      organisationId: tenant.organisationId,
      version: 1,
      checksumSha256: storageInfo.checksumSha256,
      fileName,
      mimeType,
      storageKey: storageInfo.storageKey,
      fileSizeBytes: storageInfo.fileSizeBytes,
      createdAt: timestamp,
      createdBy,
    };

    await this.repository.addVersion(version, tenant);

    const downloadToken = await this.storage.createDownloadToken(tenant, documentId, storageInfo.storageKey);

    return { document, version, downloadToken };
  }

  async listDocuments(tenant: TenantContext): Promise<DocumentRecord[]> {
    return this.repository.list(tenant);
  }

  async getDocument(tenant: TenantContext, documentId: string): Promise<DocumentRecord | null> {
    return this.repository.getById(tenant, documentId);
  }

  async updateProcessingStatus(
    tenant: TenantContext,
    documentId: string,
    status: DocumentRecord['status'],
    processingStatus: DocumentRecord['processingStatus'],
  ): Promise<DocumentRecord | null> {
    return this.repository.updateStatus(tenant, documentId, status, processingStatus);
  }

  async createDownloadToken(tenant: TenantContext, documentId: string): Promise<string | null> {
    const document = await this.repository.getById(tenant, documentId);
    if (!document) {
      return null;
    }

    return this.storage.createDownloadToken(tenant, documentId, document.storageKey);
  }

  async validateDownloadToken(tenant: TenantContext, token: string): Promise<{ documentId: string; storageKey: string } | null> {
    return this.storage.validateDownloadToken(tenant, token);
  }

  async downloadDocument(tenant: TenantContext, token: string): Promise<Buffer | null> {
    const validated = await this.storage.validateDownloadToken(tenant, token);
    if (!validated) {
      return null;
    }

    const document = await this.repository.getById(tenant, validated.documentId);
    if (!document) {
      return null;
    }

    return this.storage.getDocument(tenant, document.storageKey);
  }
}
