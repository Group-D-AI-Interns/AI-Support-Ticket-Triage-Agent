import test from 'node:test';
import assert from 'node:assert/strict';

import { LocalDocumentTextConverter } from '../src/modules/documents/services/document-text-converter.js';
import type { DocumentVersionRecord } from '../src/modules/documents/domain/document.js';
import { policyDocx, policyPdf } from './fixtures/document-fixtures.js';

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

test('converts validated Markdown policy sources as strict UTF-8 text', async () => {
  const content = '# SLA policy\n\nRespond within two hours.';
  const result = await new LocalDocumentTextConverter().convert(Buffer.from(content), {
    ...baseVersion, fileName: 'service-level-agreement.md', mimeType: 'text/markdown',
  });
  assert.equal(result.format, 'md');
  assert.equal(result.content, content);
  assert.deepEqual(result.segments, [{ text: content, section: 'document' }]);
});

test('rejects invalid DOCX content', async () => {
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

test('converts valid PDF text and retains the source page', async () => {
  const result = await new LocalDocumentTextConverter().convert(policyPdf(), {
    ...baseVersion, fileName: 'policy.pdf', mimeType: 'application/pdf',
  });
  assert.equal(result.format, 'pdf');
  assert.match(result.content, /Respond within two hours\./);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.page, 1);
  assert.match(result.segments[0]!.text, /Respond within two hours\./);
});

test('converts valid DOCX text and retains both paragraph sections', async () => {
  const result = await new LocalDocumentTextConverter().convert(policyDocx(), {
    ...baseVersion, fileName: 'policy.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  assert.equal(result.format, 'docx');
  assert.deepEqual(result.segments, [
    { text: 'Respond within two hours.', section: 'paragraph-1' },
    { text: 'Escalate unresolved cases to the service desk.', section: 'paragraph-2' },
  ]);
});

test('rejects legacy DOC and unsupported formats explicitly', async () => {
  const converter = new LocalDocumentTextConverter();

  await assert.rejects(
    converter.convert(Buffer.from('legacy doc'), { ...baseVersion, fileName: 'policy.doc', mimeType: 'application/msword' }),
    /Unsupported document format|Legacy/i,
  );
});
