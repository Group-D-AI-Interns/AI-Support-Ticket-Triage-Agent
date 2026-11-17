export type PolicyStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'active'
  | 'rejected'
  | 'expired'
  | 'archived';

export type PolicyRecord = {
  id: string;
  organisationId: string;
  policyType: string;
  ownerId: string;
  status: PolicyStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
  description: string;
};

export type PolicyVersionRecord = {
  id: string;
  organisationId: string;
  policyId: string;
  version: number;
  status: PolicyStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ExtractedRuleRecord = {
  id: string;
  organisationId: string;
  policyVersionId: string;
  ruleType: string;
  payload: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
  confidence: number | null;
  ambigous: boolean;
  createdAt: string;
};

export type PolicyApprovalRecord = {
  id: string;
  organisationId: string;
  policyVersionId: string;
  reviewerId: string;
  decision: 'approved' | 'rejected';
  reason: string;
  createdAt: string;
};
