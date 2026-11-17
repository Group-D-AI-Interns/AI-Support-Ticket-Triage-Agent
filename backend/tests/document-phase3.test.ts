import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { createLocalPrivateStorageAdapter } from '../src/modules/documents/storage/document-storage.js';
import { DocumentLifecycleService } from '../src/modules/documents/services/document-lifecycle.service.js';
import { InMemoryExtractionQueue } from '../src/modules/documents/queue/in-memory-extraction-queue.js';
import { ExtractionWorker } from '../src/modules/documents/workers/extraction-worker.js';
import { MockExtractionAdapter } from '../src/modules/documents/services/mock-extraction-adapter.js';

const tenantA = { organisationId: 'org-1', userId: 'user-1', roles: ['org-admin'] };
const tenantB = { organisationId: 'org-2', userId: 'user-2', roles: ['org-admin'] };

test('creates and processes a document extraction job with tenant isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-phase3-'));
  try {
    const store = createJsonTenantStore(root);
    const storage = createLocalPrivateStorageAdapter(root);
    const lifecycle = new DocumentLifecycleService(store, storage);
    const queue = new InMemoryExtractionQueue(store);
    const adapter = new MockExtractionAdapter();
    const worker = new ExtractionWorker(store, queue, adapter);

    const uploaded = await lifecycle.uploadDocument({
      tenant: tenantA,
      title: 'Quarterly policy',
      fileName: 'policy.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.4\ncontent\n%%EOF'),
      createdBy: tenantA.userId,
    });

    const job = await queue.enqueue({
      id: 'job-1',
      organisationId: tenantA.organisationId,
      documentId: uploaded.document.id,
      documentVersionId: uploaded.version.id,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      correlationId: 'corr-1',
      executionId: 'exec-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const processed = await worker.processNextForTenant(tenantA);
    assert.equal(processed?.status, 'succeeded');
    assert.equal(processed?.executionId, 'exec-1');

    const document = await lifecycle.getDocument(tenantA, uploaded.document.id);
    assert.equal(document?.processingStatus, 'completed');

    const blocked = await worker.processNextForTenant(tenantB);
    assert.equal(blocked, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retries failed extraction jobs without cross-tenant access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-phase3-retry-'));
  try {
    const store = createJsonTenantStore(root);
    const storage = createLocalPrivateStorageAdapter(root);
    const lifecycle = new DocumentLifecycleService(store, storage);
    const queue = new InMemoryExtractionQueue(store);
    const adapter = new MockExtractionAdapter({ failOnce: true });
    const worker = new ExtractionWorker(store, queue, adapter);

    const uploaded = await lifecycle.uploadDocument({
      tenant: tenantA,
      title: 'Retry policy',
      fileName: 'retry.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.4\nretry\n%%EOF'),
      createdBy: tenantA.userId,
    });

    const job = await queue.enqueue({
      id: 'job-retry',
      organisationId: tenantA.organisationId,
      documentId: uploaded.document.id,
      documentVersionId: uploaded.version.id,
      status: 'queued',
      attempts: 0,
      maxAttempts: 2,
      correlationId: 'corr-retry',
      executionId: 'exec-retry',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await worker.processNextForTenant(tenantA);
    const retrieved = await queue.getById(tenantA, job.id);
    assert.equal(retrieved?.status, 'queued');
    assert.equal(retrieved?.attempts, 1);

    await worker.processNextForTenant(tenantA);
    const finalState = await queue.getById(tenantA, job.id);
    assert.equal(finalState?.status, 'succeeded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
