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

    await assert.rejects(
      service.uploadDocument({
        tenant: tenantA,
        title: 'image remains unsupported for documents',
        fileName: 'photo.png',
        mimeType: 'image/png',
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        createdBy: tenantA.userId,
      }),
      /Unsupported file extension/,
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

test('rejects document MIME types that do not match the filename extension', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-mime-mismatch-'));
  try {
    const service = new DocumentLifecycleService(
      createJsonTenantStore(root),
      createLocalPrivateStorageAdapter(root),
    );
    await assert.rejects(service.uploadDocument({
      tenant: tenantA,
      title: 'Mismatched upload',
      fileName: 'contract.pdf',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: Buffer.from('%PDF-1.4\nsynthetic'),
      createdBy: tenantA.userId,
    }), /Unsupported MIME type/);
    await assert.rejects(service.uploadDocument({
      tenant: tenantA,
      title: 'Invalid Word container',
      fileName: 'contract.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: Buffer.from('not a ZIP-based Word document'),
      createdBy: tenantA.userId,
    }), /does not match the selected file type/);
    await assert.rejects(service.uploadDocument({
      tenant: tenantA,
      title: 'Invalid legacy Word container',
      fileName: 'contract.doc',
      mimeType: 'application/msword',
      content: Buffer.from('not a legacy Word document'),
      createdBy: tenantA.userId,
    }), /does not match the selected file type/);
    await assert.rejects(service.uploadDocument({
      tenant: tenantA,
      title: 'Mismatched upload',
      fileName: 'contract.docx',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.4\nsynthetic'),
      createdBy: tenantA.userId,
    }), /Unsupported MIME type/);
    await assert.rejects(service.uploadDocument({
      tenant: tenantA,
      title: 'Mismatched upload',
      fileName: 'contract.doc',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.4\nsynthetic'),
      createdBy: tenantA.userId,
    }), /Unsupported MIME type/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts a Markdown policy as a supported UTF-8 source document', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-markdown-'));
  try {
    const store = createJsonTenantStore(root);
    const storage = createLocalPrivateStorageAdapter(root);
    const service = new DocumentLifecycleService(store, storage);
    const result = await service.uploadDocument({
      tenant: tenantA,
      title: 'Service level agreement',
      fileName: 'service-level-agreement.md',
      mimeType: 'text/markdown',
      content: Buffer.from('# SLA policy\n\nRespond within two hours.'),
      createdBy: tenantA.userId,
    });
    assert.equal(result.document.fileName, 'service-level-agreement.md');
    assert.equal(result.version.mimeType, 'text/markdown');
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
