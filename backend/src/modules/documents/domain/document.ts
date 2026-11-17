export type DocumentStatus =
  | 'draft'
  | 'uploaded'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'archived';

export type DocumentProcessingStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed';

export type DocumentRecord = {
  id: string;
  organisationId: string;
  title: string;
  status: DocumentStatus;
  fileName: string;
  mimeType: string;
  storageKey: string;
  checksumSha256: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  fileSizeBytes: number;
  provider: 'private-storage';
  processingStatus: DocumentProcessingStatus;
};

export type DocumentVersionRecord = {
  id: string;
  documentId: string;
  organisationId: string;
  version: number;
  checksumSha256: string;
  fileName: string;
  mimeType: string;
  storageKey: string;
  fileSizeBytes: number;
  createdAt: string;
  createdBy: string;
};
