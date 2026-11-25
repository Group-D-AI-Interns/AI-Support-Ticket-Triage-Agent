import type { AnalysisOrchestration } from './ticket-analysis.graph.js';

export type AiTask = 'ticket_classification' | 'ticket_summarization' | 'ticket_priority_factors' | 'ticket_resolution' | 'document_rule_extraction';

export type TicketAiView = {
  id: string;
  organisationId: string;
  title: string;
  description: string;
};

export type TicketClassificationCategory = {
  id: string;
  name: string;
  description?: string;
};

export type TicketClassification = {
  categories: string[];
  reason: string;
  confidence: number | null;
  evidence: TicketClassificationEvidence[];
  requiresHumanReview: boolean;
  warnings: string[];
};

export type TicketClassificationEvidence = {
  categoryId: string;
  field: 'title' | 'description';
  start: number;
  end: number;
  excerpt: string;
};

export type TicketSummary = {
  summary: string;
  symptoms: string[];
  attemptedActions: string[];
  affectedFunctionality: string | null;
  businessImpact: string | null;
  missingInformation: string[];
  warnings: string[];
};

export type AiTaskExecution = {
  validationRetryOf?: string;
  executionId: string;
  task: AiTask;
  status: 'completed';
  provider: string;
  model: string;
  attempts: number;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  /** Provider-reported counts only; absent when the provider does not expose usage. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
};

export type TicketAiAnalysis = {
  id: string;
  ticketId: string;
  organisationId: string;
  status: 'completed';
  classification: TicketClassification;
  summary: TicketSummary;
  executions: AiTaskExecution[];
  createdAt: string;
  orchestration?: AnalysisOrchestration;
};

export class AiOutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiOutputValidationError';
  }
}

export function validateTicketClassification(
  value: unknown,
  categories: TicketClassificationCategory[],
): TicketClassification {
  const record = requireExactKeys(value, [
    'categories',
    'reason',
    'confidence',
    'evidence',
    'requiresHumanReview',
    'warnings',
  ], 'Classification');

  const selected = record.categories;
  if (!Array.isArray(selected) || selected.some(id => typeof id !== 'string') || new Set(selected).size !== selected.length) {
    throw new AiOutputValidationError('Classification categories must be an array of unique configured IDs.');
  }
  if (selected.some(id => !categories.some(candidate => candidate.id === id))) {
    throw new AiOutputValidationError('Classification category is not configured.');
  }

  const confidence = record.confidence;
  if (
    confidence !== null
    && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    throw new AiOutputValidationError('Classification confidence must be null or between 0 and 1.');
  }

  const requiresHumanReview = requireBoolean(record.requiresHumanReview, 'requiresHumanReview');
  if ((selected.length === 0 || confidence === null) && !requiresHumanReview) {
    throw new AiOutputValidationError(
      'An uncertain classification without confidence must require human review.',
    );
  }

  return {
    categories: [...selected] as string[],
    reason: requireNonEmptyString(record.reason, 'Classification reason'),
    confidence,
    evidence: validateClassificationEvidence(record.evidence, categories, selected as string[]),
    requiresHumanReview,
    warnings: requireStringArray(record.warnings, 'Classification warnings'),
  };
}

function validateClassificationEvidence(value: unknown, categories: TicketClassificationCategory[], selected: string[]): TicketClassificationEvidence[] {
  if (!Array.isArray(value)) throw new AiOutputValidationError('Classification evidence must be an array.');
  return value.map(entry => {
    if (!isRecord(entry) || Object.keys(entry).length !== 5 || !['categoryId', 'field', 'start', 'end', 'excerpt'].every(key => key in entry)) {
      throw new AiOutputValidationError('Classification evidence does not match the required schema.');
    }
    if (typeof entry.categoryId !== 'string' || !categories.some(category => category.id === entry.categoryId) || !selected.includes(entry.categoryId) ||
      (entry.field !== 'title' && entry.field !== 'description') || !Number.isInteger(entry.start) || !Number.isInteger(entry.end) ||
      (entry.start as number) < 0 || (entry.end as number) <= (entry.start as number) || typeof entry.excerpt !== 'string' || !entry.excerpt.trim()) {
      throw new AiOutputValidationError('Classification evidence is invalid.');
    }
    return { categoryId: entry.categoryId as string, field: entry.field, start: entry.start as number, end: entry.end as number, excerpt: (entry.excerpt as string).trim() };
  });
}

export function validateClassificationEvidenceAgainstTicket(classification: TicketClassification, ticket: Pick<TicketAiView, 'title' | 'description'>): void {
  if (classification.warnings.includes('LEGACY_CLASSIFICATION_EVIDENCE_UNAVAILABLE')) return;
  for (const item of classification.evidence) {
    const source = ticket[item.field];
    if (item.end > source.length || source.slice(item.start, item.end) !== item.excerpt) {
      throw new AiOutputValidationError('Classification evidence does not match the ticket source.');
    }
  }
  if (classification.categories.some(categoryId => !classification.evidence.some(item => item.categoryId === categoryId))) {
    throw new AiOutputValidationError('Each classified category must include source evidence.');
  }
}

/** Read-only migration for persisted single-label analyses; never used for provider output. */
export function normalizeStoredTicketClassification(value: unknown): TicketClassification {
  if (isRecord(value) && Array.isArray(value.categories)) {
    const ids = value.categories.filter((id): id is string => typeof id === 'string');
    return validateTicketClassification(value, ids.map(id => ({ id, name: id })));
  }
  if (!isRecord(value) || Object.keys(value).length !== 5 || !['category', 'reason', 'confidence', 'requiresHumanReview', 'warnings'].every(key => key in value) ||
    (value.category !== null && typeof value.category !== 'string') || typeof value.requiresHumanReview !== 'boolean') {
    throw new AiOutputValidationError('Stored classification does not match a supported schema.');
  }
  const id = value.category as string | null;
  const warnings = requireStringArray(value.warnings, 'Classification warnings');
  const legacy = validateTicketClassification({ categories: id ? [id] : [], reason: value.reason, confidence: value.confidence,
    evidence: [], requiresHumanReview: true, warnings: [...warnings, 'LEGACY_CLASSIFICATION_EVIDENCE_UNAVAILABLE'] }, id ? [{ id, name: id }] : []);
  return legacy;
}

export function validateTicketSummary(value: unknown): TicketSummary {
  const record = requireExactKeys(value, [
    'summary',
    'symptoms',
    'attemptedActions',
    'affectedFunctionality',
    'businessImpact',
    'missingInformation',
    'warnings',
  ], 'Summary');

  const businessImpact = record.businessImpact;
  if (businessImpact !== null && typeof businessImpact !== 'string') {
    throw new AiOutputValidationError('Business impact must be a string or null.');
  }
  const affectedFunctionality = record.affectedFunctionality;
  if (affectedFunctionality !== null && typeof affectedFunctionality !== 'string') {
    throw new AiOutputValidationError('Affected functionality must be a string or null.');
  }

  return {
    summary: requireNonEmptyString(record.summary, 'Summary'),
    symptoms: requireStringArray(record.symptoms, 'Symptoms'),
    attemptedActions: requireStringArray(record.attemptedActions, 'Attempted actions'),
    affectedFunctionality: affectedFunctionality === null
      ? null
      : requireNonEmptyString(affectedFunctionality, 'Affected functionality'),
    businessImpact: businessImpact === null
      ? null
      : requireNonEmptyString(businessImpact, 'Business impact'),
    missingInformation: requireStringArray(record.missingInformation, 'Missing information'),
    warnings: requireStringArray(record.warnings, 'Summary warnings'),
  };
}

/** Read-only migration for summaries persisted before affected functionality was added. */
export function normalizeStoredTicketSummary(value: unknown): TicketSummary {
  if (!isRecord(value)) throw new AiOutputValidationError('Stored summary does not match a supported schema.');
  if (Object.prototype.hasOwnProperty.call(value, 'affectedFunctionality')) {
    return validateTicketSummary(value);
  }
  const legacyKeys = ['summary', 'symptoms', 'attemptedActions', 'businessImpact', 'missingInformation', 'warnings'];
  if (Object.keys(value).length !== legacyKeys.length || !legacyKeys.every(key => key in value)) {
    throw new AiOutputValidationError('Stored summary does not match a supported schema.');
  }
  return validateTicketSummary({ ...value, affectedFunctionality: null });
}

function requireExactKeys(
  value: unknown,
  expectedKeys: string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AiOutputValidationError(`${label} output must be an object.`);
  }

  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new AiOutputValidationError(`${label} output does not match the required schema.`);
  }

  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AiOutputValidationError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AiOutputValidationError(`${label} must be a boolean.`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new AiOutputValidationError(`${label} must be an array of strings.`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
