import type { TenantContext } from '../../../shared/tenant.js';

export const MAX_DOCUMENT_SIZE_BYTES = 25 * 1024 * 1024;

const allowedMimeTypes = new Set([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const allowedExtensions = new Set(['pdf', 'txt', 'doc', 'docx']);

export function validateDocumentUpload(
  tenant: TenantContext,
  fileName: string,
  mimeType: string,
  buffer: Buffer,
): void {
  if (!tenant?.organisationId) {
    throw new Error('Tenant context is required.');
  }

  if (!fileName || !fileName.trim()) {
    throw new Error('Document file name is required.');
  }

  if (buffer.length === 0) {
    throw new Error('Document content cannot be empty.');
  }

  if (buffer.length > MAX_DOCUMENT_SIZE_BYTES) {
    throw new Error('Document exceeds the approved size limit.');
  }

  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!allowedExtensions.has(extension)) {
    throw new Error(`Unsupported file extension: .${extension || 'unknown'}`);
  }

  if (!allowedMimeTypes.has(mimeType)) {
    throw new Error(`Unsupported MIME type: ${mimeType}`);
  }

  if (extension === 'pdf' && !buffer.subarray(0, 5).toString('ascii').startsWith('%PDF-')) {
    throw new Error('Uploaded PDF content is corrupted or invalid.');
  }

  if (extension === 'txt' && mimeType !== 'text/plain') {
    throw new Error('Text file MIME type does not match the extension.');
  }
}
