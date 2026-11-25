import { AiOutputValidationError, type AiTaskExecution, type TicketAiView } from './contracts.js';
import type { IncidentPriority, PriorityCandidate, PriorityFactor } from './components/priority-matrix.js';

/** Offsets are zero-based UTF-16 positions; end is exclusive, as in String.slice. */
export type TicketEvidence = {
  ticketId: string;
  field: 'title' | 'description';
  start: number;
  end: number;
  excerpt: string;
};
export type PriorityFactorAssessment = {
  value: PriorityFactor | null;
  reason: string;
  confidence: number | null;
  evidence: TicketEvidence[];
};
export type PriorityFactorOutput = {
  impact: PriorityFactorAssessment;
  urgency: PriorityFactorAssessment;
  missingInformation: string[];
  warnings: string[];
};
export type PriorityRecommendation = {
  ticketId: string;
  organisationId: string;
  policyStatus: 'draft' | 'active';
  status: 'recommendation' | 'insufficient_information';
  priority: IncidentPriority | null;
  factors: PriorityFactorOutput;
  requiresHumanReview: true;
  missingInformation: string[];
  warnings: string[];
  policyEvidence: PriorityCandidate['source'];
  execution: AiTaskExecution;
};

function fail(): never { throw new AiOutputValidationError('Priority factor output or ticket evidence is invalid.'); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return fail();
  return result;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) return fail();
  return value.map(item => (item as string).trim());
}
export function validatePriorityFactors(value: unknown, ticket: TicketAiView): PriorityFactorOutput {
  const output = record(value, ['impact', 'urgency', 'missingInformation', 'warnings']);
  function factor(value: unknown): PriorityFactorAssessment {
    const assessment = record(value, ['value', 'reason', 'confidence', 'evidence']);
    if (assessment.value !== null && !['high', 'medium', 'low'].includes(assessment.value as string)) return fail();
    if (typeof assessment.reason !== 'string' || !assessment.reason.trim()) return fail();
    const confidence = assessment.confidence;
    if (confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) return fail();
    if (!Array.isArray(assessment.evidence)) return fail();
    const evidence = assessment.evidence.map((value: unknown): TicketEvidence => {
      const entry = record(value, ['ticketId', 'field', 'start', 'end', 'excerpt']);
      if (entry.ticketId !== ticket.id || (entry.field !== 'title' && entry.field !== 'description')) return fail();
      const text = ticket[entry.field];
      if (typeof entry.start !== 'number' || typeof entry.end !== 'number' ||
        !Number.isInteger(entry.start) || !Number.isInteger(entry.end) || entry.start < 0 ||
        entry.end <= entry.start || entry.end > text.length || typeof entry.excerpt !== 'string' ||
        !entry.excerpt.trim() || text.slice(entry.start, entry.end) !== entry.excerpt) return fail();
      return { ticketId: ticket.id, field: entry.field, start: entry.start, end: entry.end, excerpt: entry.excerpt };
    });
    if (assessment.value !== null && evidence.length === 0) return fail();
    return { value: assessment.value as PriorityFactor | null, reason: assessment.reason.trim(), confidence: confidence as number | null, evidence };
  }
  return { impact: factor(output.impact), urgency: factor(output.urgency), missingInformation: strings(output.missingInformation), warnings: strings(output.warnings) };
}
