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

export type AffectedUserScope =
  | 'one_user'
  | 'small_group'
  | 'multiple_users_one_department'
  | 'multiple_departments'
  | 'organisation_wide';
export type BusinessImpact = 'critical' | 'high' | 'medium' | 'low';
export type TicketUrgency = 'immediate' | 'high' | 'medium' | 'low';
export type AffectedUsers = { scope: AffectedUserScope; count?: number };

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
  /** Optional on stored records for backwards compatibility with tickets created before these fields existed. */
  affectedUsers?: AffectedUsers;
  businessImpact?: BusinessImpact;
  urgency?: TicketUrgency;
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
