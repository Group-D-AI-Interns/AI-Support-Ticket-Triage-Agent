import { randomUUID } from 'node:crypto';

import {
  AiOutputValidationError,
  type AiTask,
  type AiTaskExecution,
} from './contracts.js';
import type { AiExecutionLogger } from './ports.js';
import {
  LlmProviderError,
  type StructuredGenerationProvider,
  type StructuredGenerationResponse,
} from '../../infrastructure/llm/structured-generation-provider.js';

export type AiExecutionOptions = {
  model: string;
  timeoutMs: number;
  maxRetries: number;
};

export class AiExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly executionId: string,
    readonly task: AiTask,
  ) {
    super(message);
    this.name = 'AiExecutionError';
  }
}

export class AiExecutionRunner {
  constructor(
    private readonly provider: StructuredGenerationProvider,
    private readonly logger: AiExecutionLogger,
    private readonly options: AiExecutionOptions,
  ) {
    if (!options.model.trim()) {
      throw new Error('An AI model identifier is required.');
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new Error('AI timeoutMs must be a positive integer.');
    }
    if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
      throw new Error('AI maxRetries must be a non-negative integer.');
    }
  }

  async execute<T>(
    task: AiTask,
    instructions: string,
    input: unknown,
    validate: (output: unknown) => T,
  ): Promise<{ result: T; execution: AiTaskExecution }> {
    const executionId = `exec_${randomUUID()}`;
    const startedAt = new Date();
    const startTime = Date.now();
    let response: StructuredGenerationResponse | undefined;
    let attempts = 0;

    while (attempts <= this.options.maxRetries) {
      attempts += 1;
      try {
        response = await this.generateWithTimeout({
          executionId,
          task,
          model: this.options.model,
          instructions,
          input,
        });
        break;
      } catch (error) {
        const providerError = normalizeProviderError(error);
        const isRetryable = error instanceof LlmProviderError && error.retryable;
        if (isRetryable && attempts <= this.options.maxRetries) {
          continue;
        }

        const durationMs = Date.now() - startTime;
        await this.logger.record({
          executionId,
          task,
          status: 'failed',
          provider: null,
          model: this.options.model,
          attempts,
          durationMs,
          errorCode: providerError.code,
        });
        throw new AiExecutionError(
          providerError.code,
          providerError.message,
          executionId,
          task,
        );
      }
    }

    if (
      !response
      || typeof response.provider !== 'string'
      || !response.provider.trim()
      || typeof response.model !== 'string'
      || !response.model.trim()
    ) {
      const durationMs = Date.now() - startTime;
      await this.logger.record({
        executionId,
        task,
        status: 'failed',
        provider: response?.provider ?? null,
        model: response?.model ?? this.options.model,
        attempts,
        durationMs,
        errorCode: 'INVALID_PROVIDER_RESPONSE',
      });
      throw new AiExecutionError(
        'INVALID_PROVIDER_RESPONSE',
        'The AI provider returned invalid execution metadata.',
        executionId,
        task,
      );
    }

    let result: T;
    try {
      result = validate(response.output);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      await this.logger.record({
        executionId,
        task,
        status: 'failed',
        provider: response.provider,
        model: response.model,
        attempts,
        durationMs,
        errorCode: 'INVALID_OUTPUT',
      });
      throw new AiExecutionError(
        'INVALID_OUTPUT',
        error instanceof AiOutputValidationError
          ? error.message
          : 'The AI provider output failed validation.',
        executionId,
        task,
      );
    }

    const completedAt = new Date();
    const durationMs = Date.now() - startTime;
    const execution: AiTaskExecution = {
      executionId,
      task,
      status: 'completed',
      provider: response.provider,
      model: response.model,
      attempts,
      durationMs,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    };

    await this.logger.record({
      executionId,
      task,
      status: 'completed',
      provider: response.provider,
      model: response.model,
      attempts,
      durationMs,
    });

    return { result, execution };
  }

  private async generateWithTimeout(
    request: Omit<Parameters<StructuredGenerationProvider['generateStructured']>[0], 'signal'>,
  ): Promise<StructuredGenerationResponse> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const generation = this.provider.generateStructured({
      ...request,
      signal: controller.signal,
    });
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new LlmProviderError('TIMEOUT', 'AI generation timed out.', true));
      }, this.options.timeoutMs);
    });

    try {
      return await Promise.race([generation, timedOut]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}

function normalizeProviderError(error: unknown): { code: string; message: string } {
  if (error instanceof LlmProviderError) {
    const code = /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'PROVIDER_FAILURE';
    const message = code === 'TIMEOUT'
      ? 'AI generation timed out.'
      : 'AI provider request failed.';
    return { code, message };
  }
  return {
    code: 'PROVIDER_FAILURE',
    message: 'AI generation failed.',
  };
}
