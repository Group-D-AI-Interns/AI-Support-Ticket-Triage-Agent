import type { TenantContext } from '../../../shared/tenant.js';

export const MAX_DOCUMENT_SIZE_BYTES = 25 * 1024 * 1024;

export class DocumentValidationError extends Error {}

const allowedMimeTypes = new Set([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const allowedExtensions = new Set(['pdf', 'txt', 'doc', 'docx']);
const imageMimeTypes = new Map([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
]);

export type DocumentUploadValidationOptions = {
  allowImages?: boolean;
};

export function validateDocumentUpload(
  tenant: TenantContext,
  fileName: string,
  mimeType: string,
  buffer: Buffer,
  options: DocumentUploadValidationOptions = {},
): void {
  if (!tenant?.organisationId) {
    throw new DocumentValidationError('Tenant context is required.');
  }

  if (!fileName || !fileName.trim()) {
    throw new DocumentValidationError('Document file name is required.');
  }
  if (/[\\/\u0000-\u001f\u007f]/.test(fileName)) {
    throw new DocumentValidationError('File name must not contain path separators or control characters.');
  }

  if (buffer.length === 0) {
    throw new DocumentValidationError('Document content cannot be empty.');
  }

  if (buffer.length > MAX_DOCUMENT_SIZE_BYTES) {
    throw new DocumentValidationError('Document exceeds the approved size limit.');
  }

  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  const expectedImageMimeType = imageMimeTypes.get(extension);
  const isAllowedImage = options.allowImages === true && expectedImageMimeType !== undefined;
  if (!allowedExtensions.has(extension) && !isAllowedImage) {
    throw new DocumentValidationError(
      `Unsupported file extension: .${extension || 'unknown'}`,
    );
  }

  if (
    (isAllowedImage && mimeType !== expectedImageMimeType) ||
    (!isAllowedImage && !allowedMimeTypes.has(mimeType))
  ) {
    throw new DocumentValidationError(`Unsupported MIME type: ${mimeType}`);
  }

  if (isAllowedImage && !hasValidImageSignature(extension, buffer)) {
    throw new DocumentValidationError(
      'Image content does not match the selected file type.',
    );
  }

  if (extension === 'pdf' && !buffer.subarray(0, 5).toString('ascii').startsWith('%PDF-')) {
    throw new DocumentValidationError('Uploaded PDF content is corrupted or invalid.');
  }

  if (extension === 'txt' && mimeType !== 'text/plain') {
    throw new DocumentValidationError('Text file MIME type does not match the extension.');
  }
}

function hasValidImageSignature(extension: string, buffer: Buffer): boolean {
  if (extension === 'jpg' || extension === 'jpeg') {
    return (
      buffer.length >= 4 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff &&
      buffer.at(-2) === 0xff &&
      buffer.at(-1) === 0xd9
    );
  }

  if (extension === 'png') {
    return (
      buffer.length >= 24 &&
      buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ) &&
      buffer.subarray(12, 16).toString('ascii') === 'IHDR' &&
      buffer.readUInt32BE(16) > 0 &&
      buffer.readUInt32BE(20) > 0
    );
  }

  if (extension === 'webp') {
    return (
      buffer.length >= 16 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.subarray(12, 16).toString('ascii')) &&
      buffer.readUInt32LE(4) + 8 <= buffer.length
    );
  }

  return false;
}
