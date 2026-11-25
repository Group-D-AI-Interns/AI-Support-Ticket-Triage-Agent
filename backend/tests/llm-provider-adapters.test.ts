import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EmbeddingProviderError,
  MistralEmbeddingProvider,
} from '../src/infrastructure/embeddings/mistral-embedding-provider.js';
import { InceptionFallbackProvider } from '../src/infrastructure/llm/inception-fallback-provider.js';
import { OpenAiCompatibleProvider } from '../src/infrastructure/llm/openai-compatible-provider.js';
import {
  LlmProviderError,
  type StructuredGenerationProvider,
  type StructuredGenerationRequest,
  type StructuredGenerationResponse,
} from '../src/infrastructure/llm/structured-generation-provider.js';
import {
  createLiveTicketAiRuntime,
  liveTicketAiConfigurationFromEnvironment,
} from '../src/modules/ai/live-ticket-ai-runtime.js';

const request: StructuredGenerationRequest = {
  executionId: 'exec_test',
  task: 'ticket_classification',
  model: 'test-model',
  instructions: 'Classify only from the provided information.',
  input: { ticket: { title: 'Unable to sign in' } },
  signal: new AbortController().signal,
};

test('OpenAI-compatible LLM adapter sends structured JSON request and parses its result', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const provider = new OpenAiCompatibleProvider({
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1/',
    apiKey: 'test-groq-key',
    timeoutMs: 1_000,
    maxTokens: 321,
    fetcher: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
      });
    },
  });

  const result = await provider.generateStructured({ ...request, model: 'configured-groq-model' });
  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(capturedUrl, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(new Headers(capturedInit?.headers).get('authorization'), 'Bearer test-groq-key');
  assert.equal(body.model, 'configured-groq-model');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_tokens, 321);
  assert.equal(result.provider, 'groq');
  assert.deepEqual(result.output, { ok: true });
  assert.deepEqual(result.usage, { promptTokens: 17, completionTokens: 5, totalTokens: 22 });
});

test('LLM adapter ignores missing or malformed provider token counts', async () => {
  const provider = new OpenAiCompatibleProvider({ name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'test-key', timeoutMs: 1000,
    fetcher: async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: -1, completion_tokens: 'unknown' } }) });
  const result = await provider.generateStructured(request);
  assert.equal(result.usage, undefined);
});

test('LLM adapter normalizes provider errors without exposing response content', async () => {
  const rejected = new OpenAiCompatibleProvider({
    name: 'inception',
    baseUrl: 'https://api.inceptionlabs.ai/v1',
    apiKey: 'test-inception-key',
    timeoutMs: 1_000,
    fetcher: async () => new Response('private response body', { status: 503 }),
  });

  await assert.rejects(
    rejected.generateStructured(request),
    (error: unknown) =>
      error instanceof LlmProviderError &&
      error.code === 'PROVIDER_UNAVAILABLE' &&
      error.retryable &&
      !error.message.includes('private response body'),
  );

  const malformed = new OpenAiCompatibleProvider({
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'test-groq-key',
    timeoutMs: 1_000,
    fetcher: async () =>
      Response.json({ choices: [{ message: { content: 'not json' } }] }),
  });
  await assert.rejects(
    malformed.generateStructured(request),
    (error: unknown) =>
      error instanceof LlmProviderError &&
      error.code === 'MALFORMED_JSON' &&
      !error.retryable,
  );
});

test('Inception retries transient failures and falls back to Groq with the selected model', async () => {
  let inceptionCalls = 0;
  let groqCalls = 0;
  const inception: StructuredGenerationProvider = {
    async generateStructured(call): Promise<StructuredGenerationResponse> {
      inceptionCalls += 1;
      assert.equal(call.model, 'configured-inception-model');
      throw new LlmProviderError('TEMPORARY', 'Temporary failure.', true);
    },
  };
  const groq: StructuredGenerationProvider = {
    async generateStructured(call): Promise<StructuredGenerationResponse> {
      groqCalls += 1;
      assert.equal(call.model, 'configured-groq-model');
      return { provider: 'groq', model: call.model, output: { recovered: true } };
    },
  };
  const provider = new InceptionFallbackProvider({
    inception,
    inceptionModel: 'configured-inception-model',
    groq,
    groqModel: 'configured-groq-model',
    maxRetries: 2,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
  });

  const result = await provider.generateStructured(request);
  assert.equal(inceptionCalls, 3);
  assert.equal(groqCalls, 1);
  assert.equal(result.provider, 'groq');
  assert.equal(result.attempts, 4);
  assert.deepEqual(result.output, { recovered: true });
});

