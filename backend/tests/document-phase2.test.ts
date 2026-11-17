import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { createLocalPrivateStorageAdapter } from '../src/modules/documents/storage/document-storage.js';
import { DocumentLifecycleService } from '../src/modules/documents/services/document-lifecycle.service.js';

const tenantA = { organisationId: 'org-1', userId: 'user-1', roles: ['org-admin'] };
const tenantB = { organisationId: 'org-2', userId: 'user-2', roles: ['org-admin'] };

test('uploads a validated document and stores its checksum and version metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-phase2-'));
  try {
    const store = createJsonTenantStore(root);
    const storage = createLocalPrivateStorageAdapter(root);
    const service = new DocumentLifecycleService(store, storage);

    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
    const result = await service.uploadDocument({
      tenant: tenantA,
      title: 'Billing policy',
      fileName: 'billing-policy.pdf',
      mimeType: 'application/pdf',
      content: pdf,
      createdBy: tenantA.userId,
    });

    assert.equal(result.document.status, 'uploaded');
    assert.equal(result.document.processingStatus, 'queued');
    assert.equal(result.version.checksumSha256, result.document.checksumSha256);
    assert.match(result.document.storageKey, /^private\/org-1\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unsupported file types and oversized uploads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-phase2-'));
  try {
    const store = createJsonTenantStore(root);
    const storage = createLocalPrivateStorageAdapter(root);
    const service = new DocumentLifecycleService(store, storage);

    await assert.rejects(
      service.uploadDocument({
        tenant: tenantA,
        title: 'bad file',
        fileName: 'payload.exe',
        mimeType: 'application/octet-stream',
        content: Buffer.from('not-a-supported-type'),
        createdBy: tenantA.userId,
      }),
      /Unsupported file extension|Unsupported MIME type/,
    );

    const oversized = Buffer.alloc(26 * 1024 * 1024, 'x');
    await assert.rejects(
      service.uploadDocument({
        tenant: tenantA,
        title: 'too large',
        fileName: 'large.pdf',
        mimeType: 'application/pdf',
        content: oversized,
        createdBy: tenantA.userId,
      }),
      /exceeds the approved size limit/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('creates short-lived download tokens that are tenant-scoped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-phase2-'));
  try {
    const store = createJsonTenantStore(root);
    const storage = createLocalPrivateStorageAdapter(root);
    const service = new DocumentLifecycleService(store, storage);

    const pdf = Buffer.from('%PDF-1.4\nversion\n%%EOF');
    const result = await service.uploadDocument({
      tenant: tenantA,
      title: 'Downloadable policy',
      fileName: 'downloadable.pdf',
      mimeType: 'application/pdf',
      content: pdf,
      createdBy: tenantA.userId,
    });

    const token = await service.createDownloadToken(tenantA, result.document.id);
    assert.ok(token);

    const download = await service.downloadDocument(tenantA, token!);
    assert.ok(download);
    assert.equal(download?.toString('ascii'), pdf.toString('ascii'));

    const blocked = await service.downloadDocument(tenantB, token!);
    assert.equal(blocked, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
