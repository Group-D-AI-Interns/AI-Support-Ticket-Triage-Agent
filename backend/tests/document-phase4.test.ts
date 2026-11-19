import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { JsonPolicyRepository } from '../src/modules/policies/repositories/json-policy.repository.js';
import { ProvisionalExtractionAdapter } from '../src/modules/documents/services/provisional-extraction-adapter.js';
import { validateExtractionOutput } from '../src/modules/documents/services/extraction-adapter.js';
import { CandidateRuleService } from '../src/modules/documents/services/candidate-rule-service.js';
import { DocumentLifecycleService } from '../src/modules/documents/services/document-lifecycle.service.js';
import { createLocalPrivateStorageAdapter } from '../src/modules/documents/storage/document-storage.js';
import { InMemoryExtractionQueue } from '../src/modules/documents/queue/in-memory-extraction-queue.js';
import { ExtractionWorker } from '../src/modules/documents/workers/extraction-worker.js';
import type { ExtractionAdapter } from '../src/modules/documents/services/extraction-adapter.js';

const tenantA = { organisationId: 'org-1', userId: 'user-1', roles: ['org-admin'] };

test('validates extraction output and persists candidate rules with provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-phase4-'));
  try {
    const store = createJsonTenantStore(root);
    const policyRepo = new JsonPolicyRepository(store);
    const candidateService = new CandidateRuleService(policyRepo);
    await createPolicyVersion(policyRepo);

    const valid = {
      executionId: 'exec-42',
      documentId: 'doc-42',
      documentVersionId: 'doc-version-42',
      ruleType: 'response_time',
      payload: { targetHours: 2 },
      evidence: [
        {
          sourceType: 'document',
          sourceId: 'doc-42',
          versionId: 'doc-version-42',
          page: 1,
          section: 'policy',
          excerpt: 'Respond within two hours.',
        },
      ],
      confidence: 0.91,
      ambiguity: false,
      warnings: [],
      requiresHumanReview: false,
    };

    const normalized = validateExtractionOutput(valid);
    const stored = await candidateService.persistCandidateRule({
      tenant: tenantA,
      policyId: 'policy-1',
      policyVersionId: 'policy-version-1',
      rule: normalized,
    });

    assert.equal(stored.ruleType, 'response_time');
    assert.equal(stored.evidence[0].sourceId, 'doc-42');
    assert.equal(stored.confidence, 0.91);
    assert.equal(stored.ambiguous, false);
    assert.equal(stored.requiresHumanReview, false);
    assert.equal(stored.executionId, 'exec-42');
    assert.equal(stored.documentVersionId, 'doc-version-42');
    assert.deepEqual(stored.warnings, []);

    const retried = await candidateService.persistCandidateRule({
      tenant: tenantA,
      policyId: 'policy-1',
      policyVersionId: 'policy-version-1',
      rule: normalized,
    });
    assert.equal(retried.id, stored.id);
    assert.equal((await store.readCollection('extractedRules')).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects malformed extraction output before persisting', async () => {
  const malformed = {
    executionId: 'exec-bad',
    documentId: 'doc-43',
    documentVersionId: 'doc-version-43',
    ruleType: 'response_time',
    payload: { targetHours: 2 },
    evidence: [],
    confidence: 1.2,
    ambiguity: false,
    warnings: [],
    requiresHumanReview: false,
  };

  assert.throws(() => validateExtractionOutput(malformed as any), /confidence/i);
});

test('persists extraction batches idempotently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-phase4-batch-'));
  try {
    const store = createJsonTenantStore(root);
    const repository = new JsonPolicyRepository(store);
    const candidates = new CandidateRuleService(repository);
    await createPolicyVersion(repository);

    const rule = {
      executionId: 'exec-batch',
      documentId: 'doc-batch',
      documentVersionId: 'doc-version-batch',
      ruleType: 'response_time',
      payload: { targetHours: 2 },
      evidence: [{
        sourceType: 'document',
        sourceId: 'doc-batch',
        versionId: 'doc-version-batch',
        excerpt: 'Respond within two hours.',
      }],
      confidence: 0.9,
      ambiguity: false,
      warnings: [],
      requiresHumanReview: false,
    };
    const batch = {
      tenant: tenantA,
      policyId: 'policy-1',
      policyVersionId: 'policy-version-1',
      executionId: 'exec-batch',
      rules: [rule, { ...rule, ruleType: 'escalation', payload: { level: 2 } }],
    };

    const first = await candidates.persistCandidateRules(batch);
    const retry = await candidates.persistCandidateRules(batch);

    assert.equal(first.length, 2);
    assert.deepEqual(retry.map((candidate) => candidate.id), first.map((candidate) => candidate.id));
    assert.equal((await store.readCollection('extractedRules')).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisional adapter returns structured result and evidence', async () => {
  const adapter = new ProvisionalExtractionAdapter();
  const result = await adapter.extract({
    tenant: tenantA,
    documentId: 'doc-100',
    documentVersionId: 'doc-version-100',
    executionId: 'exec-100',
    content: 'Respond within two hours to customer issues.',
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].ruleType, 'response_time');
  assert.equal(result.rules[0].evidence.length, 1);
  assert.equal(result.rules[0].documentVersionId, 'doc-version-100');
  assert.equal(result.executionMetadata.provider, 'local-provisional');
  assert.ok(result.rules[0].confidence >= 0 && result.rules[0].confidence <= 1);
});

