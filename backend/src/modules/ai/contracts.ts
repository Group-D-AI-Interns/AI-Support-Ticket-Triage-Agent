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
  category: string | null;
  reason: string;
  confidence: number | null;
  requiresHumanReview: boolean;
  warnings: string[];
};

export type TicketSummary = {
  summary: string;
  symptoms: string[];
  attemptedActions: string[];
  businessImpact: string | null;
  missingInformation: string[];
  warnings: string[];
};

export type AiTaskExecution = {
  executionId: string;
  task: AiTask;
  status: 'completed';
  provider: string;
  model: string;
  attempts: number;
  durationMs: number;
  startedAt: string;
  completedAt: string;
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
    'category',
    'reason',
    'confidence',
    'requiresHumanReview',
    'warnings',
  ], 'Classification');

  const category = record.category;
  if (category !== null && typeof category !== 'string') {
    throw new AiOutputValidationError('Classification category must be a string or null.');
  }
  if (
    typeof category === 'string'
    && !categories.some((candidate) => candidate.id === category)
  ) {
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
  if ((category === null || confidence === null) && !requiresHumanReview) {
    throw new AiOutputValidationError(
      'An uncertain classification without confidence must require human review.',
    );
  }

  return {
    category,
    reason: requireNonEmptyString(record.reason, 'Classification reason'),
    confidence,
    requiresHumanReview,
    warnings: requireStringArray(record.warnings, 'Classification warnings'),
  };
}

export function validateTicketSummary(value: unknown): TicketSummary {
  const record = requireExactKeys(value, [
    'summary',
    'symptoms',
    'attemptedActions',
    'businessImpact',
    'missingInformation',
    'warnings',
  ], 'Summary');

  const businessImpact = record.businessImpact;
  if (businessImpact !== null && typeof businessImpact !== 'string') {
    throw new AiOutputValidationError('Business impact must be a string or null.');
  }

  return {
    summary: requireNonEmptyString(record.summary, 'Summary'),
    symptoms: requireStringArray(record.symptoms, 'Symptoms'),
    attemptedActions: requireStringArray(record.attemptedActions, 'Attempted actions'),
    businessImpact: businessImpact === null
      ? null
      : requireNonEmptyString(businessImpact, 'Business impact'),
    missingInformation: requireStringArray(record.missingInformation, 'Missing information'),
    warnings: requireStringArray(record.warnings, 'Summary warnings'),
  };
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