test('Inception timeout is retried and then falls back to Groq', async () => {
  let groqCalls = 0;
  const inception = new OpenAiCompatibleProvider({
    name: 'inception',
    baseUrl: 'https://api.inceptionlabs.ai/v1',
    apiKey: 'test-inception-key',
    timeoutMs: 5,
    fetcher: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          reject(new Error('Missing abort signal.'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      }),
  });
  const fallback: StructuredGenerationProvider = {
    async generateStructured(call): Promise<StructuredGenerationResponse> {
      groqCalls += 1;
      return { provider: 'groq', model: call.model, output: { recovered: true } };
    },
  };
  const provider = new InceptionFallbackProvider({
    inception,
    inceptionModel: 'inception-model',
    groq: fallback,
    groqModel: 'groq-model',
    maxRetries: 1,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
  });
  const result = await provider.generateStructured(request);
  assert.equal(result.provider, 'groq');
  assert.equal(result.attempts, 3);
  assert.equal(groqCalls, 1);
});

test('Inception immediately fails over on a non-retryable error and reports combined failures safely', async () => {
  let groqCalls = 0;
  const provider = new InceptionFallbackProvider({
    inception: {
      async generateStructured(): Promise<StructuredGenerationResponse> {
        throw new LlmProviderError('PROVIDER_REJECTED', 'secret provider details', false);
      },
    },
    inceptionModel: 'inception-model',
    groq: {
      async generateStructured(): Promise<StructuredGenerationResponse> {
        groqCalls += 1;
        throw new LlmProviderError('RATE_LIMITED', 'secret fallback details', true);
      },
    },
    groqModel: 'groq-model',
    maxRetries: 2,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
  });

  await assert.rejects(
    provider.generateStructured(request),
    (error: unknown) =>
      error instanceof LlmProviderError &&
      error.code === 'RATE_LIMITED' &&
      error.attempts === 2 &&
      error.primaryErrorCode === 'PROVIDER_REJECTED' &&
      !error.message.includes('secret'),
  );
  assert.equal(groqCalls, 1);
});

