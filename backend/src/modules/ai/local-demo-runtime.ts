import type { TenantContext } from '../../shared/tenant.js';
import { TicketAiTriageService, type AiTriageCapabilities } from './ticket-ai-triage.service.js';
import type { AiWorkflowRun } from './workflow-run.js';
import type { SampleEvaluator } from './quality-evaluation.js';
import {
  AiExecutionRunner,
  type AiExecutionOptions,
} from './ai-execution-runner.js';
import type {
  TicketAiAnalysis,
  TicketClassificationCategory,
} from './contracts.js';
import { TicketClassifier, validateTicketClassificationCategories } from './components/ticket-classifier.js';
import { TicketSummarizer } from './components/ticket-summarizer.js';
import type {
  AiAnalysisRepository,
  AiExecutionLogEvent,
  AiExecutionLogger,
  AuthorizedTicketAnalysisSource,
} from './ports.js';
import {
  LlmProviderError,
  type StructuredGenerationProvider,
  type StructuredGenerationRequest,
  type StructuredGenerationResponse,
} from '../../infrastructure/llm/structured-generation-provider.js';
import { TicketAiAnalysisService } from './ticket-ai-analysis.service.js';

export type TicketAiDemoConfiguration = {
  categories: TicketClassificationCategory[];
};

export class TicketAiDemoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketAiDemoConfigurationError';
  }
}

export function ticketAiDemoConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): TicketAiDemoConfiguration | null {
  const enabled = environment.TICKET_AI_DEMO_ENABLED;
  if (enabled === undefined || enabled === 'false') {
    return null;
  }
  if (enabled !== 'true') {
    throw new TicketAiDemoConfigurationError(
      'TICKET_AI_DEMO_ENABLED must be either true or false.',
    );
  }
  if (environment.APP_ENV !== 'development') {
    throw new TicketAiDemoConfigurationError(
      'The local AI demo is permitted only when APP_ENV=development.',
    );
  }

  return { categories: ticketAiCategoriesFromEnvironment(environment) };
}

export function ticketAiCategoriesFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): TicketClassificationCategory[] {
  const rawCategories = environment.TICKET_AI_CATEGORIES;
  if (!rawCategories) {
    throw new TicketAiDemoConfigurationError(
      'TICKET_AI_CATEGORIES must contain the configured category list.',
    );
  }

  let categories: unknown;
  try {
    categories = JSON.parse(rawCategories);
  } catch {
    throw new TicketAiDemoConfigurationError(
      'TICKET_AI_CATEGORIES must contain valid JSON.',
    );
  }
  if (!Array.isArray(categories)) {
    throw new TicketAiDemoConfigurationError(
      'TICKET_AI_CATEGORIES must be a JSON array.',
    );
  }
  if (!categories.every(isClassificationCategory)) {
    throw new TicketAiDemoConfigurationError(
      'Each configured ticket category must include string id and name fields.',
    );
  }
  try {
    validateTicketClassificationCategories(categories);
  } catch (error) {
    throw new TicketAiDemoConfigurationError(
      error instanceof Error ? error.message : 'TICKET_AI_CATEGORIES is invalid.',
    );
  }
  return categories;
}

export function createLocalDemoTicketAiRuntime(
  source: AuthorizedTicketAnalysisSource,
  repository: AiAnalysisRepository = new InMemoryAiAnalysisRepository(),
): {
  priorityRunner: AiExecutionRunner;
  service: TicketAiAnalysisService;
  repository: AiAnalysisRepository;
  createTriageService(capabilities?: AiTriageCapabilities): TicketAiTriageService;
  evaluateSample: SampleEvaluator;
} {
  const runner = new AiExecutionRunner(
    new LocalDemoTicketAiProvider(),
    new ConsoleAiExecutionLogger(),
    {
      model: 'local-heuristic-v1',
      timeoutMs: 1_000,
      maxRetries: 0,
    } satisfies AiExecutionOptions,
  );
  const classifier = new TicketClassifier(runner);
  const summarizer = new TicketSummarizer(runner);
  return {
    priorityRunner: runner,
    evaluateSample: (tenant, ticket, categories) => new TicketAiAnalysisService({ async getAuthorizedTicket(context, id) {
      return context.organisationId === ticket.organisationId && id === ticket.id ? ticket : null;
    } }, classifier, summarizer, new InMemoryAiAnalysisRepository()).analyze({ tenant, ticketId: ticket.id, categories }),
    createTriageService: (capabilities = {}) => new TicketAiTriageService(source, classifier, summarizer, repository,
      { resolutionRunner: runner, ...capabilities }),
    service: new TicketAiAnalysisService(
      source,
      classifier,
      summarizer,
      repository,
    ),
    repository,
  };
}

export class InMemoryAiAnalysisRepository implements AiAnalysisRepository {
  private readonly records: TicketAiAnalysis[] = [];
  private readonly runs: AiWorkflowRun[] = [];
  async saveWorkflowRun(tenant: TenantContext, run: AiWorkflowRun): Promise<void> {
    if (run.organisationId !== tenant.organisationId || run.initiatedBy !== tenant.userId) throw new Error('Workflow run tenant mismatch.');
    this.runs.push(structuredClone(run));
  }
  async listWorkflowRuns(tenant: TenantContext, ticketId: string): Promise<AiWorkflowRun[]> {
    return structuredClone(this.runs.filter(run => run.organisationId === tenant.organisationId && run.ticketId === ticketId));
  }

