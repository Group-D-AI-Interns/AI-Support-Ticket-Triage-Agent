import type { ExtractionExecutionMetadata } from '../services/extraction-adapter.js';

export type ExtractionJobStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'retrying';

export type ExtractionJobRecord = {
  id: string;
  organisationId: string;
  policyId: string;
  policyVersionId: string;
  documentId: string;
  documentVersionId: string;
  status: ExtractionJobStatus;
  attempts: number;
  maxAttempts: number;
  correlationId: string;
  executionId: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string | undefined;
  completedAt?: string | undefined;
  lastError?: string | undefined;
  warnings?: string[] | undefined;
  executionMetadata?: ExtractionExecutionMetadata | undefined;
};
