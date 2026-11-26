import { randomUUID } from 'node:crypto';

import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import { assertTenantAccess, type TenantContext } from '../../../shared/tenant.js';
import type { ExtractedRuleRecord, PolicyApprovalRecord, PolicyAuditRecord, PolicyRecord, PolicyVersionRecord } from '../domain/policy.js';
import type { PolicyRepository } from './policy.repository.js';

export class JsonPolicyRepository implements PolicyRepository {
  constructor(private readonly store: JsonTenantStore) {}

  async createPolicy(policy: PolicyRecord, tenant: TenantContext): Promise<PolicyRecord> {
    return this.store.withCollectionLock('policies', async () => {
      if (policy.organisationId !== tenant.organisationId) {
        throw new Error('Policy organisation does not match tenant context.');
      }

      if ((await this.store.queryCollection<PolicyRecord>('policies', { id: policy.id })).length > 0) {
        throw new Error(`Policy ${policy.id} already exists.`);
      }

      await this.store.updateTenantCollection<PolicyRecord, void>('policies', tenant.organisationId, policies => {
        if (policies.some(item => item.id === policy.id)) throw new Error(`Policy ${policy.id} already exists.`);
        policies.push(policy);
      });
      await this.writeAudit(tenant, 'policy.created', 'policy', policy.id, undefined, {
        policyType: policy.policyType,
        status: policy.status,
        version: policy.version,
      });
      return policy;
    });
  }

  async getPolicyById(tenant: TenantContext, policyId: string): Promise<PolicyRecord | null> {
    const [record] = await this.store.queryCollection<PolicyRecord>('policies', {
      id: policyId,
      organisationId: tenant.organisationId,
    });
    return assertTenantAccess(tenant, record) ?? null;
  }

  async listPolicies(tenant: TenantContext): Promise<PolicyRecord[]> {
    return this.store.queryCollection<PolicyRecord>('policies', {
      organisationId: tenant.organisationId,
    });
  }

  async createVersion(
    policyId: string,
    version: PolicyVersionRecord,
    tenant: TenantContext,
  ): Promise<PolicyVersionRecord> {
    return this.store.withCollectionLock('policyVersions', async () => {
      if (version.organisationId !== tenant.organisationId) {
        throw new Error('Policy version organisation does not match tenant context.');
      }
      if (version.status !== 'draft' && version.status !== 'pending_approval' && version.status !== 'approved' && version.status !== 'active' && version.status !== 'rejected' && version.status !== 'expired' && version.status !== 'archived') {
        throw new Error('Policy version has an unsupported status.');
      }
      validateEffectiveDates(version);

      const policy = await this.store.queryCollection<PolicyRecord>('policies', {
        id: policyId,
        organisationId: tenant.organisationId,
      });
      if (!policy.length) {
        throw new Error(`Policy ${policyId} does not exist for tenant ${tenant.organisationId}.`);
      }

      const normalizedVersion: PolicyVersionRecord = {
        ...version,
        policyId,
      };

      await this.store.updateTenantCollection<PolicyVersionRecord, void>('policyVersions', tenant.organisationId, versions => {
        const versionExists = versions.some(item => item.policyId === policyId && item.version === normalizedVersion.version);
        if (versionExists) throw new Error(`Policy version ${normalizedVersion.version} for ${policyId} already exists.`);
        versions.push(normalizedVersion);
      });
      await this.writeAudit(tenant, 'policy_version.created', 'policy_version', normalizedVersion.id, undefined, {
        policyId,
        version: normalizedVersion.version,
        status: normalizedVersion.status,
        effectiveFrom: normalizedVersion.effectiveFrom,
        effectiveTo: normalizedVersion.effectiveTo,
      });
      return normalizedVersion;
    });
  }

  async getVersionById(tenant: TenantContext, versionId: string): Promise<PolicyVersionRecord | null> {
    const [record] = await this.store.queryCollection<PolicyVersionRecord>('policyVersions', {
      id: versionId,
      organisationId: tenant.organisationId,
    });
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
    return this.store.queryCollection<PolicyVersionRecord>('policyVersions', {
      organisationId: tenant.organisationId,
      policyId,
    });
  }

