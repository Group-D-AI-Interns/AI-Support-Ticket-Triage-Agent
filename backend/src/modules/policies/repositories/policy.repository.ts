import type { TenantContext } from '../../../shared/tenant.js';
import type { ExtractedRuleRecord, PolicyApprovalRecord, PolicyRecord, PolicyVersionRecord } from '../domain/policy.js';

export interface PolicyRepository {
  createPolicy(policy: PolicyRecord, tenant: TenantContext): Promise<PolicyRecord>;
  getPolicyById(tenant: TenantContext, policyId: string): Promise<PolicyRecord | null>;
  listPolicies(tenant: TenantContext): Promise<PolicyRecord[]>;
  createVersion(policyId: string, version: PolicyVersionRecord, tenant: TenantContext): Promise<PolicyVersionRecord>;
  getVersionById(tenant: TenantContext, versionId: string): Promise<PolicyVersionRecord | null>;
  listVersionsForPolicy(
    tenant: TenantContext,
    policyId: string,
  ): Promise<PolicyVersionRecord[]>;
  transitionVersionStatus(
    tenantOrVersionId: TenantContext | string,
    versionIdOrStatus: string | PolicyVersionRecord['status'],
    maybeStatusOrTenant?: PolicyVersionRecord['status'] | TenantContext,
  ): Promise<PolicyVersionRecord | null>;
  activateVersion(
    tenant: TenantContext,
    policyId: string,
    versionId: string,
  ): Promise<PolicyVersionRecord | null>;
  createExtractedRule(rule: ExtractedRuleRecord, tenant: TenantContext): Promise<ExtractedRuleRecord>;
  createExtractedRules(
    rules: ExtractedRuleRecord[],
    tenant: TenantContext,
  ): Promise<ExtractedRuleRecord[]>;
  addApproval(approval: PolicyApprovalRecord, tenant: TenantContext): Promise<PolicyApprovalRecord>;
}
