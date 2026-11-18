import type { SlaEvaluation, SlaEvaluationInput } from '../services/sla-evaluator.js';

export type SlaEvaluationRecord = {
  id: string;
  organisationId: string;
  ticketId: string;
  policyId: string;
  policyVersionId: string;
  evaluatedAt: string;
  input: SlaEvaluationInput;
  result: SlaEvaluation;
};