  async transitionVersionStatus(
    tenantOrVersionId: TenantContext | string,
    versionIdOrStatus: string | PolicyVersionRecord['status'],
    maybeStatusOrTenant?: PolicyVersionRecord['status'] | TenantContext,
  ): Promise<PolicyVersionRecord | null> {
    return this.store.withCollectionLock('policyVersions', async () => {
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

      return this.store.updateTenantCollection<PolicyVersionRecord, PolicyVersionRecord | null>(
        'policyVersions', tenant.organisationId, async versions => {
          const index = versions.findIndex(item => item.id === versionId);
          const current = versions[index];
          if (index === -1 || !current) return null;
          if (!isAllowedTransition(current.status, status)) {
            throw new Error(`Policy version cannot transition from ${current.status} to ${status}.`);
          }

          const approvals = await this.store.queryCollection<PolicyApprovalRecord>('policyApprovals', {
            policyVersionId: versionId,
            organisationId: tenant.organisationId,
            decision: 'approved',
          });
          const hasApproval = approvals.some(approval => !approval.extractedRuleId);
          if (status === 'approved' && !hasApproval) {
            throw new Error('Policy version requires an approved reviewer decision before approval.');
          }
          if (status === 'active') {
            if (!hasApproval) {
              throw new Error('Policy version requires an approved reviewer decision before activation.');
            }
            validateActivationWindow(current);
          }

          const updated: PolicyVersionRecord = {
            ...current,
            status,
            updatedAt: new Date().toISOString(),
          };
          versions[index] = updated;
          await this.writeAudit(tenant, 'policy_version.status_changed', 'policy_version', versionId, {
            status: current.status,
          }, {
            status: updated.status,
          });
          return updated;
        },
      );
    });
  }

