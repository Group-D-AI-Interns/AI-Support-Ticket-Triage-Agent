import * as z from 'zod';
import { validateTicketClassification, validateTicketSummary } from './contracts.js';
import { validatePriorityFactors } from './priority-contracts.js';
import { validateResolutionOutput } from './resolution-recommendation.service.js';
import { orchestrationSchema } from './workflow-run.js';
import type { TicketAiTriageService } from './ticket-ai-triage.service.js';

type Result = Awaited<ReturnType<TicketAiTriageService['analyze']>>;
const text = z.string().min(1);
const passage = z.strictObject({ passageId: text, sourceId: text, version: text, sourceType: z.enum(['approved_policy', 'knowledge_article', 'historical_ticket']),
  title: text, excerpt: text, start: z.number().int().nonnegative(), end: z.number().int().positive(), score: z.number().finite() });
const capability = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('completed'), data: z.json() }),
  z.strictObject({ status: z.enum(['unavailable', 'failed']), code: text, data: z.null() })]);
const shape = z.strictObject({ ticketId: text, organisationId: text, requiresHumanReview: z.literal(true), core: z.json(),
  priority: capability, evidence: capability, resolution: capability, routing: capability, sla: capability });

/** Guard durable aggregate records before serving or writing them; reuse model-output validators. */
export function validTriageResult(value: unknown): value is Result {
  if (!shape.safeParse(value).success) return false;
  try {
    const result = value as Result;
    if (result.core.ticketId !== result.ticketId || result.core.organisationId !== result.organisationId || result.core.status !== 'completed') return false;
    const category = result.core.classification.category;
    validateTicketClassification(result.core.classification, category ? [{ id: category, name: category }] : []);
    validateTicketSummary(result.core.summary);
    if (!orchestrationSchema.safeParse(result.core.orchestration).success) return false;
    if (result.evidence.status === 'completed' && !z.array(passage).safeParse(result.evidence.data).success) return false;
    if (result.resolution.status === 'completed') {
      const resolution = result.resolution.data;
      if (resolution.ticketId !== result.ticketId || resolution.organisationId !== result.organisationId || resolution.requiresHumanReview !== true ||
        !['recommendation', 'insufficient_evidence'].includes(resolution.status) || !z.array(passage).safeParse(resolution.evidence).success) return false;
      validateResolutionOutput({ summary: resolution.summary, steps: resolution.steps, missingInformation: resolution.missingInformation, warnings: resolution.warnings }, resolution.evidence);
    }
    if (result.priority.status === 'completed' && (result.priority.data.ticketId !== result.ticketId || result.priority.data.organisationId !== result.organisationId || result.priority.data.requiresHumanReview !== true)) return false;
    if (result.routing.status === 'completed' && !z.strictObject({ status: z.enum(['recommendation','insufficient_information','unavailable']), teamId: text.nullable(),
      evidence: z.array(z.strictObject({ ruleId: text, version: text })), warnings: z.array(z.string()), requiresHumanReview: z.literal(true) }).safeParse(result.routing.data).success) return false;
    if (result.sla.status === 'completed' && (!result.sla.data || !['available','unavailable','stale'].includes(result.sla.data.status) || result.sla.data.requiresHumanReview !== true)) return false;
    if (result.sla.status === 'completed' && result.sla.data.evaluation) {
      const evaluation = result.sla.data.evaluation;
      if ([evaluation, evaluation.input, evaluation.result].some(row => row.organisationId !== result.organisationId || row.ticketId !== result.ticketId) ||
        evaluation.result.policyId !== evaluation.policyId || evaluation.result.policyVersionId !== evaluation.policyVersionId) return false;
    }
    return true;
  } catch { return false; }
}

export function validPriorityEvidence(result: Result, snapshot: import('./contracts.js').TicketAiView) {
  try { if (result.priority.status === 'completed') validatePriorityFactors(result.priority.data.factors, snapshot); return true; }
  catch { return false; }
}
