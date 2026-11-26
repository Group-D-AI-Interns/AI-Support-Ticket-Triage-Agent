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
  outputValidationRetries?: 0 | 1;
};

export class AiExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly executionId: string,
    readonly task: AiTask,
    readonly attempts = 1,
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
    if (options.outputValidationRetries !== undefined && ![0, 1].includes(options.outputValidationRetries)) throw new Error('outputValidationRetries must be 0 or 1.');
  }

  /** Non-secret inputs that determine which provider/model configuration produced cached guidance. */
  cacheIdentity(): { providerAdapter: string; model: string } {
    const provider = this.provider as StructuredGenerationProvider & { cacheIdentity?: () => string; options?: { name?: string; baseUrl?: string } };
    return { providerAdapter: provider.cacheIdentity?.() ?? `${this.provider.constructor.name}:${provider.options?.name ?? 'unknown'}:${provider.options?.baseUrl ?? 'configured'}`, model: this.options.model };
  }

  generationLeaseMs(): number {
    const validationPasses = this.options.outputValidationRetries === 1 ? 2 : 1;
    return Math.max(10 * 60_000, this.options.timeoutMs * validationPasses + 60_000);
  }

  async execute<T>(
    task: AiTask,
    instructions: string,
    input: unknown,
    validate: (output: unknown) => T,
  ): Promise<{ result: T; execution: AiTaskExecution }> {
    const startedAt = new Date();
    try { return await this.executeOnce(task, instructions, input, validate); }
    catch (error) {
      const eligible = task === 'ticket_classification' || task === 'ticket_summarization';
      if (!eligible || this.options.outputValidationRetries !== 1 || !(error instanceof AiExecutionError) || error.code !== 'INVALID_OUTPUT') throw error;
      // Regenerate from original trusted instructions/data. Never feed rejected model text back as instructions.
      const retry = await this.executeOnce(task, instructions, input, validate);
      return { ...retry, execution: { ...retry.execution, attempts: retry.execution.attempts + error.attempts,
        startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), validationRetryOf: error.executionId } };
    }
  }

  private async executeOnce<T>(task: AiTask, instructions: string, input: unknown,
    validate: (output: unknown) => T): Promise<{ result: T; execution: AiTaskExecution }> {
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
        attempts = Math.max(attempts, response.attempts ?? attempts);
        break;
      } catch (error) {
        const providerError = normalizeProviderError(error);
        if (error instanceof LlmProviderError) {
          attempts = Math.max(attempts, error.attempts);
        }
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
          attempts,
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
        attempts,
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
        attempts,
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
      ...(validUsage(response.usage) ? { usage: validUsage(response.usage)! } : {}),
    };

    await this.logger.record({
      executionId,
      task,
      status: 'completed',
      provider: response.provider,
      model: response.model,
      attempts,
      durationMs,
      ...(execution.usage ? { usage: execution.usage } : {}),
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

function validUsage(value: StructuredGenerationResponse['usage']): StructuredGenerationResponse['usage'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([key, count]) => !['promptTokens', 'completionTokens', 'totalTokens'].includes(key) || !Number.isSafeInteger(count) || (count as number) < 0)) return undefined;
  return entries.length ? structuredClone(value) : undefined;
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
