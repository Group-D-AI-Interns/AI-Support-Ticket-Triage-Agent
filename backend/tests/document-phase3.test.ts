import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { createLocalPrivateStorageAdapter } from '../src/modules/documents/storage/document-storage.js';
import { DocumentLifecycleService } from '../src/modules/documents/services/document-lifecycle.service.js';
import { InMemoryExtractionQueue } from '../src/modules/documents/queue/in-memory-extraction-queue.js';
import { ExtractionWorker } from '../src/modules/documents/workers/extraction-worker.js';
import { MockExtractionAdapter } from '../src/modules/documents/services/mock-extraction-adapter.js';
import { CandidateRuleService } from '../src/modules/documents/services/candidate-rule-service.js';
import { JsonPolicyRepository } from '../src/modules/policies/repositories/json-policy.repository.js';
import { ExtractionJobService } from '../src/modules/documents/services/extraction-job-service.js';
import type { DocumentRecord } from '../src/modules/documents/domain/document.js';

const tenantA = { organisationId: 'org-1', userId: 'user-1', roles: ['org-admin'] };
const tenantB = { organisationId: 'org-2', userId: 'user-2', roles: ['org-admin'] };

test('jobs use the current document version and stale provider output cannot overwrite a newer revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'document-revision-'));
  try {
    const store = createJsonTenantStore(root);
    const storage = createLocalPrivateStorageAdapter(root);
    const lifecycle = new DocumentLifecycleService(store, storage);
    const repository = new JsonPolicyRepository(store);
    const now = new Date().toISOString();
    await repository.createPolicy({ id: 'policy-revision', organisationId: tenantA.organisationId, ownerId: tenantA.userId, policyType: 'sla', status: 'draft', version: 1, description: 'Fixture', createdAt: now, updatedAt: now }, tenantA);
    await repository.createVersion('policy-revision', { id: 'policy-version-revision', organisationId: tenantA.organisationId, policyId: 'policy-revision', version: 1, status: 'draft', effectiveFrom: null, effectiveTo: null, payload: {}, createdAt: now, updatedAt: now }, tenantA);
    const uploaded = await lifecycle.uploadDocument({ tenant: tenantA, title: 'Versioned source', fileName: 'source.txt', mimeType: 'text/plain', content: Buffer.from('Respond within two hours.'), createdBy: tenantA.userId });
    await store.writeCollection('documentVersions', [uploaded.version, { ...uploaded.version, id: 'current-version-two', version: 2 }]);
    await store.writeCollection('documents', [{ ...uploaded.document, version: 2 }]);
    const job = await new ExtractionJobService(store, repository).processDocument({ tenant: tenantA, documentId: uploaded.document.id, policyId: 'policy-revision', policyVersionId: 'policy-version-revision' });
    assert.equal(job.documentVersionId, 'current-version-two');
    const adapter = new MockExtractionAdapter();
    const worker = new ExtractionWorker(store, new InMemoryExtractionQueue(store), { async extract(input) {
      const documents = await store.readCollection<DocumentRecord>('documents');
      await store.writeCollection('documents', documents.map(document => ({ ...document, version: 3, status: 'uploaded' as const, processingStatus: 'queued' as const })));
      return adapter.extract(input);
    } }, storage, new CandidateRuleService(repository));
    const result = await worker.processNextForTenant(tenantA);
    assert.equal(result?.status, 'failed');
    assert.equal(result?.lastError, 'DOCUMENT_VERSION_CHANGED');
    assert.equal((await store.readCollection('extractedRules')).length, 0);
    const current = await lifecycle.getDocument(tenantA, uploaded.document.id);
    assert.equal(current?.version, 3);
    assert.equal(current?.status, 'uploaded');
    assert.equal(current?.processingStatus, 'queued');
  } finally { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); }
});

