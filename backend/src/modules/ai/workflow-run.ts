import * as z from 'zod';
import type { JsonEnvelope } from '../../infrastructure/persistence/json/json-file-store.js';
import type { AnalysisOrchestration, GraphFailure } from './ticket-analysis.graph.js';
import type { AiTaskExecution } from './contracts.js';

export type AiWorkflowRun = AnalysisOrchestration & {
  organisationId: string; ticketId: string; initiatedBy: string;
  executions: AiTaskExecution[]; failure: GraphFailure | null;
};
const text = z.string().trim().min(1);
const timestamp = z.iso.datetime({ offset: true });
const usage = z.strictObject({ promptTokens: z.number().int().nonnegative().optional(), completionTokens: z.number().int().nonnegative().optional(), totalTokens: z.number().int().nonnegative().optional() });
export const orchestrationSchema = z.strictObject({
  engine: z.literal('langgraph'), version: z.literal('ticket-analysis-v1'), runId: text,
  status: z.enum(['completed', 'insufficient_information', 'invalid_analysis', 'failed']),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: timestamp, completedAt: timestamp, trace: z.array(text).max(10), warnings: z.array(text),
  promptVersions: z.strictObject({ classification: text, summarization: text }).optional(),
});
const execution = z.strictObject({ executionId: text, task: z.enum(['ticket_classification', 'ticket_summarization']), status: z.literal('completed'),
  validationRetryOf: text.optional(),
  provider: text, model: text, attempts: z.number().int().positive(), durationMs: z.number().finite().nonnegative(), startedAt: timestamp, completedAt: timestamp,
  usage: usage.optional() });
const runSchema = orchestrationSchema.extend({
  organisationId: text, ticketId: text, initiatedBy: text, executions: z.array(execution).max(2),
  failure: z.object({ code: text, executionId: text, task: z.enum(['ticket_classification', 'ticket_summarization']) }).nullable(),
}).superRefine((run, ctx) => {
  const successful = run.status === 'completed' || run.status === 'insufficient_information';
  if ((successful && (run.executions.length !== 2 || run.failure !== null)) || (!successful && run.failure === null) ||
    Date.parse(run.completedAt) < Date.parse(run.startedAt)) ctx.addIssue({ code: 'custom', message: 'Inconsistent workflow outcome.' });
});
export function isWorkflowRuns(value: unknown): value is JsonEnvelope<AiWorkflowRun> {
  return z.object({ schemaVersion: z.literal(1), records: z.array(runSchema) }).safeParse(value).success;
}
