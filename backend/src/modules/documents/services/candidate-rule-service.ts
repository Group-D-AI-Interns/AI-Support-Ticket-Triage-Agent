import { randomUUID } from 'node:crypto';

import type { TenantContext } from '../../../shared/tenant.js';
import type { ExtractedRuleRecord } from '../../policies/domain/policy.js';
import type { PolicyRepository } from '../../policies/repositories/policy.repository.js';
import { validateExtractionOutput, type ValidatedExtractionOutput } from './provisional-extraction-adapter.js';

export type PersistCandidateRuleInput = {
  tenant: TenantContext;
  policyId: string;
  policyVersionId: string;
  rule: ValidatedExtractionOutput | Record<string, unknown>;
};

export class CandidateRuleService {
  constructor(private readonly policyRepository: PolicyRepository) {}

  async persistCandidateRule(input: PersistCandidateRuleInput): Promise<ExtractedRuleRecord> {
    const normalized = validateExtractionOutput(input.rule);
    const timestamp = new Date().toISOString();

    const record: ExtractedRuleRecord = {
      id: `rule-${randomUUID()}`,
      organisationId: input.tenant.organisationId,
      policyVersionId: input.policyVersionId,
      ruleType: normalized.ruleType,
      payload: normalized.payload,
      evidence: normalized.evidence as Array<Record<string, unknown>>,
      confidence: normalized.confidence,
      ambigous: normalized.ambiguity,
      createdAt: timestamp,
    };

    return this.policyRepository.createExtractedRule(record, input.tenant);
  }
}
