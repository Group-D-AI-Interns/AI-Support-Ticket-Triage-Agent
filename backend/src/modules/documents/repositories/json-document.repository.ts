import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import { assertTenantAccess, type TenantContext } from '../../../shared/tenant.js';
import type { DocumentRecord, DocumentVersionRecord } from '../domain/document.js';
import type { DocumentRepository } from './document.repository.js';

export class JsonDocumentRepository implements DocumentRepository {
  constructor(private readonly store: JsonTenantStore) {}

  async create(document: DocumentRecord, tenant: TenantContext): Promise<DocumentRecord> {
    if (document.organisationId !== tenant.organisationId) {
      throw new Error('Document organisation does not match tenant context.');
    }

    return this.store.updateCollection<DocumentRecord, DocumentRecord>('documents', (documents) => {
      if (documents.some((item) => item.id === document.id)) {
        throw new Error(`Document ${document.id} already exists.`);
      }
      documents.push(document);
      return document;
    });
  }

  async getById(tenant: TenantContext, documentId: string): Promise<DocumentRecord | null> {
    const documents = await this.store.readCollection<DocumentRecord>('documents');
    const record = documents.find((item) => item.id === documentId);
    return assertTenantAccess(tenant, record) ?? null;
  }

  async getVersionById(
    tenant: TenantContext,
    versionId: string,
  ): Promise<DocumentVersionRecord | null> {
    const versions = await this.store.readCollection<DocumentVersionRecord>('documentVersions');
    const record = versions.find((item) => item.id === versionId);
    return assertTenantAccess(tenant, record) ?? null;
  }

  async list(tenant: TenantContext, filters?: { status?: string }): Promise<DocumentRecord[]> {
    const documents = await this.store.readCollection<DocumentRecord>('documents');
    return documents
      .filter((item) => item.organisationId === tenant.organisationId)
      .filter((item) => (filters?.status ? item.status === filters.status : true));
  }

  async updateStatus(
    tenant: TenantContext,
    documentId: string,
    status: DocumentRecord['status'],
    processingStatus?: DocumentRecord['processingStatus'],
  ): Promise<DocumentRecord | null> {
    return this.store.updateCollection<DocumentRecord, DocumentRecord | null>('documents', (documents) => {
      const index = documents.findIndex((item) => item.id === documentId && item.organisationId === tenant.organisationId);
      const current = documents[index];
      if (index === -1 || !current) return null;

      const updated = {
        ...current,
        status,
        processingStatus: processingStatus ?? current.processingStatus,
        updatedAt: new Date().toISOString(),
      };

      documents[index] = updated;
      return updated;
    });
  }

  async addVersion(version: DocumentVersionRecord, tenant: TenantContext): Promise<DocumentVersionRecord> {
    if (version.organisationId !== tenant.organisationId) {
      throw new Error('Version organisation does not match tenant context.');
    }

    return this.store.updateCollection<DocumentVersionRecord, DocumentVersionRecord>('documentVersions', (versions) => {
      if (versions.some((item) => item.id === version.id)) {
        throw new Error(`Document version ${version.id} already exists.`);
      }
      versions.push(version);
      return version;
    });
  }
}
