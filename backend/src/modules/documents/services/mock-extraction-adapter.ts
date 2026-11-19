import type {
  ExtractionAdapter,
  ExtractionAdapterInput,
  ExtractionAdapterResult,
} from './extraction-adapter.js';

export type MockExtractionAdapterOptions = {
  failOnce?: boolean;
};

export class MockExtractionAdapter implements ExtractionAdapter {
  private failedOnce = false;

  constructor(private readonly options: MockExtractionAdapterOptions = {}) {}

  async extract(input: ExtractionAdapterInput): Promise<ExtractionAdapterResult> {
    if (this.options.failOnce && !this.failedOnce) {
      this.failedOnce = true;
      throw new Error('Transient extraction failure');
    }

    const startedAt = new Date().toISOString();
    return {
      executionId: input.executionId,
      status: 'succeeded',
      rules: [
        {
          executionId: input.executionId,
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          ruleType: 'response_time',
          payload: { targetHours: 2 },
          evidence: [{
            sourceType: 'document',
            sourceId: input.documentId,
            versionId: input.documentVersionId,
            excerpt: input.content,
            confidence: 0.93,
          }],
          confidence: 0.93,
          ambiguity: false,
          warnings: [],
          requiresHumanReview: false,
        },
      ],
      warnings: [],
      executionMetadata: {
        provider: 'test-mock',
        model: 'mock-extraction-v1',
        startedAt,
        durationMs: 0,
      },
    };
  }
}
