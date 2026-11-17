import type { TenantContext } from '../../../shared/tenant.js';

export type ExtractionEvidence = {
  sourceType: 'document' | 'approved_policy' | 'knowledge_article' | 'historical_ticket';
  sourceId: string;
  versionId?: string;
  page?: number;
  section?: string;
  excerpt?: string;
  confidence?: number;
};

export type ValidatedExtractionOutput = {
  executionId: string;
  documentId: string;
  documentVersionId: string;
  ruleType: string;
  payload: Record<string, unknown>;
  evidence: ExtractionEvidence[];
  confidence: number;
  ambiguity: boolean;
  warnings: string[];
  requiresHumanReview: boolean;
};

export type ProvisionalExtractionInput = {
  tenant: TenantContext;
  documentId: string;
  documentVersionId: string;
  executionId: string;
  content: string;
  pageNumber?: number;
  section?: string;
};

export type ProvisionalExtractionResult = ValidatedExtractionOutput & {
  status: 'succeeded' | 'failed';
};

export function validateExtractionOutput(input: unknown): ValidatedExtractionOutput {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Extraction output must be an object.');
  }

  const value = input as Record<string, unknown>;

  const executionId = requireString(value.executionId, 'executionId');
  const documentId = requireString(value.documentId, 'documentId');
  const documentVersionId = requireString(value.documentVersionId, 'documentVersionId');
  const ruleType = requireString(value.ruleType, 'ruleType');

  const payload = value.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Extraction payload must be an object.');
  }

  const confidenceValue = value.confidence;
  if (typeof confidenceValue !== 'number' || !Number.isFinite(confidenceValue) || confidenceValue < 0 || confidenceValue > 1) {
    throw new Error('Extraction confidence must be a finite number between 0 and 1.');
  }

  const evidenceRaw = value.evidence;
  if (!Array.isArray(evidenceRaw)) {
    throw new Error('Extraction evidence must be an array.');
  }

  const evidence: ExtractionEvidence[] = evidenceRaw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Evidence item ${index} must be an object.`);
    }

    const evidenceItem = entry as Record<string, unknown>;
    const sourceType = requireString(evidenceItem.sourceType, `evidence[${index}].sourceType`);
    const sourceId = requireString(evidenceItem.sourceId, `evidence[${index}].sourceId`);

    return {
      sourceType: sourceType as ExtractionEvidence['sourceType'],
      sourceId,
      versionId: typeof evidenceItem.versionId === 'string' ? evidenceItem.versionId : undefined,
      page: typeof evidenceItem.page === 'number' ? evidenceItem.page : undefined,
      section: typeof evidenceItem.section === 'string' ? evidenceItem.section : undefined,
      excerpt: typeof evidenceItem.excerpt === 'string' ? evidenceItem.excerpt : undefined,
      confidence: typeof evidenceItem.confidence === 'number' ? evidenceItem.confidence : undefined,
    };
  });

  if (evidence.length === 0) {
    throw new Error('Extraction output requires at least one evidence reference.');
  }

  const warnings = Array.isArray(value.warnings) ? value.warnings.map((warning) => String(warning)) : [];
  const ambiguity = Boolean(value.ambiguity);
  const requiresHumanReview = ambiguity || confidenceValue < 0.7 || evidence.length === 0 || warnings.some((warning) => /low confidence|uncertain|ambig|review/i.test(warning));

  return {
    executionId,
    documentId,
    documentVersionId,
    ruleType,
    payload: payload as Record<string, unknown>,
    evidence,
    confidence: confidenceValue,
    ambiguity,
    warnings,
    requiresHumanReview,
  };
}

export interface ExtractionAdapter {
  extract(input: ProvisionalExtractionInput): Promise<ProvisionalExtractionResult>;
}

export class ProvisionalExtractionAdapter implements ExtractionAdapter {
  async extract(input: ProvisionalExtractionInput): Promise<ProvisionalExtractionResult> {
    const content = input.content?.trim() ?? '';
    const targetHours = parseResponseHours(content);

    const defaultNormalized = {
      executionId: input.executionId,
      documentId: input.documentId,
      documentVersionId: input.documentVersionId,
      ruleType: targetHours ? 'response_time' : 'manual_review_required',
      payload: targetHours ? { targetHours } : { rawText: content },
      evidence: [
        {
          sourceType: 'document' as const,
          sourceId: input.documentId,
          versionId: input.documentVersionId,
          page: input.pageNumber ?? 1,
          section: input.section ?? 'policy',
          excerpt: content || 'No excerpt provided.',
          confidence: targetHours ? 0.91 : 0.45,
        },
      ],
      confidence: targetHours ? 0.91 : 0.45,
      ambiguity: !targetHours,
      warnings: targetHours ? [] : ['No clear SLA target could be extracted; review required.'],
    };

    const validated = validateExtractionOutput(defaultNormalized);

    return {
      ...validated,
      status: 'succeeded',
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

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required and must be a non-empty string.`);
  }

  return value.trim();
}
