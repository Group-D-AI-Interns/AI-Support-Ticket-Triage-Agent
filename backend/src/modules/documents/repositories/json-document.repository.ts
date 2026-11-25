import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import type { TenantContext } from '../../../shared/tenant.js';
import type { DocumentRecord, DocumentVersionRecord } from '../domain/document.js';
import type { DocumentRepository } from './document.repository.js';

export class JsonDocumentRepository implements DocumentRepository {
  constructor(private readonly store: JsonTenantStore) {}

  async create(document: DocumentRecord, tenant: TenantContext): Promise<DocumentRecord> {
    if (document.organisationId !== tenant.organisationId) {
      throw new Error('Document organisation does not match tenant context.');
    }
    const existing = await this.store.queryCollection<DocumentRecord>('documents', { id: document.id });
    if (existing.length) throw new Error(`Document ${document.id} already exists.`);
    return this.store.updateTenantCollection<DocumentRecord, DocumentRecord>('documents', tenant.organisationId, (documents) => {
      if (documents.some((item) => item.id === document.id)) {
        throw new Error(`Document ${document.id} already exists.`);
      }
      documents.push(document);
      return document;
    });
  }

  async getById(tenant: TenantContext, documentId: string): Promise<DocumentRecord | null> {
    return (await this.store.queryCollection<DocumentRecord>('documents', {
      id: documentId, organisationId: tenant.organisationId,
    }))[0] ?? null;
  }

  async getVersionById(
    tenant: TenantContext,
    versionId: string,
  ): Promise<DocumentVersionRecord | null> {
    return (await this.store.queryCollection<DocumentVersionRecord>('documentVersions', {
      id: versionId, organisationId: tenant.organisationId,
    }))[0] ?? null;
  }

  async list(tenant: TenantContext, filters?: { status?: string }): Promise<DocumentRecord[]> {
    return this.store.queryCollection<DocumentRecord>('documents', {
      organisationId: tenant.organisationId,
      ...(filters?.status ? { status: filters.status } : {}),
    });
  }

  async updateStatus(
    tenant: TenantContext,
    documentId: string,
    status: DocumentRecord['status'],
    processingStatus?: DocumentRecord['processingStatus'],
  ): Promise<DocumentRecord | null> {
    return this.store.updateTenantCollection<DocumentRecord, DocumentRecord | null>('documents', tenant.organisationId, (documents) => {
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
    const existing = await this.store.queryCollection<DocumentVersionRecord>('documentVersions', { id: version.id });
    if (existing.length) throw new Error(`Document version ${version.id} already exists.`);
    return this.store.updateTenantCollection<DocumentVersionRecord, DocumentVersionRecord>('documentVersions', tenant.organisationId, (versions) => {
      if (versions.some((item) => item.id === version.id)) {
        throw new Error(`Document version ${version.id} already exists.`);
      }
      versions.push(version);
      return version;
    });
  }
}