test('worker loads tenant-scoped text, validates provenance, and persists batch candidates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-extraction-integration-'));
  try {
    const store = createJsonTenantStore(root);
    const storage = createLocalPrivateStorageAdapter(root);
    const lifecycle = new DocumentLifecycleService(store, storage);
    const queue = new InMemoryExtractionQueue(store);
    const policyRepository = new JsonPolicyRepository(store);
    const candidateRules = new CandidateRuleService(policyRepository);
    const adapter = new ProvisionalExtractionAdapter();
    const worker = new ExtractionWorker(store, queue, adapter, storage, candidateRules);
    await createPolicyVersion(policyRepository);

    const uploaded = await lifecycle.uploadDocument({
      tenant: tenantA,
      title: 'Response policy',
      fileName: 'response-policy.txt',
      mimeType: 'text/plain',
      content: Buffer.from('Respond within two hours to customer issues.', 'utf8'),
      createdBy: tenantA.userId,
    });
    await queue.enqueue({
      id: 'job-integration',
      organisationId: tenantA.organisationId,
      policyId: 'policy-1',
      policyVersionId: 'policy-version-1',
      documentId: uploaded.document.id,
      documentVersionId: uploaded.version.id,
      status: 'queued',
      attempts: 0,
      maxAttempts: 2,
      correlationId: 'corr-integration',
      executionId: 'exec-integration',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const completed = await worker.processNextForTenant(tenantA);
    const candidates = await store.readCollection<{
      documentId: string;
      documentVersionId: string;
      executionId: string;
      policyVersionId: string;
      payload: { targetHours: number };
      requiresHumanReview: boolean;
    }>('extractedRules');

    assert.equal(completed?.status, 'succeeded');
    assert.equal(completed?.executionMetadata?.model, 'response-hours-regex-v1');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].documentId, uploaded.document.id);
    assert.equal(candidates[0].documentVersionId, uploaded.version.id);
    assert.equal(candidates[0].executionId, 'exec-integration');
    assert.equal(candidates[0].policyVersionId, 'policy-version-1');
    assert.equal(candidates[0].payload.targetHours, 2);
    assert.equal(candidates[0].requiresHumanReview, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker fails unsupported document formats without retrying', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-extraction-unsupported-'));
  try {
    const store = createJsonTenantStore(root);
    const storage = createLocalPrivateStorageAdapter(root);
    const lifecycle = new DocumentLifecycleService(store, storage);
    const queue = new InMemoryExtractionQueue(store);
    const policyRepository = new JsonPolicyRepository(store);
    const candidateRules = new CandidateRuleService(policyRepository);
    const adapter = new ProvisionalExtractionAdapter();
    const worker = new ExtractionWorker(store, queue, adapter, storage, candidateRules);
    await createPolicyVersion(policyRepository);

    const uploaded = await lifecycle.uploadDocument({
      tenant: tenantA,
      title: 'PDF policy',
      fileName: 'response-policy.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.4\n%%EOF'),
      createdBy: tenantA.userId,
    });
    await queue.enqueue({
      id: 'job-unsupported',
      organisationId: tenantA.organisationId,
      policyId: 'policy-1',
      policyVersionId: 'policy-version-1',
      documentId: uploaded.document.id,
      documentVersionId: uploaded.version.id,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      correlationId: 'corr-unsupported',
      executionId: 'exec-unsupported',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const failed = await worker.processNextForTenant(tenantA);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.attempts, 1);
    assert.equal(failed?.lastError, 'UNSUPPORTED_DOCUMENT_TYPE');
    assert.equal((await store.readCollection('extractedRules')).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker records non-retryable adapter failures and execution metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-extraction-failure-'));
  try {
    const store = createJsonTenantStore(root);
    const storage = createLocalPrivateStorageAdapter(root);
    const lifecycle = new DocumentLifecycleService(store, storage);
    const queue = new InMemoryExtractionQueue(store);
    const policyRepository = new JsonPolicyRepository(store);
    const candidateRules = new CandidateRuleService(policyRepository);
    const adapter: ExtractionAdapter = {
      async extract(input) {
        return {
          executionId: input.executionId,
          status: 'failed',
          rules: [],
          warnings: ['Provider rejected the document.'],
          executionMetadata: {
            provider: 'test-provider',
            model: 'test-model',
            startedAt: new Date().toISOString(),
            durationMs: 3,
          },
          failure: {
            code: 'DOCUMENT_REJECTED',
            message: 'Document rejected.',
            retryable: false,
          },
        };
      },
    };
    const worker = new ExtractionWorker(store, queue, adapter, storage, candidateRules);
    await createPolicyVersion(policyRepository);

    const uploaded = await lifecycle.uploadDocument({
      tenant: tenantA,
      title: 'Rejected policy',
      fileName: 'rejected-policy.txt',
      mimeType: 'text/plain',
      content: Buffer.from('Respond within two hours.', 'utf8'),
      createdBy: tenantA.userId,
    });
    await queue.enqueue({
      id: 'job-failed',
      organisationId: tenantA.organisationId,
      policyId: 'policy-1',
      policyVersionId: 'policy-version-1',
      documentId: uploaded.document.id,
      documentVersionId: uploaded.version.id,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      correlationId: 'corr-failed',
      executionId: 'exec-failed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const failed = await worker.processNextForTenant(tenantA);
    const document = await lifecycle.getDocument(tenantA, uploaded.document.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.lastError, 'DOCUMENT_REJECTED');
    assert.equal(failed?.executionMetadata?.provider, 'test-provider');
    assert.deepEqual(failed?.warnings, ['Provider rejected the document.']);
    assert.equal(document?.processingStatus, 'failed');
    assert.equal((await store.readCollection('extractedRules')).length, 0);
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
