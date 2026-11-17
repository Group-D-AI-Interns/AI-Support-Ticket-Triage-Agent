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
    if (version.status !== 'draft') {
      throw new Error('Policy versions must be created in draft status.');
    }
    validateEffectiveDates(version);

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

    const current = versions[index];
    if (!isAllowedTransition(current.status, status)) {
      throw new Error(`Policy version cannot transition from ${current.status} to ${status}.`);
    }

    const approvals = await this.store.readCollection<PolicyApprovalRecord>('policyApprovals');
    const hasApproval = approvals.some(
      (approval) => approval.policyVersionId === versionId
        && approval.organisationId === tenant.organisationId
        && approval.decision === 'approved',
    );
    if (status === 'approved' && !hasApproval) {
      throw new Error('Policy version requires an approved reviewer decision before approval.');
    }
    if (status === 'active') {
      if (!hasApproval) {
        throw new Error('Policy version requires an approved reviewer decision before activation.');
      }
      validateActivationWindow(current);
    }

    const updated = {
      ...current,
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
    if (approval.reviewerId !== tenant.userId) {
      throw new Error('Approval reviewer must match the authenticated tenant user.');
    }
    if (approval.reason.trim().length === 0) {
      throw new Error('Approval decision reason is required.');
    }

    const versions = await this.store.readCollection<PolicyVersionRecord>('policyVersions');
    const version = versions.find(
      (item) => item.id === approval.policyVersionId && item.organisationId === tenant.organisationId,
    );
    if (!version) {
      throw new Error('Policy version does not exist for this tenant.');
    }
    if (version.status !== 'pending_approval') {
      throw new Error('Reviewer decisions can only be recorded for pending policy versions.');
    }

    const approvals = await this.store.readCollection<PolicyApprovalRecord>('policyApprovals');
    if (approvals.some((item) => item.id === approval.id)) {
      throw new Error(`Approval ${approval.id} already exists.`);
    }
    approvals.push(approval);
    await this.store.writeCollection('policyApprovals', approvals);

    const nextStatus = approval.decision === 'approved' ? 'approved' : 'rejected';
    await this.transitionVersionStatus(tenant, approval.policyVersionId, nextStatus);
    return approval;
  }
}

function isAllowedTransition(from: PolicyVersionRecord['status'], to: PolicyVersionRecord['status']): boolean {
  const transitions: Record<PolicyVersionRecord['status'], PolicyVersionRecord['status'][]> = {
    draft: ['pending_approval'],
    pending_approval: ['approved', 'rejected'],
    approved: ['active'],
    active: ['expired', 'archived'],
    rejected: [],
    expired: ['archived'],
    archived: [],
  };

  return transitions[from].includes(to);
}

function validateEffectiveDates(version: PolicyVersionRecord): void {
  const effectiveFrom = version.effectiveFrom === null ? null : Date.parse(version.effectiveFrom);
  const effectiveTo = version.effectiveTo === null ? null : Date.parse(version.effectiveTo);

  if ((effectiveFrom !== null && !Number.isFinite(effectiveFrom)) || (effectiveTo !== null && !Number.isFinite(effectiveTo))) {
    throw new Error('Policy effective dates must be valid timestamps.');
  }
  if (effectiveFrom !== null && effectiveTo !== null && effectiveFrom >= effectiveTo) {
    throw new Error('Policy effective-from date must be earlier than its effective-to date.');
  }
}

function validateActivationWindow(version: PolicyVersionRecord): void {
  validateEffectiveDates(version);
  const now = Date.now();
  const effectiveFrom = version.effectiveFrom === null ? null : Date.parse(version.effectiveFrom);
  const effectiveTo = version.effectiveTo === null ? null : Date.parse(version.effectiveTo);

  if (effectiveFrom !== null && effectiveFrom > now) {
    throw new Error('Policy version cannot be activated before its effective-from date.');
  }
  if (effectiveTo !== null && effectiveTo <= now) {
    throw new Error('Policy version cannot be activated after its effective-to date.');
  }
}
