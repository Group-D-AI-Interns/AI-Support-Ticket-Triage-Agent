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

export type DocumentTextSegment = {
  text: string;
  page?: number;
  section?: string;
};

export type ExtractionAdapterInput = {
  tenant: TenantContext;
  documentId: string;
  documentVersionId: string;
  executionId: string;
  content: string;
  segments?: DocumentTextSegment[];
};

export type ExtractionExecutionMetadata = {
  provider: string;
  model: string;
  startedAt: string;
  durationMs: number;
};

export type ExtractionAdapterFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

type ExtractionAdapterResultBase = {
  executionId: string;
  rules: ValidatedExtractionOutput[];
  warnings: string[];
  executionMetadata: ExtractionExecutionMetadata;
};

export type ExtractionAdapterResult = ExtractionAdapterResultBase & (
  | { status: 'succeeded'; failure?: never }
  | { status: 'failed'; failure: ExtractionAdapterFailure }
);

export interface ExtractionAdapter {
  extract(input: ExtractionAdapterInput): Promise<ExtractionAdapterResult>;
}

export function validateExtractionOutput(input: unknown): ValidatedExtractionOutput {
  if (!isRecord(input)) {
    throw new TypeError('Extraction rule must be an object.');
  }

  const executionId = requireString(input.executionId, 'executionId');
  const documentId = requireString(input.documentId, 'documentId');
  const documentVersionId = requireString(input.documentVersionId, 'documentVersionId');
  const ruleType = requireString(input.ruleType, 'ruleType');

  if (!isRecord(input.payload) || !isJsonValue(input.payload)) {
    throw new Error('Extraction payload must be a JSON object.');
  }
  if (
    typeof input.confidence !== 'number'
    || !Number.isFinite(input.confidence)
    || input.confidence < 0
    || input.confidence > 1
  ) {
    throw new Error('Extraction confidence must be a finite number between 0 and 1.');
  }
  if (typeof input.ambiguity !== 'boolean') {
    throw new Error('Extraction ambiguity must be a boolean.');
  }
  if (typeof input.requiresHumanReview !== 'boolean') {
    throw new Error('Extraction requiresHumanReview must be a boolean.');
  }
  const warnings = requireStringArray(input.warnings, 'Extraction warnings');
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    throw new Error('Extraction output requires at least one evidence reference.');
  }

  const evidence = input.evidence.map((entry, index) => validateEvidence(entry, index));
  const requiresHumanReview = input.requiresHumanReview
    || input.ambiguity
    || input.confidence < 0.7
    || warnings.some((warning) => /low confidence|uncertain|ambig|review/i.test(warning));

  return {
    executionId,
    documentId,
    documentVersionId,
    ruleType,
    payload: input.payload,
    evidence,
    confidence: input.confidence,
    ambiguity: input.ambiguity,
    warnings,
    requiresHumanReview,
  };
}

export function validateExtractionAdapterResult(input: unknown): ExtractionAdapterResult {
  if (!isRecord(input)) {
    throw new TypeError('Extraction result must be an object.');
  }

  const executionId = requireString(input.executionId, 'executionId');
  if (input.status !== 'succeeded' && input.status !== 'failed') {
    throw new Error('Extraction status must be succeeded or failed.');
  }
  if (!Array.isArray(input.rules)) {
    throw new Error('Extraction rules must be an array.');
  }
  const rules = input.rules.map(validateExtractionOutput);
  if (rules.some((rule) => rule.executionId !== executionId)) {
    throw new Error('Extraction rule execution IDs must match the result.');
  }
  const warnings = requireStringArray(input.warnings, 'Extraction warnings');
  const executionMetadata = validateExecutionMetadata(input.executionMetadata);
  if (input.status === 'failed') {
    const failure = validateFailure(input.failure);
    if (rules.length > 0) {
      throw new Error('Failed extraction results cannot contain candidate rules.');
    }
    return { executionId, status: 'failed', rules, warnings, executionMetadata, failure };
  }
  if (input.failure !== undefined) {
    throw new Error('Succeeded extraction results cannot contain a failure.');
  }

  return { executionId, status: 'succeeded', rules, warnings, executionMetadata };
}

function validateEvidence(input: unknown, index: number): ExtractionEvidence {
  if (!isRecord(input)) {
    throw new Error(`Evidence item ${index} must be an object.`);
  }
  const sourceType = input.sourceType;
  if (
    sourceType !== 'document'
    && sourceType !== 'approved_policy'
    && sourceType !== 'knowledge_article'
    && sourceType !== 'historical_ticket'
  ) {
    throw new Error(`Evidence item ${index} has an unsupported sourceType.`);
  }
  const evidence: ExtractionEvidence = {
    sourceType,
    sourceId: requireString(input.sourceId, `evidence[${index}].sourceId`),
  };
  if (input.versionId !== undefined) {
    evidence.versionId = requireString(input.versionId, `evidence[${index}].versionId`);
  }
  if (input.page !== undefined) {
    if (!Number.isInteger(input.page) || (input.page as number) < 1) {
      throw new Error(`Evidence item ${index} page must be a positive integer.`);
    }
    evidence.page = input.page as number;
  }
  if (input.section !== undefined) {
    evidence.section = requireString(input.section, `evidence[${index}].section`);
  }
  if (input.excerpt !== undefined) {
    if (typeof input.excerpt !== 'string') {
      throw new Error(`Evidence item ${index} excerpt must be a string.`);
    }
    evidence.excerpt = input.excerpt;
  }
  if (input.confidence !== undefined) {
    if (
      typeof input.confidence !== 'number'
      || !Number.isFinite(input.confidence)
      || input.confidence < 0
      || input.confidence > 1
    ) {
      throw new Error(`Evidence item ${index} confidence must be between 0 and 1.`);
    }
    evidence.confidence = input.confidence;
  }
  return evidence;
}

function validateExecutionMetadata(input: unknown): ExtractionExecutionMetadata {
  if (!isRecord(input)) {
    throw new Error('Extraction execution metadata must be an object.');
  }
  const provider = requireString(input.provider, 'executionMetadata.provider');
  const model = requireString(input.model, 'executionMetadata.model');
  const startedAt = requireString(input.startedAt, 'executionMetadata.startedAt');
  if (Number.isNaN(Date.parse(startedAt))) {
    throw new Error('Extraction execution startedAt must be a valid timestamp.');
  }
  if (
    typeof input.durationMs !== 'number'
    || !Number.isFinite(input.durationMs)
    || input.durationMs < 0
  ) {
    throw new Error('Extraction execution durationMs must be a non-negative number.');
  }
  return { provider, model, startedAt, durationMs: input.durationMs };
}

function validateFailure(input: unknown): ExtractionAdapterFailure {
  if (!isRecord(input) || typeof input.retryable !== 'boolean') {
    throw new Error('Failed extraction results require a retryable failure description.');
  }
  return {
    code: requireString(input.code, 'failure.code'),
    message: requireString(input.message, 'failure.message'),
    retryable: input.retryable,
  };
}

function requireStringArray(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return input;
}

function requireString(input: unknown, field: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${field} is required and must be a non-empty string.`);
  }
  return input.trim();
}

function isJsonValue(input: unknown): boolean {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') {
    return true;
  }
  if (typeof input === 'number') {
    return Number.isFinite(input);
  }
  if (Array.isArray(input)) {
    return input.every(isJsonValue);
  }
  if (isRecord(input)) {
    return Object.values(input).every(isJsonValue);
  }
  return false;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
