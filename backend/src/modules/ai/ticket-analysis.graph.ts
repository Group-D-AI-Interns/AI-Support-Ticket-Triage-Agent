import { createHash, randomUUID } from 'node:crypto';
import { END, START, StateGraph, StateSchema } from '@langchain/langgraph';
import * as z from 'zod';
import { AiExecutionError } from './ai-execution-runner.js';
import { CLASSIFICATION_PROMPT_VERSION, validateTicketClassificationCategories, type TicketClassifier } from './components/ticket-classifier.js';
import { SUMMARIZATION_PROMPT_VERSION, type TicketSummarizer } from './components/ticket-summarizer.js';
import type { AiTask, AiTaskExecution, TicketAiView, TicketClassification, TicketClassificationCategory, TicketSummary } from './contracts.js';

export type AnalysisRoute = 'completed' | 'insufficient_information' | 'invalid_analysis' | 'failed';
export type GraphFailure = { code: string; executionId: string; task: AiTask };
export type AnalysisOrchestration = {
  engine: 'langgraph'; version: 'ticket-analysis-v1'; runId: string; status: AnalysisRoute;
  snapshotHash: string; configurationHash: string; startedAt: string; completedAt: string;
  trace: string[]; warnings: string[];
  promptVersions?: { classification: string; summarization: string };
};
export type TicketAnalysisGraphState = {
  ticket: TicketAiView; categories: TicketClassificationCategory[]; informationToCollect: string[];
  classification: TicketClassification | null; summary: TicketSummary | null;
  executions: AiTaskExecution[]; warnings: string[]; trace: string[];
  status: AnalysisRoute; failure: GraphFailure | null;
};
const State = new StateSchema({
  ticket: z.custom<TicketAiView>(), categories: z.custom<TicketClassificationCategory[]>(), informationToCollect: z.array(z.string()),
  classification: z.custom<TicketClassification>().nullable(), summary: z.custom<TicketSummary>().nullable(),
  executions: z.custom<AiTaskExecution[]>(), warnings: z.array(z.string()), trace: z.array(z.string()),
  status: z.enum(['completed', 'insufficient_information', 'invalid_analysis', 'failed']), failure: z.custom<GraphFailure>().nullable(),
});
export function ticketSnapshotHash(ticket: TicketAiView): string {
  return createHash('sha256').update(JSON.stringify({ id: ticket.id, organisationId: ticket.organisationId, title: ticket.title, description: ticket.description })).digest('hex');
}

/** Only orchestrates already-authorized data. No identity, permission, mutation or persistence node. */
export class TicketAnalysisGraph {
  private readonly graph;
  constructor(classifier: Pick<TicketClassifier, 'classify'>, summarizer: Pick<TicketSummarizer, 'summarize'>) {
    const failure = (error: unknown, state: TicketAnalysisGraphState, node: string): Partial<TicketAnalysisGraphState> => {
      if (!(error instanceof AiExecutionError)) throw error;
      return { failure: { code: error.code, executionId: error.executionId, task: error.task },
        trace: [...state.trace, node], status: error.code === 'INVALID_OUTPUT' ? 'invalid_analysis' : 'failed' };
    };
    this.graph = new StateGraph(State)
      .addNode('classify', async (state: TicketAnalysisGraphState): Promise<Partial<TicketAnalysisGraphState>> => {
        try {
          const output = await classifier.classify({ ticket: structuredClone(state.ticket), categories: structuredClone(state.categories) });
          return { classification: output.result, executions: [...state.executions, output.execution], warnings: [...state.warnings, ...output.result.warnings], trace: [...state.trace, 'classify'] };
        } catch (error) { return failure(error, state, 'classify'); }
      })
      .addNode('summarize', async (state: TicketAnalysisGraphState): Promise<Partial<TicketAnalysisGraphState>> => {
        try {
          const output = await summarizer.summarize({ ticket: structuredClone(state.ticket), informationToCollect: [...state.informationToCollect] });
          return { summary: output.result, executions: [...state.executions, output.execution], warnings: [...state.warnings, ...output.result.warnings], trace: [...state.trace, 'summarize'] };
        } catch (error) { return failure(error, state, 'summarize'); }
      })
      .addNode('review', (state: TicketAnalysisGraphState) => ({ status: 'insufficient_information' as const, warnings: [...state.warnings, 'HUMAN_REVIEW_REQUIRED'], trace: [...state.trace, 'review'] }))
      .addNode('complete', (state: TicketAnalysisGraphState) => ({ status: 'completed' as const, trace: [...state.trace, 'complete'] }))
      .addNode('invalid', (state: TicketAnalysisGraphState) => ({ warnings: [...state.warnings, 'INVALID_ANALYSIS'], trace: [...state.trace, 'invalid'] }))
      .addNode('execution_failed', (state: TicketAnalysisGraphState) => ({ warnings: [...state.warnings, 'AI_EXECUTION_FAILED'], trace: [...state.trace, 'execution_failed'] }))
      .addEdge(START, 'classify')
      .addConditionalEdges('classify', state => state.failure ? (state.status === 'invalid_analysis' ? 'invalid' : 'execution_failed') : 'summarize', ['invalid', 'execution_failed', 'summarize'])
      .addConditionalEdges('summarize', state => {
        if (state.failure) return state.status === 'invalid_analysis' ? 'invalid' : 'execution_failed';
        return state.classification?.category === null || state.classification?.confidence === null || state.classification?.requiresHumanReview || state.summary?.missingInformation.length ? 'review' : 'complete';
      }, ['invalid', 'execution_failed', 'review', 'complete'])
      .addEdge('review', END).addEdge('complete', END).addEdge('invalid', END).addEdge('execution_failed', END)
      .compile(); // No checkpointer/store. Application result files are not graph checkpoints.
  }
  async run(input: { ticket: TicketAiView; categories: TicketClassificationCategory[]; informationToCollect?: string[] }) {
    validateTicketClassificationCategories(input.categories);
    const categories = structuredClone(input.categories);
    const informationToCollect = input.informationToCollect === undefined ? [] : structuredClone(input.informationToCollect);
    if (!Array.isArray(informationToCollect) || informationToCollect.some(item => typeof item !== 'string' || !item.trim())) throw new Error('informationToCollect must contain non-empty strings.');
    const ticket = { id: input.ticket.id, organisationId: input.ticket.organisationId, title: input.ticket.title, description: input.ticket.description };
    if (![ticket.id, ticket.organisationId, ticket.title].every(value => typeof value === 'string' && value.trim()) || typeof ticket.description !== 'string') throw new Error('Invalid authorized ticket snapshot.');
    const startedAt = new Date().toISOString();
    const promptVersions = { classification: CLASSIFICATION_PROMPT_VERSION, summarization: SUMMARIZATION_PROMPT_VERSION };
    const configurationHash = createHash('sha256').update(JSON.stringify({ categories, informationToCollect, promptVersions })).digest('hex');
    const state = await this.graph.invoke({ ticket, categories, informationToCollect,
      classification: null, summary: null, executions: [], warnings: [], trace: [], status: 'completed', failure: null }, { recursionLimit: 10, callbacks: [] });
    const orchestration: AnalysisOrchestration = { engine: 'langgraph', version: 'ticket-analysis-v1', runId: `run_${randomUUID()}`, status: state.status,
      snapshotHash: ticketSnapshotHash(ticket), configurationHash,
      startedAt, completedAt: new Date().toISOString(), trace: state.trace, warnings: [...new Set(state.warnings)], promptVersions };
    return { ...state, orchestration };
  }
}
