import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import { assertTenantAccess, type TenantContext } from '../../../shared/tenant.js';
import type { ExtractedRuleRecord, PolicyApprovalRecord, PolicyRecord, PolicyVersionRecord } from '../domain/policy.js';
import type { PolicyRepository } from './policy.repository.js';

export class JsonPolicyRepository implements PolicyRepository {
  constructor(private readonly store: JsonTenantStore) {}

  async createPolicy(policy: PolicyRecord, tenant: TenantContext): Promise<PolicyRecord> {
    if (policy.organisationId !== tenant.organisationId) {
      throw new Error('Policy organisation does not match tenant context.');
    }

    return this.store.updateCollection<PolicyRecord, PolicyRecord>('policies', (policies) => {
      if (policies.some((item) => item.id === policy.id)) {
        throw new Error(`Policy ${policy.id} already exists.`);
      }
      policies.push(policy);
      return policy;
    });
  }

  async getPolicyById(tenant: TenantContext, policyId: string): Promise<PolicyRecord | null> {
    const policies = await this.store.readCollection<PolicyRecord>('policies');
    const record = policies.find((item) => item.id === policyId);
    return assertTenantAccess(tenant, record) ?? null;
  }

  async listPolicies(tenant: TenantContext): Promise<PolicyRecord[]> {
    const policies = await this.store.readCollection<PolicyRecord>('policies');
    return policies.filter((item) => item.organisationId === tenant.organisationId);
  }

  async createVersion(
    policyId: string,
    version: PolicyVersionRecord,
    tenant: TenantContext,
  ): Promise<PolicyVersionRecord> {
    if (version.organisationId !== tenant.organisationId) {
      throw new Error('Policy version organisation does not match tenant context.');
    }

    const policies = await this.store.readCollection<PolicyRecord>('policies');
    const policyExists = policies.some((item) => item.id === policyId && item.organisationId === tenant.organisationId);
    if (!policyExists) {
      throw new Error(`Policy ${policyId} does not exist for tenant ${tenant.organisationId}.`);
    }

    const normalizedVersion: PolicyVersionRecord = {
      ...version,
      policyId,
    };

    return this.store.updateCollection<PolicyVersionRecord, PolicyVersionRecord>('policyVersions', (versions) => {
      const versionExists = versions.some((item) => item.policyId === policyId && item.version === normalizedVersion.version);
      if (versionExists) {
        throw new Error(`Policy version ${normalizedVersion.version} for ${policyId} already exists.`);
      }
      versions.push(normalizedVersion);
      return normalizedVersion;
    });
  }

  async getVersionById(tenant: TenantContext, versionId: string): Promise<PolicyVersionRecord | null> {
    const versions = await this.store.readCollection<PolicyVersionRecord>('policyVersions');
    const record = versions.find((item) => item.id === versionId);
    return assertTenantAccess(tenant, record) ?? null;
  }

  async listVersionsForPolicy(
    tenant: TenantContext,
    policyId: string,
  ): Promise<PolicyVersionRecord[]> {
    const policy = await this.getPolicyById(tenant, policyId);
    if (!policy) {
      return [];
    }
    const versions = await this.store.readCollection<PolicyVersionRecord>('policyVersions');
    return versions.filter(
      (version) =>
        version.organisationId === tenant.organisationId &&
        version.policyId === policyId,
    );
  }

  async transitionVersionStatus(
    tenantOrVersionId: TenantContext | string,
    versionIdOrStatus: string | PolicyVersionRecord['status'],
    maybeStatusOrTenant?: PolicyVersionRecord['status'] | TenantContext,
  ): Promise<PolicyVersionRecord | null> {
    let tenant: TenantContext;
    let versionId: string;
    let status: PolicyVersionRecord['status'];

    if (typeof tenantOrVersionId === 'string') {
      tenant = maybeStatusOrTenant as TenantContext;
      versionId = tenantOrVersionId;
      status = versionIdOrStatus as PolicyVersionRecord['status'];
    } else {
      tenant = tenantOrVersionId;
      versionId = versionIdOrStatus as string;
      status = maybeStatusOrTenant as PolicyVersionRecord['status'];
    }

    return this.store.updateCollection<PolicyVersionRecord, PolicyVersionRecord | null>('policyVersions', (versions) => {
      const index = versions.findIndex((item) => item.id === versionId && item.organisationId === tenant.organisationId);
      const existing = versions[index];
      if (index === -1 || !existing) return null;

      const updated: PolicyVersionRecord = {
        ...existing,
        status,
        updatedAt: new Date().toISOString(),
      };

      versions[index] = updated;
      return updated;
    });
  }

