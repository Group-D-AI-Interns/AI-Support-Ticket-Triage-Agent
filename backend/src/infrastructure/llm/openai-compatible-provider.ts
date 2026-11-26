import type {
  StructuredGenerationProvider,
  StructuredGenerationRequest,
  StructuredGenerationResponse,
} from './structured-generation-provider.js';
import { LlmProviderError } from './structured-generation-provider.js';

export type OpenAiCompatibleProviderOptions = {
  name: 'groq' | 'inception';
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxTokens?: number;
  fetcher?: typeof fetch;
};

export class OpenAiCompatibleProvider implements StructuredGenerationProvider {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error(`${options.name.toUpperCase()}_API_KEY is required.`);
    }
    if (!isHttpUrl(options.baseUrl)) {
      throw new Error(`${options.name.toUpperCase()}_BASE_URL must be an HTTP(S) URL.`);
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new Error('timeoutMs must be a positive integer.');
    }
    if (
      options.maxTokens !== undefined &&
      (!Number.isInteger(options.maxTokens) || options.maxTokens < 1)
    ) {
      throw new Error('maxTokens must be a positive integer.');
    }
    this.fetcher = options.fetcher ?? fetch;
  }

  cacheIdentity(): string {
    const endpoint = new URL(this.options.baseUrl);
    return `${this.options.name}:${endpoint.origin}${endpoint.pathname}`;
  }

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResponse> {
    if (!request.model.trim()) {
      throw new LlmProviderError('MODEL_REQUIRED', 'An LLM model is required.', false);
    }
    if (request.signal.aborted) {
      throw new LlmProviderError('REQUEST_ABORTED', 'Generation was cancelled.', false);
    }

    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (request.signal.aborted) {
      throw new LlmProviderError('REQUEST_ABORTED', 'Generation was cancelled.', false);
    }
    request.signal.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    try {
      const response = await this.fetcher(`${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages: [
            {
              role: 'system',
              content: `${request.instructions}\nReturn a single JSON object and no markdown.`,
            },
            {
              role: 'user',
              content: JSON.stringify(request.input),
            },
          ],
          response_format: { type: 'json_object' },
          ...(this.options.maxTokens === undefined
            ? {}
            : { max_tokens: this.options.maxTokens }),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const code = response.status === 408
          ? 'TIMEOUT'
          : response.status === 429
            ? 'RATE_LIMITED'
            : response.status >= 500
              ? 'PROVIDER_UNAVAILABLE'
              : 'PROVIDER_REJECTED';
        throw new LlmProviderError(
          code,
          'The LLM provider rejected or failed the request.',
          retryable,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new LlmProviderError(
          'INVALID_PROVIDER_RESPONSE',
          'The LLM provider returned an invalid response.',
          false,
        );
      }

      const content = firstMessageContent(payload);
      if (!content) {
        throw new LlmProviderError(
          'INVALID_PROVIDER_RESPONSE',
          'The LLM provider returned no structured content.',
          false,
        );
      }

      let output: unknown;
      try {
        output = JSON.parse(content);
      } catch {
        throw new LlmProviderError(
          'MALFORMED_JSON',
          'The LLM provider returned malformed JSON.',
          false,
        );
      }
      const usage = providerUsage(payload);
      return {
        provider: this.options.name,
        model: request.model,
        output,
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      if (error instanceof LlmProviderError) {
        throw error;
      }
      if (request.signal.aborted) {
        throw new LlmProviderError('REQUEST_ABORTED', 'Generation was cancelled.', false);
      }
      if (timedOut || isAbortError(error)) {
        throw new LlmProviderError('TIMEOUT', 'The LLM request timed out.', true);
      }
      throw new LlmProviderError('NETWORK_ERROR', 'The LLM provider could not be reached.', true);
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', abortFromCaller);
    }
  }
}

function providerUsage(value: unknown): StructuredGenerationResponse['usage'] {
  if (!isRecord(value) || !isRecord(value.usage)) return undefined;
  const usage = value.usage;
  const result: NonNullable<StructuredGenerationResponse['usage']> = {};
  for (const [source, target] of [['prompt_tokens', 'promptTokens'], ['completion_tokens', 'completionTokens'], ['total_tokens', 'totalTokens']] as const) {
    const count = usage[source];
    if (Number.isSafeInteger(count) && (count as number) >= 0) result[target] = count as number;
  }
  return Object.keys(result).length ? result : undefined;
}

function firstMessageContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return null;
  }
  const firstChoice = value.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    return null;
  }
  return typeof firstChoice.message.content === 'string'
    ? firstChoice.message.content
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
