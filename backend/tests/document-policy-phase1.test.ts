import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { JsonDocumentRepository } from '../src/modules/documents/repositories/json-document.repository.js';
import { JsonPolicyRepository } from '../src/modules/policies/repositories/json-policy.repository.js';

const tenantA = { organisationId: 'org-1', userId: 'user-1', roles: ['org-admin'] };
const tenantB = { organisationId: 'org-2', userId: 'user-2', roles: ['org-admin'] };

test('document repository keeps metadata isolated by tenant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-policy-'));
  try {
    const store = createJsonTenantStore(root);
    const repo = new JsonDocumentRepository(store);

    const created = await repo.create({
      id: 'doc-1',
      organisationId: tenantA.organisationId,
      title: 'Policy Packet',
      status: 'uploaded',
      fileName: 'packet.pdf',
      mimeType: 'application/pdf',
      storageKey: 'private/org-1/doc-1.pdf',
      checksumSha256: 'abc123',
      createdBy: tenantA.userId,
      createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      version: 1,
      fileSizeBytes: 1024,
      provider: 'private-storage',
      processingStatus: 'queued'
    }, tenantA);

    const retrieved = await repo.getById(tenantA, 'doc-1');
    assert.equal(retrieved?.id, 'doc-1');
    assert.equal(created.organisationId, tenantA.organisationId);

    const blocked = await repo.getById(tenantB, 'doc-1');
    assert.equal(blocked, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('policy repository enforces version lifecycle and tenant isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'policy-phase1-'));
  try {
    const store = createJsonTenantStore(root);
    const repo = new JsonPolicyRepository(store);

    const created = await repo.createPolicy({
      id: 'policy-1',
      organisationId: tenantA.organisationId,
      policyType: 'sla',
      ownerId: tenantA.userId,
      status: 'draft',
      createdAt: new Date('2026-02-01T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-02-01T00:00:00Z').toISOString(),
      version: 1,
      description: 'Initial policy'
    }, tenantA);

    const version = await repo.createVersion(created.id, {
      id: 'policy-version-1',
      organisationId: tenantA.organisationId,
      policyId: created.id,
      version: 1,
      status: 'draft',
      effectiveFrom: new Date('2026-02-02T00:00:00Z').toISOString(),
      effectiveTo: null,
      payload: { rule: 'response-within-2h' },
      createdAt: new Date('2026-02-01T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-02-01T00:00:00Z').toISOString()
    }, tenantA);

    await repo.transitionVersionStatus(tenantA, version.id, 'pending_approval');
    const decision = await repo.addApproval({
      id: 'approval-1',
      organisationId: tenantA.organisationId,
      policyVersionId: version.id,
      reviewerId: tenantA.userId,
      decision: 'approved',
      reason: 'Reviewed and accepted.',
      createdAt: new Date('2026-02-02T00:00:00Z').toISOString()
    }, tenantA);
    assert.equal(decision.decision, 'approved');
    const approved = await repo.getVersionById(tenantA, version.id);
    assert.equal(approved?.status, 'approved');
    const active = await repo.transitionVersionStatus(tenantA, version.id, 'active');
    assert.equal(active?.status, 'active');

    const crossTenant = await repo.getPolicyById(tenantB, created.id);
    assert.equal(crossTenant, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('policy version cannot be activated without an approved review and effective date', async () => {
  const root = mkdtempSync(join(tmpdir(), 'policy-approval-'));
  try {
    const store = createJsonTenantStore(root);
    const repo = new JsonPolicyRepository(store);
    const created = await repo.createPolicy({
      id: 'policy-approval-1',
      organisationId: tenantA.organisationId,
      policyType: 'sla',
      ownerId: tenantA.userId,
      status: 'draft',
      createdAt: new Date('2026-02-01T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-02-01T00:00:00Z').toISOString(),
      version: 1,
      description: 'Approval guard test'
    }, tenantA);
    const version = await repo.createVersion(created.id, {
      id: 'policy-approval-version-1',
      organisationId: tenantA.organisationId,
      policyId: created.id,
      version: 1,
      status: 'draft',
      effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
      effectiveTo: null,
      payload: { rule: 'response-within-2h' },
      createdAt: new Date('2026-02-01T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-02-01T00:00:00Z').toISOString()
    }, tenantA);

    await assert.rejects(repo.transitionVersionStatus(tenantA, version.id, 'active'), /transition|approval/i);
    await repo.transitionVersionStatus(tenantA, version.id, 'pending_approval');
    await repo.addApproval({
      id: 'approval-future-1',
      organisationId: tenantA.organisationId,
      policyVersionId: version.id,
      reviewerId: tenantA.userId,
      decision: 'approved',
      reason: 'Reviewed for future effectivity.',
      createdAt: new Date().toISOString()
    }, tenantA);
    await assert.rejects(repo.transitionVersionStatus(tenantA, version.id, 'active'), /effective-from/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
