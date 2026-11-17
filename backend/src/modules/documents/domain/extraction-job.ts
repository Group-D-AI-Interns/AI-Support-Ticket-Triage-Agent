export type ExtractionJobStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'retrying';

export type ExtractionJobRecord = {
  id: string;
  organisationId: string;
  documentId: string;
  documentVersionId: string;
  status: ExtractionJobStatus;
  attempts: number;
  maxAttempts: number;
  correlationId: string;
  executionId: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
  lastError?: string;
};
