import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { JsonPolicyRepository } from '../src/modules/policies/repositories/json-policy.repository.js';
import { RepositorySlaPolicyResolver } from '../src/modules/sla/services/sla-policy-resolver.js';

const tenant = {
  organisationId: 'org-1',
  userId: 'admin-1',
  roles: ['organisation_admin'],
};

const payload = {
  calendar: {
    timeZone: 'Africa/Johannesburg',
    weeklySchedule: {
      monday: [{ startMinute: 480, endMinute: 960 }],
    },
    holidays: [],
  },
  targetsByPriority: {
    high: { firstResponseMinutes: 45, resolutionMinutes: 180 },
  },
  pausedStatuses: ['PENDING'],
  resolvedStatuses: ['RESOLVED'],
  riskAtPercent: 80,
};

test('resolves only active tenant SLA versions and prefers matching team policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sla-resolver-'));
  try {
    const repository = new JsonPolicyRepository(createJsonTenantStore(root));
    const globalPolicy = await repository.createPolicy(
      {
        id: 'sla-global',
        organisationId: tenant.organisationId,
        policyType: 'sla',
        ownerId: tenant.userId,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        description: 'Organisation-wide SLA',
      },
      tenant,
    );
    const globalVersion = await repository.createVersion(
      globalPolicy.id,
      {
        id: 'sla-global-v1',
        organisationId: tenant.organisationId,
        policyId: globalPolicy.id,
        version: 1,
        status: 'active',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        payload,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      tenant,
    );
    const teamPolicy = await repository.createPolicy(
      {
        ...globalPolicy,
        id: 'sla-team',
        description: 'Team SLA',
      },
      tenant,
    );
    await repository.createVersion(
      teamPolicy.id,
      {
        id: 'sla-team-v1',
        organisationId: tenant.organisationId,
        policyId: teamPolicy.id,
        version: 1,
        status: 'active',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        payload: { ...payload, teamIds: ['team-1'] },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      tenant,
    );

    const resolver = new RepositorySlaPolicyResolver(repository);
    const selected = await resolver.resolve(tenant, {
      priority: 'high',
      createdAt: '2026-02-01T12:00:00.000Z',
      teamId: 'team-1',
    });
    assert.equal(selected?.id, 'sla-team');

    const fallback = await resolver.resolve(tenant, {
      priority: 'high',
      createdAt: '2026-02-01T12:00:00.000Z',
      teamId: 'team-2',
    });
    assert.equal(fallback?.versionId, globalVersion.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not resolve another tenant policy or draft SLA versions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sla-resolver-tenant-'));
  try {
    const repository = new JsonPolicyRepository(createJsonTenantStore(root));
    const otherTenant = { ...tenant, organisationId: 'org-2' };
    const policy = await repository.createPolicy(
      {
        id: 'sla-other',
        organisationId: otherTenant.organisationId,
        policyType: 'sla',
        ownerId: otherTenant.userId,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        description: 'Other tenant SLA',
      },
      otherTenant,
    );
    await repository.createVersion(
      policy.id,
      {
        id: 'sla-other-v1',
        organisationId: otherTenant.organisationId,
        policyId: policy.id,
        version: 1,
        status: 'active',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        payload,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      otherTenant,
    );

    const resolver = new RepositorySlaPolicyResolver(repository);
    const result = await resolver.resolve(tenant, {
      priority: 'high',
      createdAt: '2026-02-01T12:00:00.000Z',
    });
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('activating a new approved version archives its predecessor atomically', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sla-activate-'));
  try {
    const repository = new JsonPolicyRepository(createJsonTenantStore(root));
    const policy = await repository.createPolicy(
      {
        id: 'sla-policy',
        organisationId: tenant.organisationId,
        policyType: 'sla',
        ownerId: tenant.userId,
        status: 'draft',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 2,
        description: 'Versioned SLA policy',
      },
      tenant,
    );
    for (const [id, version] of [
      ['sla-v1', 1],
      ['sla-v2', 2],
    ] as const) {
      const effectiveFrom =
        version === 1
          ? '2026-01-01T00:00:00.000Z'
          : '2026-02-01T00:00:00.000Z';
      await repository.createVersion(
        policy.id,
        {
          id,
          organisationId: tenant.organisationId,
          policyId: policy.id,
          version,
          status: 'approved',
          effectiveFrom,
          effectiveTo: null,
          payload,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        tenant,
      );
    }

    assert.equal(
      (await repository.activateVersion(tenant, policy.id, 'sla-v1'))?.status,
      'active',
    );
    assert.equal(
      (await repository.activateVersion(tenant, policy.id, 'sla-v2'))?.status,
      'active',
    );
    const versions = await repository.listVersionsForPolicy(tenant, policy.id);
    assert.equal(
      versions.find((version) => version.id === 'sla-v1')?.status,
      'archived',
    );
    assert.equal(
      versions.find((version) => version.id === 'sla-v2')?.status,
      'active',
    );
    assert.equal(
      versions.find((version) => version.id === 'sla-v1')?.effectiveTo,
      '2026-02-01T00:00:00.000Z',
    );
    const resolver = new RepositorySlaPolicyResolver(repository);
    assert.equal(
      (
        await resolver.resolve(tenant, {
          priority: 'high',
          createdAt: '2026-01-15T00:00:00.000Z',
        })
      )?.versionId,
      'sla-v1',
    );
    assert.equal(
      (
        await resolver.resolve(tenant, {
          priority: 'high',
          createdAt: '2026-02-15T00:00:00.000Z',
        })
      )?.versionId,
      'sla-v2',
    );
    assert.equal(
      await repository.activateVersion(
        { ...tenant, organisationId: 'other-org' },
        policy.id,
        'sla-v2',
      ),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
