import type { TenantContext } from '../../../shared/tenant.js';
import type { DocumentRecord, DocumentVersionRecord } from '../domain/document.js';

export interface DocumentRepository {
  create(document: DocumentRecord, tenant: TenantContext): Promise<DocumentRecord>;
  getById(tenant: TenantContext, documentId: string): Promise<DocumentRecord | null>;
  list(tenant: TenantContext, filters?: { status?: string }): Promise<DocumentRecord[]>;
  updateStatus(
    tenant: TenantContext,
    documentId: string,
    status: DocumentRecord['status'],
    processingStatus?: DocumentRecord['processingStatus'],
  ): Promise<DocumentRecord | null>;
  addVersion(version: DocumentVersionRecord, tenant: TenantContext): Promise<DocumentVersionRecord>;
}
