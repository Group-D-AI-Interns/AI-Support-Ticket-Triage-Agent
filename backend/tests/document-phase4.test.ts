import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { JsonPolicyRepository } from '../src/modules/policies/repositories/json-policy.repository.js';
import { ProvisionalExtractionAdapter, validateExtractionOutput } from '../src/modules/documents/services/provisional-extraction-adapter.js';
import { CandidateRuleService } from '../src/modules/documents/services/candidate-rule-service.js';

const tenantA = { organisationId: 'org-1', userId: 'user-1', roles: ['org-admin'] };

test('validates extraction output and persists candidate rules with provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-phase4-'));
  try {
    const store = createJsonTenantStore(root);
    const policyRepo = new JsonPolicyRepository(store);
    const candidateService = new CandidateRuleService(policyRepo);

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
  };

  assert.throws(() => validateExtractionOutput(malformed as any), /confidence/i);
});

test('provisional adapter returns structured result and evidence', async () => {
  const adapter = new ProvisionalExtractionAdapter();
  const result = await adapter.extract({
    tenant: tenantA,
    documentId: 'doc-100',
    documentVersionId: 'doc-version-100',
    executionId: 'exec-100',
    content: 'Respond within two hours to customer issues.',
    pageNumber: 1,
    section: 'policy',
  });

  assert.equal(result.ruleType, 'response_time');
  assert.equal(result.evidence.length, 1);
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
});
