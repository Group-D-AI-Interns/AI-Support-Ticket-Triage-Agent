import type { TicketReopenRequest } from './ticket-workflow.js';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TicketSource = {
  system: 'jira';
  issueId: string;
  issueKey: string;
  projectKey: string;
  status?: string;
  priority?: string;
};

export type TicketComment = {
  id: string;
  authorId: string;
  body: string;
  visibility: 'internal' | 'public';
  createdAt: string;
};

export type TicketAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  storageKey: string;
  checksumSha256: string;
  fileSizeBytes: number;
  uploadedBy: string;
  createdAt: string;
};

export type TicketHistoryEvent = {
  id: string;
  action: string;
  actorId: string;
  createdAt: string;
  changes: Record<string, JsonValue>;
};

export type TicketEscalation = {
  id: string;
  status: 'open' | 'resolved';
  reasonCode: 'P1_CRITICAL' | 'P2_HIGH' | 'SLA_AT_RISK' | 'BEYOND_AGENT_AUTHORITY' | 'RECURRING_BREACH' | 'OTHER';
  handoverNotes: string;
  escalatedBy: string;
  escalatedAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNotes?: string;
  automatic?: boolean;
};

export type TicketRecord = {
  id: string;
  organisationId: string;
  requesterId: string;
  workflowId?: string;
  title: string;
  description?: JsonValue;
  product?: string | null;
  affectedService?: string | null;
  teamId?: string | null;
  status?: string;
  priority?: string;
  source?: TicketSource;
  createdAt: string;
  updatedAt: string;
  comments?: TicketComment[];
  attachments?: TicketAttachment[];
  escalations?: TicketEscalation[];
  reopenRequests?: TicketReopenRequest[];
  history?: TicketHistoryEvent[];
};
