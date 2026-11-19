import { InceptionFallbackProvider } from '../../infrastructure/llm/inception-fallback-provider.js';
import { OpenAiCompatibleProvider } from '../../infrastructure/llm/openai-compatible-provider.js';
import type { StructuredGenerationProvider } from '../../infrastructure/llm/structured-generation-provider.js';
import {
  AiExecutionRunner,
  type AiExecutionOptions,
} from './ai-execution-runner.js';
import type {
  AiAnalysisRepository,
  AiExecutionLogEvent,
  AiExecutionLogger,
  AuthorizedTicketAnalysisSource,
} from './ports.js';
import type { TicketClassificationCategory } from './contracts.js';
import {
  InMemoryAiAnalysisRepository,
} from './local-demo-runtime.js';
import { TicketClassifier } from './components/ticket-classifier.js';
import { TicketSummarizer } from './components/ticket-summarizer.js';
import { TicketAiAnalysisService } from './ticket-ai-analysis.service.js';
import { ticketAiCategoriesFromEnvironment } from './local-demo-runtime.js';

export type LlmProviderName = 'groq' | 'inception';

export type LiveTicketAiConfiguration = {
  categories: TicketClassificationCategory[];
  classificationProvider: LlmProviderName;
  summarizationProvider: LlmProviderName;
  groqModel: string;
  groqMaxTokens: number;
  inceptionModel: string;
  inceptionMaxRetries: number;
  inceptionBackoffBaseMs: number;
  inceptionBackoffMaxMs: number;
  timeoutMs: number;
};

export class LiveTicketAiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveTicketAiConfigurationError';
  }
}

export function liveTicketAiConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): LiveTicketAiConfiguration | null {
  const enabled = environment.TICKET_AI_LIVE_ENABLED;
  if (enabled === undefined || enabled === 'false') {
    return null;
  }
  if (enabled !== 'true') {
    throw new LiveTicketAiConfigurationError(
      'TICKET_AI_LIVE_ENABLED must be either true or false.',
    );
  }
  if (environment.APP_ENV !== 'development') {
    throw new LiveTicketAiConfigurationError(
      'Live ticket AI is permitted only when APP_ENV=development.',
    );
  }

  const classificationProvider = parseProvider(
    environment.TICKET_AI_CLASSIFICATION_PROVIDER,
    'TICKET_AI_CLASSIFICATION_PROVIDER',
  );
  const summarizationProvider = parseProvider(
    environment.TICKET_AI_SUMMARIZATION_PROVIDER,
    'TICKET_AI_SUMMARIZATION_PROVIDER',
  );
  const groqApiKey = environment.GROQ_API_KEY;
  const inceptionApiKey = environment.INCEPTION_API_KEY;
  if (!groqApiKey?.trim()) {
    throw new LiveTicketAiConfigurationError(
      'GROQ_API_KEY is required because Groq is the configured fallback provider.',
    );
  }
  if (
    (classificationProvider === 'inception' || summarizationProvider === 'inception') &&
    !inceptionApiKey?.trim()
  ) {
    throw new LiveTicketAiConfigurationError(
      'INCEPTION_API_KEY is required when Inception is selected for an AI task.',
    );
  }

  return {
    categories: ticketAiCategoriesFromEnvironment(environment),
    classificationProvider,
    summarizationProvider,
    groqModel: requiredValue(environment.GROQ_MODEL, 'GROQ_MODEL'),
    groqMaxTokens: parseInteger(environment.GROQ_MAX_TOKENS, 'GROQ_MAX_TOKENS', 1),
    inceptionModel: requiredValue(environment.INCEPTION_MODEL, 'INCEPTION_MODEL'),
    inceptionMaxRetries: parseInteger(
      environment.INCEPTION_MAX_RETRIES,
      'INCEPTION_MAX_RETRIES',
      0,
    ),
    inceptionBackoffBaseMs:
      parseInteger(environment.INCEPTION_BACKOFF_BASE_SECONDS, 'INCEPTION_BACKOFF_BASE_SECONDS', 0) *
      1_000,
    inceptionBackoffMaxMs:
      parseInteger(environment.INCEPTION_BACKOFF_MAX_SECONDS, 'INCEPTION_BACKOFF_MAX_SECONDS', 0) *
      1_000,
    timeoutMs: parseInteger(environment.LLM_CALL_TIMEOUT_SECONDS, 'LLM_CALL_TIMEOUT_SECONDS', 1) *
      1_000,
  };
}

