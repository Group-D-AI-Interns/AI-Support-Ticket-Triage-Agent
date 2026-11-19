import type { AiTask } from '../../modules/ai/contracts.js';
import {
  LlmProviderError,
  type StructuredGenerationProvider,
  type StructuredGenerationRequest,
  type StructuredGenerationResponse,
} from './structured-generation-provider.js';

export type FakeResponseHandler = (input: unknown) => unknown | Promise<unknown>;

export class DeterministicFakeProvider implements StructuredGenerationProvider {
  constructor(
    private readonly handlers: Partial<Record<AiTask, FakeResponseHandler>>,
    private readonly providerName = 'deterministic-fake',
  ) {}

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResponse> {
    if (request.signal.aborted) {
      throw new LlmProviderError('REQUEST_ABORTED', 'Generation was cancelled.', false);
    }

    const handler = this.handlers[request.task];
    if (!handler) {
      throw new LlmProviderError(
        'TASK_NOT_CONFIGURED',
        `No fake response handler is configured for ${request.task}.`,
        false,
      );
    }

    return {
      provider: this.providerName,
      model: request.model,
      output: await handler(request.input),
    };
  }
}
