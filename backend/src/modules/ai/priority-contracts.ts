import { AiOutputValidationError, type AiTaskExecution, type TicketAiView } from './contracts.js';
import type { IncidentPriority, PriorityCandidate, PriorityImpactFactor, PriorityUrgencyFactor } from './components/priority-matrix.js';

/** Offsets are zero-based UTF-16 positions; end is exclusive, as in String.slice. */
export type TicketEvidence = {
  ticketId: string;
  field: 'title' | 'description' | 'product' | 'affectedService' | 'affectedUsers.scope' | 'affectedUsers.count' | 'businessImpact' | 'urgency';
  start: number;
  end: number;
  excerpt: string;
};
export type PriorityFactorAssessment<T extends string> = {
  value: T | null;
  reason: string;
  confidence: number | null;
  evidence: TicketEvidence[];
};
export type PriorityFactorOutput = {
  impact: PriorityFactorAssessment<PriorityImpactFactor>;
  urgency: PriorityFactorAssessment<PriorityUrgencyFactor>;
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
  function factor<T extends string>(value: unknown, allowedValues: readonly T[]): PriorityFactorAssessment<T> {
    const assessment = record(value, ['value', 'reason', 'confidence', 'evidence']);
    if (assessment.value !== null && !allowedValues.includes(assessment.value as T)) return fail();
    if (typeof assessment.reason !== 'string' || !assessment.reason.trim()) return fail();
    const confidence = assessment.confidence;
    if (confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) return fail();
    if (!Array.isArray(assessment.evidence)) return fail();
    const evidence = assessment.evidence.map((value: unknown): TicketEvidence => {
      const entry = record(value, ['ticketId', 'field', 'start', 'end', 'excerpt']);
      const field = entry.field;
      if (entry.ticketId !== ticket.id || typeof field !== 'string') return fail();
      const text = priorityEvidenceText(ticket, field);
      if (text === null) return fail();
      if (typeof entry.start !== 'number' || typeof entry.end !== 'number' ||
        !Number.isInteger(entry.start) || !Number.isInteger(entry.end) || entry.start < 0 ||
        entry.end <= entry.start || entry.end > text.length || typeof entry.excerpt !== 'string' ||
        !entry.excerpt.trim() || text.slice(entry.start, entry.end) !== entry.excerpt) return fail();
      return { ticketId: ticket.id, field: field as TicketEvidence['field'], start: entry.start, end: entry.end, excerpt: entry.excerpt };
    });
    if (assessment.value !== null && evidence.length === 0) return fail();
    return { value: assessment.value as T | null, reason: assessment.reason.trim(), confidence: confidence as number | null, evidence };
  }
  let impact = factor(output.impact, ['critical', 'high', 'medium', 'low']);
  let urgency = factor(output.urgency, ['immediate', 'high', 'medium', 'low']);
  const missingInformation = strings(output.missingInformation);
  const warnings = strings(output.warnings);
  if (ticket.businessImpact && impact.value !== null && impact.value !== ticket.businessImpact) {
    impact = { ...impact, value: null, confidence: null, evidence: [] };
    missingInformation.push('The assessed impact conflicts with the requester-selected business impact.');
    warnings.push('STRUCTURED_BUSINESS_IMPACT_CONFLICT');
  }
  if (ticket.urgency && urgency.value !== null && urgency.value !== ticket.urgency) {
    urgency = { ...urgency, value: null, confidence: null, evidence: [] };
    missingInformation.push('The assessed urgency conflicts with the requester-selected urgency.');
    warnings.push('STRUCTURED_URGENCY_CONFLICT');
  }
  return {
    impact,
    urgency,
    missingInformation, warnings,
  };
}

function priorityEvidenceText(ticket: TicketAiView, field: string): string | null {
  if (field === 'title' || field === 'description') return ticket[field];
  if (field === 'product' || field === 'affectedService') return ticket[field] ?? null;
  if (field === 'businessImpact') return ticket.businessImpact ?? null;
  if (field === 'urgency') return ticket.urgency ?? null;
  if (field === 'affectedUsers.scope') return ticket.affectedUsers?.scope ?? null;
  if (field === 'affectedUsers.count') return ticket.affectedUsers?.count === undefined ? null : String(ticket.affectedUsers.count);
  return null;
}
