import type {
  StructuredGenerationProvider,
  StructuredGenerationRequest,
  StructuredGenerationResponse,
} from './structured-generation-provider.js';
import { LlmProviderError } from './structured-generation-provider.js';

export type InceptionFallbackOptions = {
  inception: StructuredGenerationProvider;
  inceptionModel: string;
  groq: StructuredGenerationProvider;
  groqModel: string;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
};

export class InceptionFallbackProvider implements StructuredGenerationProvider {
  constructor(private readonly options: InceptionFallbackOptions) {
    if (!options.inceptionModel.trim() || !options.groqModel.trim()) {
      throw new Error('Both Inception and Groq model IDs are required for fallback.');
    }
    if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
      throw new Error('Inception maxRetries must be a non-negative integer.');
    }
    if (
      !Number.isInteger(options.backoffBaseMs) ||
      !Number.isInteger(options.backoffMaxMs) ||
      options.backoffBaseMs < 0 ||
      options.backoffMaxMs < options.backoffBaseMs
    ) {
      throw new Error('Inception backoff limits are invalid.');
    }
  }

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResponse> {
    let inceptionAttempts = 0;
    let lastError: unknown;

    while (inceptionAttempts <= this.options.maxRetries) {
      if (request.signal.aborted) {
        throw new LlmProviderError(
          'REQUEST_ABORTED',
          'Generation was cancelled.',
          false,
          inceptionAttempts,
        );
      }

      inceptionAttempts += 1;
      try {
        const response = await this.options.inception.generateStructured({
          ...request,
          model: this.options.inceptionModel,
        });
        return {
          ...response,
          attempts: inceptionAttempts,
        };
      } catch (error) {
        lastError = error;
        if (!(error instanceof LlmProviderError)) {
          lastError = new LlmProviderError(
            'PROVIDER_FAILURE',
            'The Inception provider request failed.',
            false,
          );
        }
        if (
          !(lastError instanceof LlmProviderError) ||
          !lastError.retryable ||
          inceptionAttempts > this.options.maxRetries
        ) {
          break;
        }

        const backoffMs = Math.min(
          this.options.backoffBaseMs * 2 ** (inceptionAttempts - 1),
          this.options.backoffMaxMs,
        );
        await delayWithSignal(backoffMs, request.signal);
      }
    }

    if (request.signal.aborted) {
      throw new LlmProviderError(
        'REQUEST_ABORTED',
        'Generation was cancelled.',
        false,
        inceptionAttempts,
      );
    }

    try {
      const fallbackResponse = await this.options.groq.generateStructured({
        ...request,
        model: this.options.groqModel,
      });
      return {
        ...fallbackResponse,
        attempts: inceptionAttempts + (fallbackResponse.attempts ?? 1),
      };
    } catch (error) {
      const fallbackError = error instanceof LlmProviderError
        ? error
        : new LlmProviderError(
            'PROVIDER_FAILURE',
            'The Groq fallback request failed.',
            false,
          );
      const primaryError = lastError instanceof LlmProviderError ? lastError : null;
      throw new LlmProviderError(
        fallbackError.code,
        'The primary LLM and Groq fallback both failed.',
        fallbackError.retryable,
        inceptionAttempts + fallbackError.attempts,
        primaryError?.code,
      );
    }
  }
}

function delayWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new LlmProviderError('REQUEST_ABORTED', 'Generation was cancelled.', false));
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      reject(new LlmProviderError('REQUEST_ABORTED', 'Generation was cancelled.', false));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