test('Mistral embedding adapter validates and preserves response order', async () => {
  let capturedUrl = '';
  const provider = new MistralEmbeddingProvider({
    apiKey: 'test-mistral-key',
    model: 'mistral-embed',
    fetcher: async (input, init) => {
      capturedUrl = String(input);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-mistral-key');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'mistral-embed');
      assert.deepEqual(body.input, ['first text', 'second text']);
      return Response.json({
        data: [
          { index: 1, embedding: [0.2, 0.3] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
      });
    },
  });
  assert.deepEqual(
    await provider.embed(['first text', 'second text']),
    [[0.1, 0.2], [0.2, 0.3]],
  );
  assert.equal(capturedUrl, 'https://api.mistral.ai/v1/embeddings');

  const invalid = new MistralEmbeddingProvider({
    apiKey: 'test-mistral-key',
    model: 'mistral-embed',
    fetcher: async () => Response.json({ data: [{ index: 0, embedding: [Number.NaN] }] }),
  });
  await assert.rejects(
    invalid.embed(['text']),
    (error: unknown) =>
      error instanceof EmbeddingProviderError &&
      error.code === 'INVALID_PROVIDER_RESPONSE',
  );
});

test('live configuration requires explicit development opt-in, providers and credentials; tenant categories may be configured at runtime', () => {
  const baseEnvironment = {
    APP_ENV: 'development',
    TICKET_AI_LIVE_ENABLED: 'true',
    TICKET_AI_CATEGORIES: '[{"id":"ACCOUNT_ACCESS","name":"Account access"}]',
    TICKET_AI_CLASSIFICATION_PROVIDER: 'inception',
    TICKET_AI_SUMMARIZATION_PROVIDER: 'groq',
    GROQ_API_KEY: 'test-groq-key',
    INCEPTION_API_KEY: 'test-inception-key',
    GROQ_MODEL: 'groq-model',
    GROQ_MAX_TOKENS: '1024',
    INCEPTION_MODEL: 'inception-model',
    INCEPTION_MAX_RETRIES: '2',
    INCEPTION_BACKOFF_BASE_SECONDS: '1',
    INCEPTION_BACKOFF_MAX_SECONDS: '8',
    LLM_CALL_TIMEOUT_SECONDS: '20',
  };
  const configuration = liveTicketAiConfigurationFromEnvironment(baseEnvironment);
  assert.equal(configuration?.classificationProvider, 'inception');
  assert.equal(configuration?.summarizationProvider, 'groq');
  assert.equal(configuration?.timeoutMs, 20_000);
  assert.equal(configuration?.inceptionBackoffMaxMs, 8_000);
  assert.deepEqual(liveTicketAiConfigurationFromEnvironment({ ...baseEnvironment, TICKET_AI_CATEGORIES: undefined })?.categories, []);

  assert.throws(
    () =>
      liveTicketAiConfigurationFromEnvironment({
        ...baseEnvironment,
        APP_ENV: 'production',
      }),
    /only when APP_ENV=development/,
  );
  assert.throws(
    () =>
      liveTicketAiConfigurationFromEnvironment({
        ...baseEnvironment,
        INCEPTION_API_KEY: '',
      }),
    /INCEPTION_API_KEY is required/,
  );
});

test('live ticket orchestrator validates classification and summary after Inception-to-Groq failover', async () => {
  const environment = {
    APP_ENV: 'development',
    TICKET_AI_LIVE_ENABLED: 'true',
    TICKET_AI_CATEGORIES: '[{"id":"ACCOUNT_ACCESS","name":"Account access"}]',
    TICKET_AI_CLASSIFICATION_PROVIDER: 'inception',
    TICKET_AI_SUMMARIZATION_PROVIDER: 'inception',
    GROQ_API_KEY: 'test-groq-key',
    INCEPTION_API_KEY: 'test-inception-key',
    GROQ_MODEL: 'groq-model',
    GROQ_MAX_TOKENS: '1024',
    INCEPTION_BASE_URL: 'https://api.inceptionlabs.ai/v1',
    INCEPTION_MODEL: 'inception-model',
    INCEPTION_MAX_RETRIES: '0',
    INCEPTION_BACKOFF_BASE_SECONDS: '0',
    INCEPTION_BACKOFF_MAX_SECONDS: '0',
    LLM_CALL_TIMEOUT_SECONDS: '2',
  };
  const configuration = liveTicketAiConfigurationFromEnvironment(environment);
  assert.ok(configuration);
  const runtime = createLiveTicketAiRuntime(
    {
      async getAuthorizedTicket(tenant, ticketId) {
        return {
          id: ticketId,
          organisationId: tenant.organisationId,
          title: 'Unable to access my account',
          description: 'The account is locked after a password reset.',
        };
      },
    },
    configuration,
    environment,
    async (url, init) => {
      if (String(url).startsWith('https://api.inceptionlabs.ai')) {
        return new Response('unavailable', { status: 503 });
      }

      const requestBody = JSON.parse(String(init?.body));
      const systemMessage = requestBody.messages[0].content as string;
      const output = systemMessage.includes('Classify the ticket')
        ? {
            categories: ['ACCOUNT_ACCESS'],
            reason: 'The ticket describes an account lockout.',
            confidence: 0.8,
            evidence: [{ categoryId: 'ACCOUNT_ACCESS', field: 'title', start: 0, end: 27, excerpt: 'Unable to access my account' }],
            requiresHumanReview: false,
            warnings: [],
          }
        : {
            summary: 'The requester cannot access their account.',
            symptoms: ['Unable to access my account'],
            attemptedActions: ['Reset the password.'],
            affectedFunctionality: 'Account sign-in',
            businessImpact: null,
            missingInformation: [],
            warnings: [],
          };
      return Response.json({
        choices: [{ message: { content: JSON.stringify(output) } }],
      });
    },
  );
  const analysis = await runtime.service.analyze({
    tenant: {
      organisationId: 'org-demo',
      userId: 'user-demo',
      roles: ['support_agent'],
    },
    ticketId: 'ticket-demo',
    categories: configuration.categories,
  });

  assert.deepEqual(analysis.classification.categories, ['ACCOUNT_ACCESS']);
  assert.match(analysis.summary.summary, /cannot access/i);
  assert.deepEqual(
    analysis.executions.map((execution) => execution.provider),
    ['groq', 'groq'],
  );
  assert.deepEqual(
    analysis.executions.map((execution) => execution.attempts),
    [2, 2],
  );
});