  async activateVersion(
    tenant: TenantContext,
    policyId: string,
    versionId: string,
  ): Promise<PolicyVersionRecord | null> {
    return this.store.withCollectionLock('policyVersions', async () => {
      return this.store.updateTenantCollection<PolicyVersionRecord, PolicyVersionRecord | null>(
        'policyVersions', tenant.organisationId, versions => {
          const targetIndex = versions.findIndex(item => item.id === versionId && item.policyId === policyId);
          const target = versions[targetIndex];
          if (!target || target.status !== 'approved' || target.effectiveFrom === null) return null;

          const targetEffectiveFrom = target.effectiveFrom;
          const now = new Date().toISOString();
          const activeVersions = versions.filter(item => item.policyId === policyId && item.status === 'active');
          if (activeVersions.some(item =>
            item.effectiveFrom === null || Date.parse(targetEffectiveFrom) <= Date.parse(item.effectiveFrom),
          )) return null;

          const updated: PolicyVersionRecord = { ...target, status: 'active', updatedAt: now };
          for (let index = 0; index < versions.length; index += 1) {
            const item = versions[index];
            if (item?.policyId === policyId && item.status === 'active') {
              versions[index] = {
                ...item,
                status: 'archived',
                effectiveTo: item.effectiveTo === null || Date.parse(targetEffectiveFrom) < Date.parse(item.effectiveTo)
                  ? targetEffectiveFrom
                  : item.effectiveTo,
                updatedAt: now,
              };
            }
          }
          versions[targetIndex] = updated;
          return updated;
        },
      );
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
    return this.store.withCollectionLock('extractedRules', async () => {
      if (incoming.some((rule) => rule.organisationId !== tenant.organisationId)) {
        throw new Error('Extracted rule organisation does not match tenant context.');
      }

      const versions = await this.store.queryCollection<PolicyVersionRecord>('policyVersions', {
        organisationId: tenant.organisationId,
      });
      const versionIds = new Set(
        versions.map(version => version.id),
      );
      if (incoming.some((rule) => !versionIds.has(rule.policyVersionId))) {
        throw new Error('Extracted rule references a policy version outside the tenant scope.');
      }

      return this.store.updateTenantCollection<ExtractedRuleRecord, ExtractedRuleRecord[]>(
        'extractedRules', tenant.organisationId, rules => {
          const existingById = new Map(rules.map(rule => [rule.id, rule]));
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

          if (additions.length > 0) rules.push(...additions);
          return result;
        },
      );
    });
  }

  async addApproval(approval: PolicyApprovalRecord, tenant: TenantContext): Promise<PolicyApprovalRecord> {
    return this.store.withCollectionLock('policyApprovals', async () => {
    if (approval.organisationId !== tenant.organisationId) {
      throw new Error('Approval organisation does not match tenant context.');
    }
    if (approval.reviewerId !== tenant.userId) {
      throw new Error('Approval reviewer must match the authenticated tenant user.');
    }
    if (approval.reason.trim().length === 0) {
      throw new Error('Approval decision reason is required.');
    }

    const [version] = await this.store.queryCollection<PolicyVersionRecord>('policyVersions', {
      id: approval.policyVersionId,
      organisationId: tenant.organisationId,
    });
    if (!version) {
      throw new Error('Policy version does not exist for this tenant.');
    }
    if (version.status !== 'pending_approval') {
      throw new Error('Reviewer decisions can only be recorded for pending policy versions.');
    }

    if ((await this.store.queryCollection<PolicyApprovalRecord>('policyApprovals', { id: approval.id })).length > 0) {
      throw new Error(`Approval ${approval.id} already exists.`);
    }
    await this.store.updateTenantCollection<PolicyApprovalRecord, void>('policyApprovals', tenant.organisationId, approvals => {
      if (approvals.some(item => item.id === approval.id)) throw new Error(`Approval ${approval.id} already exists.`);
      approvals.push(approval);
    });

    const nextStatus = approval.decision === 'approved' ? 'approved' : 'rejected';
    await this.transitionVersionStatus(tenant, approval.policyVersionId, nextStatus);
    await this.writeAudit(tenant, 'policy_version.reviewed', 'policy_version', approval.policyVersionId, undefined, {
      decision: approval.decision,
      reviewerId: approval.reviewerId,
      reason: approval.reason,
    });
    return approval;
    });
  }

  async listExtractedRules(tenant: TenantContext, policyVersionId?: string): Promise<ExtractedRuleRecord[]> {
    return this.store.queryCollection<ExtractedRuleRecord>('extractedRules', {
      organisationId: tenant.organisationId,
      ...(policyVersionId ? { policyVersionId } : {}),
    });
  }

  async getExtractedRuleById(tenant: TenantContext, ruleId: string): Promise<ExtractedRuleRecord | null> {
    const [record] = await this.store.queryCollection<ExtractedRuleRecord>('extractedRules', {
      id: ruleId,
      organisationId: tenant.organisationId,
    });
    return assertTenantAccess(tenant, record) ?? null;
  }

  async reviewExtractedRule(
    tenant: TenantContext,
    ruleId: string,
    decision: 'approved' | 'rejected' | 'changes_requested',
    reason: string,
    effectiveFrom?: string,
  ): Promise<ExtractedRuleRecord> {
    return this.store.withCollectionLock('extractedRules', async () => {
      if (!reason.trim()) throw new Error('Candidate-rule review reason is required.');
      if (effectiveFrom !== undefined && Number.isNaN(Date.parse(effectiveFrom))) {
        throw new Error('Candidate-rule effective-from date must be a valid timestamp.');
      }

      return this.store.updateTenantCollection<ExtractedRuleRecord, ExtractedRuleRecord>(
        'extractedRules', tenant.organisationId, async rules => {
          const index = rules.findIndex(rule => rule.id === ruleId);
          const current = rules[index];
          if (!current) throw new Error('Extracted rule does not exist for this tenant.');
          if (current.reviewStatus && current.reviewStatus !== 'pending_review') {
            const sameDecision = current.reviewStatus === decision;
            const sameReason = current.reviewReason === reason.trim();
            if (sameDecision && sameReason) return current;
            throw new Error('Candidate-rule review is immutable after a decision has been recorded.');
          }

          const timestamp = new Date().toISOString();
          const reviewed: ExtractedRuleRecord = {
            ...current,
            reviewStatus: decision,
            reviewedBy: tenant.userId,
            reviewReason: reason.trim(),
            reviewedAt: timestamp,
            effectiveFrom: effectiveFrom ?? null,
          };
          rules[index] = reviewed;

          if (decision === 'approved' || decision === 'rejected') {
            const approval: PolicyApprovalRecord = {
              id: `approval-${randomUUID()}`,
              organisationId: tenant.organisationId,
              extractedRuleId: ruleId,
              policyVersionId: current.policyVersionId,
              reviewerId: tenant.userId,
              decision,
              reason: reason.trim(),
              createdAt: timestamp,
              ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
            };
            await this.store.withCollectionLock('policyApprovals', async () => {
              await this.store.updateTenantCollection<PolicyApprovalRecord, void>(
                'policyApprovals', tenant.organisationId, approvals => {
                  if (approvals.some(item => item.extractedRuleId === ruleId)) {
                    throw new Error('Candidate-rule approval record already exists.');
                  }
                  approvals.push(approval);
                },
              );
            });
          }

          await this.writeAudit(tenant, `extracted_rule.${decision}`, 'policy_version', current.policyVersionId, {
            reviewStatus: 'pending_review',
          }, {
            reviewStatus: decision,
            reviewedBy: tenant.userId,
            reason: reason.trim(),
            effectiveFrom: effectiveFrom ?? null,
          });
          return reviewed;
        },
      );
    });
  }

  private async writeAudit(
    tenant: TenantContext,
    action: string,
    targetType: PolicyAuditRecord['targetType'],
    targetId: string,
    before?: Record<string, unknown>,
    after?: Record<string, unknown>,
  ): Promise<void> {
    await this.store.withCollectionLock('auditLogs', async () => {
      await this.store.updateTenantCollection<PolicyAuditRecord, void>('auditLogs', tenant.organisationId, auditLogs => {
        auditLogs.push({
          id: `audit-${randomUUID()}`,
          organisationId: tenant.organisationId,
          actorId: tenant.userId,
          action,
          targetType,
          targetId,
          createdAt: new Date().toISOString(),
          ...(before === undefined ? {} : { before }),
          ...(after === undefined ? {} : { after }),
        });
      });
    });
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
