import * as z from 'zod';
import type { TenantContext } from '../../shared/tenant.js';
import { applicationAuthorization, type RolePermissionPolicy } from '../../shared/auth/authorization.js';
import type { JsonTenantStore } from '../../infrastructure/persistence/json/json-store.js';
import type { PolicyRepository } from '../policies/repositories/policy.repository.js';
import type { AuthorizedKnowledgeSource, KnowledgeDocument } from './retrieval.js';
import { ApprovedPolicyKnowledgeSource } from './approved-policy-source.js';

export const publishedKnowledgeSchema = z.strictObject({
  kind: z.literal('published_document_knowledge'), title: z.string().trim().min(1),
  visibility: z.enum(['administrators', 'support_staff']),
  sourceDocumentId: z.string().min(1), sourceDocumentVersionId: z.string().min(1),
  extractionVersionId: z.string().min(1),
  clauses: z.array(z.strictObject({ ruleId: z.string().min(1), ruleType: z.string().min(1),
    excerpts: z.array(z.string().trim().min(1)).min(1) })).min(1),
});

/** Explicit published excerpts can be shared; raw policy/document access remains governed separately. */
export class GovernedKnowledgeSource implements AuthorizedKnowledgeSource {
  constructor(private readonly policies: PolicyRepository, private readonly store: JsonTenantStore,
    private readonly authorization: RolePermissionPolicy = applicationAuthorization) {}
  async listAuthorizedDocuments(tenant: TenantContext): Promise<KnowledgeDocument[]> {
    const permissions = this.authorization.permissionsFor(tenant.roles);
    const administrator = permissions.has('configuration.manage');
    if (!administrator && !permissions.has('tickets.resolution.review')) return [];
    const approvals = await this.store.readCollection<{ id: string; organisationId: string; policyVersionId: string; extractedRuleId?: string; decision: string }>('policyApprovals');
    const published: KnowledgeDocument[] = [];
    for (const policy of await this.policies.listPolicies(tenant)) {
      if (policy.policyType !== 'knowledge' || policy.organisationId !== tenant.organisationId) continue;
      for (const version of await this.policies.listVersionsForPolicy(tenant, policy.id)) {
        const payload = publishedKnowledgeSchema.safeParse(version.payload);
        if (!payload.success || version.status !== 'active' || !version.effectiveFrom || version.organisationId !== tenant.organisationId ||
          (!administrator && payload.data.visibility !== 'support_staff') ||
          !approvals.some(item => item.organisationId === tenant.organisationId && item.policyVersionId === version.id && !item.extractedRuleId && item.decision === 'approved')) continue;
        published.push({ id: policy.id, version: version.id, organisationId: tenant.organisationId, sourceType: 'knowledge_article',
          title: payload.data.title, content: payload.data.clauses.flatMap(clause => clause.excerpts).join('\n\n'),
          approved: true, status: 'active', effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo });
      }
    }
    const privatePolicies = await new ApprovedPolicyKnowledgeSource(this.policies, this.store).listAuthorizedDocuments(tenant);
    return [...published, ...privatePolicies.filter(document => !published.some(article => article.id === document.id && article.version === document.version))];
  }
}
