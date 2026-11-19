import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { DocumentLifecycleService } from '../src/modules/documents/services/document-lifecycle.service.js';
import {
  DocumentProcessingError,
  DocumentProcessingService,
} from '../src/modules/documents/services/document-processing.service.js';
import { createLocalPrivateStorageAdapter } from '../src/modules/documents/storage/document-storage.js';

const tenantA = { organisationId: 'org-a', userId: 'admin-a', roles: ['organisation_admin'] };
const tenantB = { organisationId: 'org-b', userId: 'admin-b', roles: ['organisation_admin'] };

function createServices(root: string) {
  const store = createJsonTenantStore(root);
  const storage = createLocalPrivateStorageAdapter(root);
  const lifecycle = new DocumentLifecycleService(store, storage);
  return {
    lifecycle,
    processing: new DocumentProcessingService(store, lifecycle, storage),
  };
}

test('processes a tenant text source and keeps extraction provenance tenant-scoped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'document-processing-'));
  try {
    const { lifecycle, processing } = createServices(root);
    const uploaded = await lifecycle.uploadDocument({
      tenant: tenantA,
      title: 'Customer support SLA',
      fileName: 'support-sla.txt',
      mimeType: 'text/plain',
      content: Buffer.from('Priority one requests receive a response within two hours.', 'utf8'),
      createdBy: tenantA.userId,
    });

    const processed = await processing.processDocument(tenantA, uploaded.document.id);

    assert.equal(processed?.document.status, 'processed');
    assert.equal(processed?.document.processingStatus, 'completed');
    assert.equal(processed?.extraction.documentVersionId, uploaded.version.id);
    assert.equal(processed?.extraction.result.rules[0]?.ruleType, 'response_time');
    assert.equal(processed?.extraction.result.rules[0]?.payload.targetHours, 2);
    assert.equal(
      await processing.getExtraction(tenantB, uploaded.document.id),
      null,
    );
    assert.deepEqual(
      await processing.processDocument(tenantA, uploaded.document.id),
      processed,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not mark unsupported source formats as processed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'document-processing-'));
  try {
    const { lifecycle, processing } = createServices(root);
    const uploaded = await lifecycle.uploadDocument({
      tenant: tenantA,
      title: 'PDF source',
      fileName: 'support-sla.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.4\npolicy\n%%EOF'),
      createdBy: tenantA.userId,
    });

    await assert.rejects(
      processing.processDocument(tenantA, uploaded.document.id),
      (error: unknown) =>
        error instanceof DocumentProcessingError &&
        error.code === 'UNSUPPORTED_EXTRACTION_FORMAT',
    );
    const unchanged = await lifecycle.getDocument(tenantA, uploaded.document.id);
    assert.equal(unchanged?.status, 'failed');
    assert.equal(unchanged?.processingStatus, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('records invalid UTF-8 processing as failed instead of succeeding silently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'document-processing-'));
  try {
    const { lifecycle, processing } = createServices(root);
    const uploaded = await lifecycle.uploadDocument({
      tenant: tenantA,
      title: 'Invalid text source',
      fileName: 'invalid.txt',
      mimeType: 'text/plain',
      content: Buffer.from([0xc3, 0x28]),
      createdBy: tenantA.userId,
    });

    await assert.rejects(
      processing.processDocument(tenantA, uploaded.document.id),
      (error: unknown) =>
        error instanceof DocumentProcessingError &&
        error.code === 'INVALID_TEXT_ENCODING',
    );
    const failed = await lifecycle.getDocument(tenantA, uploaded.document.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.processingStatus, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
