import { randomUUID } from 'node:crypto';

import type { DocumentStorageAdapter } from '../../documents/storage/document-storage.js';
import {
  DocumentValidationError,
  validateDocumentUpload,
} from '../../documents/validators/document-validation.js';
import type { TenantContext } from '../../../shared/tenant.js';
import type { TicketAttachment } from '../domain/ticket.js';
import { JsonTicketStore } from '../repositories/json-ticket.store.js';

export class TicketAttachmentValidationError extends Error {}

export class TicketAttachmentService {
  constructor(
    private readonly ticketStore: JsonTicketStore,
    private readonly storage: DocumentStorageAdapter,
  ) {}

  async upload(
    tenant: TenantContext,
    ticketId: string,
    file: { fileName: string; mimeType: string; content: Buffer },
  ): Promise<TicketAttachment | null> {
    try {
      validateDocumentUpload(
        tenant,
        file.fileName,
        file.mimeType,
        file.content,
        { allowImages: true },
      );
    } catch (error) {
      if (error instanceof DocumentValidationError) {
        throw new TicketAttachmentValidationError(error.message);
      }
      throw error;
    }

    const attachmentId = `attachment_${randomUUID().replace(/-/g, '')}`;
    const storedFile = await this.storage.storeDocument(
      tenant,
      attachmentId,
      file.fileName,
      file.content,
      file.mimeType,
    );

    let result: Awaited<ReturnType<JsonTicketStore['addAttachment']>>;
    try {
      result = await this.ticketStore.addAttachment(tenant, ticketId, {
        id: attachmentId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        storageKey: storedFile.storageKey,
        checksumSha256: storedFile.checksumSha256,
        fileSizeBytes: storedFile.fileSizeBytes,
        uploadedBy: tenant.userId,
      });
    } catch (error) {
      try {
        await this.storage.deleteDocument(tenant, storedFile.storageKey);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Ticket attachment could not be saved or rolled back.',
        );
      }
      throw error;
    }
    if (!result) {
      await this.storage.deleteDocument(tenant, storedFile.storageKey);
      return null;
    }
    return result[1];
  }

  async download(
    tenant: TenantContext,
    ticketId: string,
    attachmentId: string,
  ): Promise<{ attachment: TicketAttachment; content: Buffer } | null> {
    const ticket = await this.ticketStore.findTicket(tenant, ticketId);
    const attachment = ticket?.attachments?.find(
      (item) => item.id === attachmentId,
    );
    if (!attachment) {
      return null;
    }

    const content = await this.storage.getDocument(
      tenant,
      attachment.storageKey,
    );
    return content ? { attachment, content } : null;
  }
}
