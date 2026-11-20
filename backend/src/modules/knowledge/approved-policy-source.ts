import type { PolicyRepository } from '../policies/repositories/policy.repository.js';
import type { JsonTenantStore } from '../../infrastructure/persistence/json/json-store.js';
import type { TenantContext } from '../../shared/tenant.js';
import type { AuthorizedKnowledgeSource, KnowledgeDocument } from './retrieval.js';

/** Matches current administrator-only policy visibility. No inferred staff document grants. */
export class ApprovedPolicyKnowledgeSource implements AuthorizedKnowledgeSource {
  constructor(private readonly policies: PolicyRepository, private readonly store: JsonTenantStore) {}
  async listAuthorizedDocuments(tenant: TenantContext): Promise<KnowledgeDocument[]> {
    if (!tenant.roles.includes('organisation_admin')) return [];
    const approvals = await this.store.readCollection<{ id: string; organisationId: string; policyVersionId: string; extractedRuleId?: string; decision: string }>('policyApprovals');
    const documents: KnowledgeDocument[] = [];
    for (const policy of await this.policies.listPolicies(tenant)) {
      if (policy.organisationId !== tenant.organisationId) continue;
      for (const version of await this.policies.listVersionsForPolicy(tenant, policy.id)) {
        if (version.organisationId !== tenant.organisationId || version.policyId !== policy.id || version.status !== 'active' ||
          version.effectiveFrom === null || !approvals.some(approval => approval.organisationId === tenant.organisationId &&
            approval.policyVersionId === version.id && !approval.extractedRuleId && approval.decision === 'approved')) continue;
        documents.push({ id: policy.id, version: version.id, organisationId: tenant.organisationId,
          sourceType: 'approved_policy', title: policy.description || policy.policyType,
          content: JSON.stringify({ policyType: policy.policyType, rules: version.payload }), approved: true, status: 'active',
          effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo });
      }
    }
    return documents;
  }
}