  async save(tenant: TenantContext, analysis: TicketAiAnalysis): Promise<void> {
    if (analysis.organisationId !== tenant.organisationId) {
      throw new Error('AI analysis organisation does not match the trusted tenant.');
    }
    this.records.push(structuredClone(analysis));
  }

  async listForTicket(
    tenant: TenantContext,
    ticketId: string,
  ): Promise<TicketAiAnalysis[]> {
    return this.records
      .filter(
        (analysis) =>
          analysis.organisationId === tenant.organisationId &&
          analysis.ticketId === ticketId,
      )
      .map((analysis) => structuredClone(analysis));
  }
}

class ConsoleAiExecutionLogger implements AiExecutionLogger {
  async record(event: AiExecutionLogEvent): Promise<void> {
    console.info('Ticket AI execution', JSON.stringify(event));
  }
}

class LocalDemoTicketAiProvider implements StructuredGenerationProvider {
  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResponse> {
    if (request.signal.aborted) {
      throw new LlmProviderError('REQUEST_ABORTED', 'Generation was cancelled.', false);
    }

    const output = request.task === 'ticket_classification'
      ? classifyWithConfiguredTerms(request.input)
      : request.task === 'ticket_summarization'
        ? summarizeExtractively(request.input)
        : request.task === 'ticket_priority_factors'
          ? {
              impact: { value: null, reason: 'Demo does not infer impact.', confidence: null, evidence: [] },
              urgency: { value: null, reason: 'Demo does not infer urgency.', confidence: null, evidence: [] },
              missingInformation: ['Human-verified impact and urgency evidence'],
              warnings: ['DEMO_ONLY: no real priority inference performed.'],
            }
          : request.task === 'ticket_resolution'
            ? { summary: 'The offline demo does not infer technical fixes.', steps: [], missingInformation: ['Review the retrieved evidence and propose verified resolution steps.'], warnings: ['DEMO_ONLY: retrieval works, but no model-generated resolution is performed.'] }
            : (() => { throw new LlmProviderError('TASK_NOT_CONFIGURED', 'This task is not available in the local demo.', false); })();
    return {
      provider: 'local-demo-heuristic',
      model: request.model,
      output,
    };
  }
}

function classifyWithConfiguredTerms(input: unknown): unknown {
  const record = requireRecord(input);
  const ticket = requireTicketView(record.ticket);
  if (!Array.isArray(record.categories)) {
    throw new LlmProviderError('INVALID_REQUEST', 'Demo classification input is invalid.', false);
  }

  const ticketTerms = new Set(tokenize(`${ticket.title} ${ticket.description}`));
  const scored = record.categories.map((categoryValue) => {
    const category = requireRecord(categoryValue);
    const categoryId = requireString(category.id);
    const name = requireString(category.name);
    const description = typeof category.description === 'string'
      ? category.description
      : '';
    const matches = [...new Set(tokenize(`${categoryId} ${name} ${description}`))]
      .filter((term) => ticketTerms.has(term));
    return { categoryId, matches };
  });
  scored.sort((left, right) => right.matches.length - left.matches.length);
  const best = scored[0];
  const hasMatch = best !== undefined && best.matches.length > 0;

  return {
    category: hasMatch ? best.categoryId : null,
    reason: hasMatch
      ? `The local demo heuristic matched these configured terms: ${best.matches.join(', ')}.`
      : 'The local demo heuristic found no configured category-term match.',
    confidence: null,
    requiresHumanReview: true,
    warnings: ['DEMO_ONLY: deterministic keyword heuristic; not an LLM or calibrated classification.'],
  };
}

function summarizeExtractively(input: unknown): unknown {
  const record = requireRecord(input);
  const ticket = requireTicketView(record.ticket);
  const sentences = splitSentences(ticket.description);
  const summary = sentences.slice(0, 2).join(' ').trim() || ticket.title;

  return {
    summary,
    symptoms: [ticket.title],
    attemptedActions: sentences.filter((sentence) =>
      /\b(reset|restarted|restart|tried|attempted|reinstalled|installed|cleared|updated|ran|run|changed)\b/i
        .test(sentence),
    ),
    businessImpact: null,
    missingInformation: [],
    warnings: ['DEMO_ONLY: extractive summary; not an LLM-generated or completeness-checked summary.'],
  };
}

function requireTicketView(value: unknown): {
  id: string;
  title: string;
  description: string;
} {
  const record = requireRecord(value);
  if (
    typeof record.id !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.description !== 'string'
  ) {
    throw new LlmProviderError('INVALID_REQUEST', 'Demo ticket input is invalid.', false);
  }
  return {
    id: record.id,
    title: record.title,
    description: record.description,
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new LlmProviderError('INVALID_REQUEST', 'Demo provider input is invalid.', false);
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new LlmProviderError('INVALID_REQUEST', 'Demo provider category is invalid.', false);
  }
  return value;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
}

function splitSentences(value: string): string[] {
  return (value.match(/[^.!?]+[.!?]?/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClassificationCategory(
  value: unknown,
): value is TicketClassificationCategory {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.description === undefined || typeof value.description === 'string')
  );
}