test('creates and processes a document extraction job with tenant isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-phase3-'));
  try {
    const store = createJsonTenantStore(root);
    const storage = createLocalPrivateStorageAdapter(root);
    const lifecycle = new DocumentLifecycleService(store, storage);
    const queue = new InMemoryExtractionQueue(store);
    const adapter = new MockExtractionAdapter();
    const policyRepository = new JsonPolicyRepository(store);
    const candidateRules = new CandidateRuleService(policyRepository);
    const worker = new ExtractionWorker(store, queue, adapter, storage, candidateRules);
    await createPolicyVersion(policyRepository);

    const uploaded = await lifecycle.uploadDocument({
      tenant: tenantA,
      title: 'Quarterly policy',
      fileName: 'policy.txt',
      mimeType: 'text/plain',
      content: Buffer.from('Respond within two hours.'),
      createdBy: tenantA.userId,
    });

    const job = await queue.enqueue({
      id: 'job-1',
      organisationId: tenantA.organisationId,
      policyId: 'policy-1',
      policyVersionId: 'policy-version-1',
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
    assert.equal(processed?.executionMetadata?.provider, 'test-mock');
    assert.equal(processed?.warnings?.length, 0);

    const document = await lifecycle.getDocument(tenantA, uploaded.document.id);
    assert.equal(document?.processingStatus, 'completed');
    const savedCandidates = await store.readCollection<{ documentVersionId: string }>('extractedRules');
    assert.equal(savedCandidates.length, 1);
    const savedCandidate = savedCandidates[0];
    assert.ok(savedCandidate);
    assert.equal(savedCandidate.documentVersionId, uploaded.version.id);

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
    const policyRepository = new JsonPolicyRepository(store);
    const candidateRules = new CandidateRuleService(policyRepository);
    const worker = new ExtractionWorker(store, queue, adapter, storage, candidateRules);
    await createPolicyVersion(policyRepository);

    const uploaded = await lifecycle.uploadDocument({
      tenant: tenantA,
      title: 'Retry policy',
      fileName: 'retry.txt',
      mimeType: 'text/plain',
      content: Buffer.from('Respond within four hours.'),
      createdBy: tenantA.userId,
    });

    const job = await queue.enqueue({
      id: 'job-retry',
      organisationId: tenantA.organisationId,
      policyId: 'policy-1',
      policyVersionId: 'policy-version-1',
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
    const retriedDocument = await lifecycle.getDocument(tenantA, uploaded.document.id);
    assert.equal(retriedDocument?.processingStatus, 'queued');

    await worker.processNextForTenant(tenantA);
    const finalState = await queue.getById(tenantA, job.id);
    assert.equal(finalState?.status, 'succeeded');
    const candidates = await store.readCollection('extractedRules');
    assert.equal(candidates.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('composes extraction jobs only for tenant-matching document and policy targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-extraction-composition-'));
  try {
    const store = createJsonTenantStore(root);
    const storage = createLocalPrivateStorageAdapter(root);
    const lifecycle = new DocumentLifecycleService(store, storage);
    const policyRepository = new JsonPolicyRepository(store);

    await policyRepository.createPolicy({
      id: 'policy-compose-1',
      organisationId: tenantA.organisationId,
      policyType: 'sla',
      ownerId: tenantA.userId,
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      description: 'Composition policy',
    }, tenantA);
    await policyRepository.createVersion('policy-compose-1', {
      id: 'policy-compose-version-1',
      organisationId: tenantA.organisationId,
      policyId: 'policy-compose-1',
      version: 1,
      status: 'draft',
      effectiveFrom: null,
      effectiveTo: null,
      payload: { rule: 'response-within-2h' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, tenantA);

    const uploaded = await lifecycle.uploadDocument({
      tenant: tenantA,
      title: 'Composable policy',
      fileName: 'compose.txt',
      mimeType: 'text/plain',
      content: Buffer.from('Respond within two hours.', 'utf8'),
      createdBy: tenantA.userId,
    });

    const service = new ExtractionJobService(store, policyRepository);
    const job = await service.processDocument({
      tenant: tenantA,
      documentId: uploaded.document.id,
      policyId: 'policy-compose-1',
      policyVersionId: 'policy-compose-version-1',
    });

    assert.equal(job.status, 'queued');
    assert.equal(job.documentId, uploaded.document.id);
    assert.equal(job.documentVersionId, uploaded.version.id);

    await assert.rejects(service.processDocument({
      tenant: tenantB,
      documentId: uploaded.document.id,
      policyId: 'policy-compose-1',
      policyVersionId: 'policy-compose-version-1',
    }), /tenant|document/i);

    await assert.rejects(service.processDocument({
      tenant: tenantA,
      documentId: uploaded.document.id,
      policyId: 'policy-compose-1',
      policyVersionId: 'missing-version',
    }), /missing|outside/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function createPolicyVersion(repository: JsonPolicyRepository): Promise<void> {
  const timestamp = new Date().toISOString();
  await repository.createPolicy({
    id: 'policy-1',
    organisationId: tenantA.organisationId,
    policyType: 'sla',
    ownerId: tenantA.userId,
    status: 'draft',
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    description: 'Extraction test policy',
  }, tenantA);
  await repository.createVersion('policy-1', {
    id: 'policy-version-1',
    organisationId: tenantA.organisationId,
    policyId: 'policy-1',
    version: 1,
    status: 'draft',
    effectiveFrom: null,
    effectiveTo: null,
    payload: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  }, tenantA);
}
