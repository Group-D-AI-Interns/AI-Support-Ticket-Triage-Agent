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

    const policies = await this.store.readCollection<PolicyRecord>('policies');
    if (policies.some((item) => item.id === policy.id)) {
      throw new Error(`Policy ${policy.id} already exists.`);
    }

    policies.push(policy);
    await this.store.writeCollection('policies', policies);
    return policy;
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

    const versions = await this.store.readCollection<PolicyVersionRecord>('policyVersions');
    const versionExists = versions.some((item) => item.policyId === policyId && item.version === normalizedVersion.version);
    if (versionExists) {
      throw new Error(`Policy version ${normalizedVersion.version} for ${policyId} already exists.`);
    }

    versions.push(normalizedVersion);
    await this.store.writeCollection('policyVersions', versions);
    return normalizedVersion;
  }

  async getVersionById(tenant: TenantContext, versionId: string): Promise<PolicyVersionRecord | null> {
    const versions = await this.store.readCollection<PolicyVersionRecord>('policyVersions');
    const record = versions.find((item) => item.id === versionId);
    return assertTenantAccess(tenant, record) ?? null;
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

    const versions = await this.store.readCollection<PolicyVersionRecord>('policyVersions');
    const index = versions.findIndex((item) => item.id === versionId && item.organisationId === tenant.organisationId);
    if (index === -1) {
      return null;
    }

    const updated = {
      ...versions[index],
      status,
      updatedAt: new Date().toISOString(),
    };

    versions[index] = updated;
    await this.store.writeCollection('policyVersions', versions);
    return updated;
  }

  async createExtractedRule(rule: ExtractedRuleRecord, tenant: TenantContext): Promise<ExtractedRuleRecord> {
    if (rule.organisationId !== tenant.organisationId) {
      throw new Error('Extracted rule organisation does not match tenant context.');
    }

    const rules = await this.store.readCollection<ExtractedRuleRecord>('extractedRules');
    if (rules.some((item) => item.id === rule.id)) {
      throw new Error(`Extracted rule ${rule.id} already exists.`);
    }

    rules.push(rule);
    await this.store.writeCollection('extractedRules', rules);
    return rule;
  }

  async addApproval(approval: PolicyApprovalRecord, tenant: TenantContext): Promise<PolicyApprovalRecord> {
    if (approval.organisationId !== tenant.organisationId) {
      throw new Error('Approval organisation does not match tenant context.');
    }

    const approvals = await this.store.readCollection<PolicyApprovalRecord>('policyApprovals');
    approvals.push(approval);
    await this.store.writeCollection('policyApprovals', approvals);
    return approval;
  }
}
