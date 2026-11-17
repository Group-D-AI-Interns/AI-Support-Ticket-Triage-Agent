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

    const active = await repo.transitionVersionStatus(version.id, 'approved', tenantA);
    assert.equal(active.status, 'approved');

    const crossTenant = await repo.getPolicyById(tenantB, created.id);
    assert.equal(crossTenant, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
