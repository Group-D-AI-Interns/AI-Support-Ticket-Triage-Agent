import { createHash } from 'node:crypto';

import type { TenantContext } from '../../../shared/tenant.js';
import type { ExtractedRuleRecord } from '../../policies/domain/policy.js';
import type { PolicyRepository } from '../../policies/repositories/policy.repository.js';
import {
  validateExtractionOutput,
  type ValidatedExtractionOutput,
} from './extraction-adapter.js';

export type PersistCandidateRuleInput = {
  tenant: TenantContext;
  policyId: string;
  policyVersionId: string;
  rule: ValidatedExtractionOutput | Record<string, unknown>;
};

export type PersistCandidateRulesInput = {
  tenant: TenantContext;
  policyId: string;
  policyVersionId: string;
  executionId: string;
  rules: Array<ValidatedExtractionOutput | Record<string, unknown>>;
};

export class CandidateRuleService {
  constructor(private readonly policyRepository: PolicyRepository) {}

  async persistCandidateRule(input: PersistCandidateRuleInput): Promise<ExtractedRuleRecord> {
    const normalized = validateExtractionOutput(input.rule);
    const [record] = await this.persistCandidateRules({
      tenant: input.tenant,
      policyId: input.policyId,
      policyVersionId: input.policyVersionId,
      executionId: normalized.executionId,
      rules: [normalized],
    });
    if (!record) {
      throw new Error('Candidate rule was not persisted.');
    }
    return record;
  }

  async assertPolicyVersionTarget(
    tenant: TenantContext,
    policyId: string,
    policyVersionId: string,
  ): Promise<void> {
    const version = await this.policyRepository.getVersionById(tenant, policyVersionId);
    if (!version || version.policyId !== policyId) {
      throw new Error('Extraction job policy version is missing or outside the requested policy.');
    }
  }

  async persistCandidateRules(
    input: PersistCandidateRulesInput,
  ): Promise<ExtractedRuleRecord[]> {
    await this.assertPolicyVersionTarget(input.tenant, input.policyId, input.policyVersionId);
    const timestamp = new Date().toISOString();
    const records = input.rules.map((rule, index): ExtractedRuleRecord => {
      const normalized = validateExtractionOutput(rule);
      if (normalized.executionId !== input.executionId) {
        throw new Error('Candidate rule execution ID does not match the extraction batch.');
      }
      const idempotencyKey = createHash('sha256')
        .update(`${input.tenant.organisationId}\0${input.policyVersionId}\0${input.executionId}\0${index}`)
        .digest('hex');
      return {
        id: `rule-${idempotencyKey}`,
        organisationId: input.tenant.organisationId,
        policyVersionId: input.policyVersionId,
        executionId: input.executionId,
        documentId: normalized.documentId,
        documentVersionId: normalized.documentVersionId,
        ruleType: normalized.ruleType,
        payload: normalized.payload,
        evidence: normalized.evidence,
        confidence: normalized.confidence,
        ambiguous: normalized.ambiguity,
        createdAt: timestamp,
        requiresHumanReview: normalized.requiresHumanReview,
        warnings: normalized.warnings,
        reviewStatus: 'pending_review',
      };
    });
    return this.policyRepository.createExtractedRules(records, input.tenant);
  }
}