  async activateVersion(
    tenant: TenantContext,
    policyId: string,
    versionId: string,
  ): Promise<PolicyVersionRecord | null> {
    return this.store.updateCollection<PolicyVersionRecord, PolicyVersionRecord | null>('policyVersions', (versions) => {
      const target = versions.find(
        (item) =>
          item.id === versionId &&
          item.policyId === policyId &&
          item.organisationId === tenant.organisationId,
      );
      if (!target || target.status !== 'approved' || target.effectiveFrom === null) return null;

      const targetEffectiveFrom = target.effectiveFrom;
      const now = new Date().toISOString();
      const updated: PolicyVersionRecord = { ...target, status: 'active', updatedAt: now };
      const activeVersions = versions.filter(
        (item) =>
          item.organisationId === tenant.organisationId &&
          item.policyId === policyId &&
          item.status === 'active',
      );
      if (activeVersions.some(
        (item) =>
          item.effectiveFrom === null ||
          Date.parse(targetEffectiveFrom) <= Date.parse(item.effectiveFrom),
      )) return null;

      const targetIndex = versions.findIndex((item) => item.id === versionId);
      if (targetIndex === -1) return null;
      const next = versions.map((item) =>
        item.organisationId === tenant.organisationId &&
        item.policyId === policyId &&
        item.status === 'active'
          ? {
              ...item,
              status: 'archived' as const,
              effectiveTo:
                item.effectiveTo === null ||
                Date.parse(targetEffectiveFrom) < Date.parse(item.effectiveTo)
                  ? targetEffectiveFrom
                  : item.effectiveTo,
              updatedAt: now,
            }
          : item,
      );
      next[targetIndex] = updated;
      for (let index = 0; index < next.length; index += 1) {
        versions[index] = next[index]!;
      }
      return updated;
    });
  }

  async createExtractedRule(rule: ExtractedRuleRecord, tenant: TenantContext): Promise<ExtractedRuleRecord> {
    const [created] = await this.createExtractedRules([rule], tenant);
    if (!created) {
      throw new Error('Extracted rule was not persisted.');
    }
    return created;
  }

  async createExtractedRules(
    incoming: ExtractedRuleRecord[],
    tenant: TenantContext,
  ): Promise<ExtractedRuleRecord[]> {
    if (incoming.some((rule) => rule.organisationId !== tenant.organisationId)) {
      throw new Error('Extracted rule organisation does not match tenant context.');
    }

    const versions = await this.store.readCollection<PolicyVersionRecord>('policyVersions');
    const versionIds = new Set(
      versions
        .filter((version) => version.organisationId === tenant.organisationId)
        .map((version) => version.id),
    );
    if (incoming.some((rule) => !versionIds.has(rule.policyVersionId))) {
      throw new Error('Extracted rule references a policy version outside the tenant scope.');
    }

    return this.store.updateCollection<ExtractedRuleRecord, ExtractedRuleRecord[]>('extractedRules', (rules) => {
      const existingById = new Map(rules.map((rule) => [rule.id, rule]));
      const additions: ExtractedRuleRecord[] = [];
      const result: ExtractedRuleRecord[] = [];

      for (const candidate of incoming) {
        const existing = existingById.get(candidate.id);
        if (existing) {
          if (!sameCandidateContent(existing, candidate)) {
            throw new Error('Extraction execution produced conflicting candidate rule content.');
          }
          result.push(existing);
          continue;
        }

        existingById.set(candidate.id, candidate);
        additions.push(candidate);
        result.push(candidate);
      }

      rules.push(...additions);
      return result;
    });
  }

  async addApproval(approval: PolicyApprovalRecord, tenant: TenantContext): Promise<PolicyApprovalRecord> {
    if (approval.organisationId !== tenant.organisationId) {
      throw new Error('Approval organisation does not match tenant context.');
    }

    return this.store.updateCollection<PolicyApprovalRecord, PolicyApprovalRecord>('policyApprovals', (approvals) => {
      approvals.push(approval);
      return approval;
    });
  }
}

function sameCandidateContent(
  left: ExtractedRuleRecord,
  right: ExtractedRuleRecord,
): boolean {
  const { createdAt: _leftCreatedAt, ...leftContent } = left;
  const { createdAt: _rightCreatedAt, ...rightContent } = right;
  return stableSerialize(leftContent) === stableSerialize(rightContent);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
