import type { TenantContext } from '../../../shared/tenant.js';

export type MockExtractionAdapterOptions = {
  failOnce?: boolean;
};

export interface ExtractionAdapterInput {
  tenant: TenantContext;
  documentId: string;
  documentVersionId: string;
  executionId: string;
}

export interface ExtractionAdapterResult {
  executionId: string;
  status: 'succeeded' | 'failed';
  rules: Array<Record<string, unknown>>;
  warnings: string[];
}

export interface ExtractionAdapter {
  extract(input: ExtractionAdapterInput): Promise<ExtractionAdapterResult>;
}

export class MockExtractionAdapter implements ExtractionAdapter {
  private failedOnce = false;

  constructor(private readonly options: MockExtractionAdapterOptions = {}) {}

  async extract(input: ExtractionAdapterInput): Promise<ExtractionAdapterResult> {
    if (this.options.failOnce && !this.failedOnce) {
      this.failedOnce = true;
      throw new Error('Transient extraction failure');
    }

    return {
      executionId: input.executionId,
      status: 'succeeded',
      rules: [
        {
          ruleType: 'response_time',
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          confidence: 0.93,
        },
      ],
      warnings: [],
    };
  }
}
