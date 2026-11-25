import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod';
import type { TenantContext } from '../../shared/tenant.js';
import type { TicketAiAnalysis, TicketAiView, TicketClassificationCategory } from './contracts.js';
import { AiOperationsStore, type OfKind } from './operations-store.js';
import { AiOperationsError } from './operations-service.js';
import { AiExecutionError } from './ai-execution-runner.js';

export const evaluationCase = z.strictObject({ id: z.string().min(1), title: z.string().min(1).max(500), description: z.string().max(8_000),
  expectedCategory: z.string().min(1).nullable(), requiredFacts: z.array(z.string().min(1).max(500)).max(20), prohibitedFacts: z.array(z.string().min(1).max(500)).max(20) });
export const evaluationDataset = z.strictObject({ version: z.string().min(1), cases: z.array(evaluationCase).min(1).max(10) });
export type SampleEvaluator = (tenant: TenantContext, ticket: TicketAiView, categories: TicketClassificationCategory[]) => Promise<TicketAiAnalysis>;
function normalized(value: string) { return value.toLowerCase().replace(/\s+/g, ' ').trim(); }

export async function runQualityEvaluation(store: AiOperationsStore, tenant: TenantContext, input: unknown,
  categories: TicketClassificationCategory[], evaluate: SampleEvaluator) {
  const dataset = evaluationDataset.parse(input);
  if (new Set(dataset.cases.map(item => item.id)).size !== dataset.cases.length || dataset.cases.some(item => item.expectedCategory !== null && !categories.some(category => category.id === item.expectedCategory))) {
    throw new AiOperationsError(400, 'INVALID_EVALUATION_LABELS', 'Use unique case IDs and configured category labels.');
  }
  const cases = [];
  for (const sample of dataset.cases) {
    try {
      const analysis = await evaluate(tenant, { id: `evaluation-${randomUUID()}`, organisationId: tenant.organisationId, title: sample.title, description: sample.description }, categories);
      const output = normalized(JSON.stringify(analysis.summary));
      cases.push({ caseId: sample.id, status: 'completed', expectedCategory: sample.expectedCategory, actualCategory: analysis.classification.categories,
        categoryCorrect: sample.expectedCategory === null ? analysis.classification.categories.length === 0 : analysis.classification.categories.includes(sample.expectedCategory),
        requiredFacts: sample.requiredFacts.length, matchedFacts: sample.requiredFacts.filter(fact => output.includes(normalized(fact))).length,
        prohibitedFacts: sample.prohibitedFacts.length, prohibitedFactsPresent: sample.prohibitedFacts.filter(fact => output.includes(normalized(fact))).length,
        classification: analysis.classification, summary: analysis.summary,
        recoveredValidation: analysis.executions.some(execution => !!execution.validationRetryOf),
        executions: analysis.executions, promptVersions: analysis.orchestration?.promptVersions ?? {} });
    } catch (error) { cases.push({ caseId: sample.id, status: 'failed',
      errorCode: error instanceof AiExecutionError ? error.code : 'EVALUATION_CASE_FAILED',
      ...(error instanceof AiExecutionError ? { executionId: error.executionId, task: error.task } : {}) }); }
  }
  const successful = cases.filter(item => item.status === 'completed');
  const facts = successful.reduce((sum, item) => sum + (item.requiredFacts ?? 0), 0);
  const matched = successful.reduce((sum, item) => sum + (item.matchedFacts ?? 0), 0);
  const now = new Date().toISOString();
  const data = { datasetVersion: dataset.version, datasetHash: createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),
    metrics: { totalCases: cases.length, successfulCases: successful.length, failedCases: cases.length - successful.length,
      categoryAccuracy: successful.length ? successful.filter(item => item.categoryCorrect).length / successful.length : null,
      completionRate: successful.length / cases.length,
      recoveredCases: successful.filter(item => item.recoveredValidation).length,
      firstPassCompletionRate: successful.filter(item => !item.recoveredValidation).length / cases.length,
      categoryAccuracyOverAllCases: successful.filter(item => item.categoryCorrect).length / cases.length,
      requiredFactCoverage: facts ? matched / facts : null, prohibitedPhraseHits: successful.reduce((sum, item) => sum + (item.prohibitedFactsPresent ?? 0), 0),
      groundingMethod: 'lexical_proxy_only', semanticGroundedness: 'requires_human_review' }, cases };
  const record: OfKind<'evaluation'> = { id: `evaluation_${randomUUID()}`, kind: 'evaluation', organisationId: tenant.organisationId,
    actorId: tenant.userId, createdAt: now, updatedAt: now, data: JSON.parse(JSON.stringify(data)) };
  await store.changeForOrganisation(tenant.organisationId, rows => { rows.push(record); });
  return record;
}
