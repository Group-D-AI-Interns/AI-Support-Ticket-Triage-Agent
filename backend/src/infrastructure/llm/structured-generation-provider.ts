import type { AiTask } from '../../modules/ai/contracts.js';

export type StructuredGenerationRequest = {
  executionId: string;
  task: AiTask;
  model: string;
  instructions: string;
  input: unknown;
  signal: AbortSignal;
};

export type StructuredGenerationResponse = {
  provider: string;
  model: string;
  output: unknown;
  attempts?: number;
  /** Provider-reported counts only; omitted when the provider does not return them. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
};

export interface StructuredGenerationProvider {
  generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResponse>;
}

export class LlmProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly attempts = 1,
    readonly primaryErrorCode?: string,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}
