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
  executionId?: string;
  documentId?: string;
  documentVersionId?: string;
  ruleType: string;
  payload: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
  confidence: number | null;
  ambiguous: boolean;
  createdAt: string;
  requiresHumanReview?: boolean;
  warnings?: string[];
  reviewStatus?: 'pending_review' | 'approved' | 'rejected' | 'changes_requested';
  reviewedBy?: string;
  reviewReason?: string;
  reviewedAt?: string;
  effectiveFrom?: string | null;
};

export type PolicyApprovalRecord = {
  id: string;
  organisationId: string;
  extractedRuleId?: string;
  policyVersionId: string;
  reviewerId: string;
  decision: 'approved' | 'rejected';
  reason: string;
  effectiveFrom?: string;
  createdAt: string;
};

export type PolicyAuditRecord = {
  id: string;
  organisationId: string;
  actorId: string;
  action: string;
  targetType: 'policy' | 'policy_version';
  targetId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  createdAt: string;
};
