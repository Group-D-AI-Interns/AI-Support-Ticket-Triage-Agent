import {
  validateExtractionOutput,
  type ExtractionAdapter,
  type ExtractionAdapterInput,
  type ExtractionAdapterResult,
} from './extraction-adapter.js';

export class ProvisionalExtractionAdapter implements ExtractionAdapter {
  async extract(input: ExtractionAdapterInput): Promise<ExtractionAdapterResult> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const content = input.content?.trim() ?? '';
    const targetHours = parseResponseHours(content);
    const warnings = targetHours === null
      ? ['No clear SLA target could be extracted; review required.']
      : [];
    const rule = validateExtractionOutput({
      executionId: input.executionId,
      documentId: input.documentId,
      documentVersionId: input.documentVersionId,
      ruleType: targetHours !== null ? 'response_time' : 'manual_review_required',
      payload: targetHours !== null ? { targetHours } : { rawText: content },
      evidence: [{
        sourceType: 'document',
        sourceId: input.documentId,
        versionId: input.documentVersionId,
        excerpt: content,
        confidence: targetHours !== null ? 0.91 : 0.45,
      }],
      confidence: targetHours !== null ? 0.91 : 0.45,
      ambiguity: targetHours === null,
      warnings,
      requiresHumanReview: targetHours === null,
    });

    return {
      executionId: input.executionId,
      status: 'succeeded',
      rules: [rule],
      warnings,
      executionMetadata: {
        provider: 'local-provisional',
        model: 'response-hours-regex-v1',
        startedAt,
        durationMs: Date.now() - started,
      },
    };
  }
}

function parseResponseHours(content: string): number | null {
  const match = /within\s+(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+hours?/i.exec(content);
  if (!match) {
    return null;
  }

  const rawValue = match[1].toLowerCase();
  const wordMap: Record<string, number> = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  };

  return Number.isNaN(Number(rawValue)) ? (wordMap[rawValue] ?? null) : Number(rawValue);
}