export function createLiveTicketAiRuntime(
  source: AuthorizedTicketAnalysisSource,
  configuration: LiveTicketAiConfiguration,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher?: typeof fetch,
  repository: AiAnalysisRepository = new InMemoryAiAnalysisRepository(),
): {
  priorityRunner: AiExecutionRunner;
  service: TicketAiAnalysisService;
  repository: AiAnalysisRepository;
} {
  const groq = new OpenAiCompatibleProvider({
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: requiredValue(environment.GROQ_API_KEY, 'GROQ_API_KEY'),
    timeoutMs: configuration.timeoutMs,
    maxTokens: configuration.groqMaxTokens,
    ...(fetcher === undefined ? {} : { fetcher }),
  });
  const inception = configuration.classificationProvider === 'inception' ||
    configuration.summarizationProvider === 'inception'
    ? new OpenAiCompatibleProvider({
        name: 'inception',
        baseUrl: requiredValue(
          environment.INCEPTION_BASE_URL,
          'INCEPTION_BASE_URL',
        ),
        apiKey: requiredValue(environment.INCEPTION_API_KEY, 'INCEPTION_API_KEY'),
        timeoutMs: configuration.timeoutMs,
        ...(fetcher === undefined ? {} : { fetcher }),
      })
    : null;
  const classificationProvider = providerForTask(
    configuration.classificationProvider,
    configuration,
    groq,
    inception,
  );
  const summarizationProvider = providerForTask(
    configuration.summarizationProvider,
    configuration,
    groq,
    inception,
  );
  const logger = new ConsoleAiExecutionLogger();
  const classificationRunner = createRunner(
    classificationProvider.provider,
    logger,
    configuration,
    classificationProvider.model,
    configuration.classificationProvider === 'inception',
  );
  const summarizationRunner = createRunner(
    summarizationProvider.provider,
    logger,
    configuration,
    summarizationProvider.model,
    configuration.summarizationProvider === 'inception',
  );

  return {
    priorityRunner: classificationRunner,
    service: new TicketAiAnalysisService(
      source,
      new TicketClassifier(classificationRunner),
      new TicketSummarizer(summarizationRunner),
      repository,
    ),
    repository,
  };
}

function providerForTask(
  primaryName: LlmProviderName,
  configuration: LiveTicketAiConfiguration,
  groq: OpenAiCompatibleProvider,
  inception: OpenAiCompatibleProvider | null,
): { provider: StructuredGenerationProvider; model: string } {
  if (primaryName === 'groq') {
    return { provider: groq, model: configuration.groqModel };
  }
  if (!inception) {
    throw new LiveTicketAiConfigurationError(
      'An Inception provider is required for the selected AI task.',
    );
  }
  return {
    provider: new InceptionFallbackProvider({
      inception,
      inceptionModel: configuration.inceptionModel,
      groq,
      groqModel: configuration.groqModel,
      maxRetries: configuration.inceptionMaxRetries,
      backoffBaseMs: configuration.inceptionBackoffBaseMs,
      backoffMaxMs: configuration.inceptionBackoffMaxMs,
    }),
    model: configuration.inceptionModel,
  };
}

function createRunner(
  provider: StructuredGenerationProvider,
  logger: AiExecutionLogger,
  configuration: LiveTicketAiConfiguration,
  model: string,
  usesInceptionPrimary: boolean,
): AiExecutionRunner {
  const options: AiExecutionOptions = {
    model,
    timeoutMs: usesInceptionPrimary
      ? maximumInceptionExecutionMs(configuration)
      : configuration.timeoutMs,
    maxRetries: 0,
  };
  return new AiExecutionRunner(provider, logger, options);
}

function maximumInceptionExecutionMs(
  configuration: LiveTicketAiConfiguration,
): number {
  const inceptionAttempts = configuration.inceptionMaxRetries + 1;
  const backoffMs = Array.from({ length: configuration.inceptionMaxRetries }, (_, index) =>
    Math.min(
      configuration.inceptionBackoffBaseMs * 2 ** index,
      configuration.inceptionBackoffMaxMs,
    ),
  ).reduce((total, delay) => total + delay, 0);
  return configuration.timeoutMs * (inceptionAttempts + 1) + backoffMs;
}

function parseProvider(value: string | undefined, variable: string): LlmProviderName {
  if (value === 'groq' || value === 'inception') {
    return value;
  }
  throw new LiveTicketAiConfigurationError(
    `${variable} must be either "groq" or "inception".`,
  );
}

function requiredValue(value: string | undefined, variable: string): string {
  if (!value?.trim()) {
    throw new LiveTicketAiConfigurationError(`${variable} is required.`);
  }
  return value.trim();
}

function parseInteger(value: string | undefined, variable: string, minimum: number): number {
  if (!value?.trim() || !/^\d+$/.test(value)) {
    throw new LiveTicketAiConfigurationError(`${variable} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new LiveTicketAiConfigurationError(
      `${variable} must be an integer greater than or equal to ${minimum}.`,
    );
  }
  return parsed;
}

class ConsoleAiExecutionLogger implements AiExecutionLogger {
  async record(event: AiExecutionLogEvent): Promise<void> {
    console.info('Ticket AI execution', JSON.stringify(event));
  }
}
