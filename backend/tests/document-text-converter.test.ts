import test from 'node:test';
import assert from 'node:assert/strict';

import { LocalDocumentTextConverter } from '../src/modules/documents/services/document-text-converter.js';
import type { DocumentVersionRecord } from '../src/modules/documents/domain/document.js';

const baseVersion: DocumentVersionRecord = {
  id: 'version-1',
  documentId: 'document-1',
  organisationId: 'org-1',
  version: 1,
  checksumSha256: 'checksum',
  fileName: 'policy.txt',
  mimeType: 'text/plain',
  storageKey: 'private/org-1/document-1/policy.txt',
  fileSizeBytes: 20,
  createdAt: new Date().toISOString(),
  createdBy: 'admin-1',
};

test('converts text documents with a document section', async () => {
  const converter = new LocalDocumentTextConverter();
  const result = await converter.convert(Buffer.from('Respond within two hours.'), baseVersion);

  assert.equal(result.format, 'txt');
  assert.equal(result.content, 'Respond within two hours.');
  assert.deepEqual(result.segments, [{ text: 'Respond within two hours.', section: 'document' }]);
});

test('converts DOCX and exposes paragraph sections', async () => {
  const converter = new LocalDocumentTextConverter();
  await assert.rejects(
    converter.convert(Buffer.from('not a docx'), {
      ...baseVersion,
      fileName: 'policy.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    /DOCX|zip|central directory/i,
  );
});

test('rejects legacy DOC and unsupported formats explicitly', async () => {
  const converter = new LocalDocumentTextConverter();

  await assert.rejects(
    converter.convert(Buffer.from('legacy doc'), { ...baseVersion, fileName: 'policy.doc', mimeType: 'application/msword' }),
    /Unsupported document format|Legacy/i,
  );
});
