import type { ApiEnvelope, ApiFailure, Department, Organisation, PageResult, RoleCapability, Team, TeamMembership, UserDetail, UserListItem } from "@/types/foundation";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string, readonly fields?: { field: string; message: string }[]) {
    super(message);
    this.name = "ApiError";
  }
}

let credential: { token: string; organisationId: string } | null = null;
let tokenProvider: (() => Promise<string>) | null = null;
export function configureApi(token: string, organisationId: string) { credential = { token, organisationId }; }
export function setApiTokenProvider(provider: (() => Promise<string>) | null) { tokenProvider = provider; }
export function clearApi() { credential = null; }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!credential?.token) throw new ApiError(401, "UNAUTHENTICATED", "Connect with a Keycloak access token to continue.");
  const headers = new Headers(init.headers);
  let token: string;
  try { token = tokenProvider ? await tokenProvider() : credential.token; }
  catch { throw new ApiError(401, "UNAUTHENTICATED", "Your sign-in session expired. Sign in again."); }
  headers.set("authorization", `Bearer ${token}`);
  if (credential.organisationId) headers.set("x-organisation-id", credential.organisationId);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`/api/backend${path}`, { ...init, headers, cache: "no-store" });
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new ApiError(response.status, "INVALID_RESPONSE", "The backend returned an unreadable response."); }
  if (!response.ok) {
    const failure = payload as ApiFailure;
    throw new ApiError(response.status, failure?.error?.code ?? "REQUEST_FAILED", failure?.error?.message ?? "The request failed.", failure?.error?.requestId, failure?.error?.fields);
  }
  return payload as T;
}

async function download(path: string): Promise<{ blob: Blob; fileName: string }> {
  if (!credential?.token) throw new ApiError(401, "UNAUTHENTICATED", "Connect with a Keycloak access token to continue.");
  let token: string;
  try { token = tokenProvider ? await tokenProvider() : credential.token; }
  catch { throw new ApiError(401, "UNAUTHENTICATED", "Your sign-in session expired. Sign in again."); }
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (credential.organisationId) headers.set("x-organisation-id", credential.organisationId);
  const response = await fetch(`/api/backend${path}`, { headers, cache: "no-store" });
  if (!response.ok) {
    let failure: ApiFailure | undefined;
    try { failure = await response.json() as ApiFailure; } catch { /* handled by the standard fallback below */ }
    throw new ApiError(response.status, failure?.error?.code ?? "REQUEST_FAILED", failure?.error?.message ?? "The download failed.", failure?.error?.requestId, failure?.error?.fields);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quotedName = disposition.match(/filename="([^"]*)"/i)?.[1];
  let fileName = "download";
  try { fileName = encodedName ? decodeURIComponent(encodedName) : quotedName ?? fileName; } catch { fileName = quotedName ?? fileName; }
  fileName = fileName.replace(/[\\/\r\n\0]/g, "_");
  return { blob: await response.blob(), fileName };
}

export const api = {
  tickets: (query: { q?: string; status?: string; priority?: string; teamId?: string; limit?: number; offset?: number } = {}) => { const params = new URLSearchParams(); params.set("limit", String(query.limit ?? 25)); params.set("offset", String(query.offset ?? 0)); for (const key of ["q", "status", "priority", "teamId"] as const) if (query[key]) params.set(key, query[key]!); return request<{ data: SupportTicket[]; pagination: { limit: number; offset: number; total: number }; requestId: string }>(`/api/v1/tickets?${params}`); },
  createTicket: (body: { title: string; description: string; product?: string; affectedService?: string; affectedUsers: AffectedUsers; businessImpact: BusinessImpact; urgency: TicketUrgency }) => request<ApiEnvelope<SupportTicket>>("/api/v1/tickets", { method: "POST", body: JSON.stringify(body) }),
  uploadAttachment: (id: string, file: File) => { const body = new FormData(); body.append("file", file); return request<ApiEnvelope<{ id: string; fileName: string; mimeType: string; fileSizeBytes: number }>>(`/api/v1/tickets/${encodeURIComponent(id)}/attachments`, { method: "POST", body }); },
  downloadAttachment: (ticketId: string, attachmentId: string) => download(`/api/v1/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`),
  ticket: (id: string) => request<ApiEnvelope<SupportTicket & { comments?: SupportComment[] }>>(`/api/v1/tickets/${encodeURIComponent(id)}`),
  updateTicket: (id: string, body: { title?: string; description?: string; product?: string | null; affectedService?: string | null; teamId?: string | null; priority?: string; priorityOverride?: { reason: string; businessJustification: string } }) => request<ApiEnvelope<SupportTicket>>(`/api/v1/tickets/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  workflowContext: (id: string) => request<ApiEnvelope<TicketWorkflowContext>>(`/api/v1/tickets/${encodeURIComponent(id)}/workflow-context`),
  updateTicketStatus: (id: string, body: { status: string; reason?: string; resolutionEvidence?: { outcome: "service_restored" | "agreed_solution"; note: string; customerConfirmation: "received" | "not_applicable"; customerConfirmationEvidence: string } }) => request<ApiEnvelope<SupportTicket>>(`/api/v1/tickets/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify(body) }),
  escalations: () => request<ApiEnvelope<EscalationQueueItem[]>>("/api/v1/ticket-escalations"),
  openEscalation: (ticketId: string, body: { reasonCode: TicketEscalation["reasonCode"]; handoverNotes: string }) => request<ApiEnvelope<TicketEscalation>>(`/api/v1/tickets/${encodeURIComponent(ticketId)}/escalations`, { method: "POST", body: JSON.stringify(body) }),
  resolveEscalation: (ticketId: string, escalationId: string, resolutionNotes: string) => request<ApiEnvelope<TicketEscalation>>(`/api/v1/tickets/${encodeURIComponent(ticketId)}/escalations/${encodeURIComponent(escalationId)}/resolve`, { method: "POST", body: JSON.stringify({ resolutionNotes }) }),
  comment: (id: string, body: string, visibility: "public" | "internal") => request<ApiEnvelope<SupportComment>>(`/api/v1/tickets/${encodeURIComponent(id)}/comments`, { method: "POST", body: JSON.stringify({ body, visibility }) }),
  ticketAudit: (id: string) => request<ApiEnvelope<TicketHistory[]>>(`/api/v1/tickets/${encodeURIComponent(id)}/audit`),
  auditLogs: (page = 1, pageSize = 50) => request<PageResult<AuditLogEntry>>(`/api/v1/audit-logs?page=${page}&pageSize=${pageSize}`),
  ticketAnalyses: (id: string) => request<ApiEnvelope<TicketAnalysis[]>>(`/api/v1/tickets/${encodeURIComponent(id)}/analyses`),
  recommendPriority: (id: string) => request<ApiEnvelope<Record<string, unknown>>>(`/api/v1/tickets/${encodeURIComponent(id)}/recommend-priority`, { method: "POST", body: "{}" }),
  triage: (id: string) => request<ApiEnvelope<Record<string, unknown>>>(`/api/v1/tickets/${encodeURIComponent(id)}/triage`, { method: "POST", body: "{}" }),
  analyze: (id: string) => request<ApiEnvelope<TicketAnalysis>>(`/api/v1/tickets/${encodeURIComponent(id)}/analyze`, { method: "POST", body: "{}" }),
  triages: (id: string) => request<ApiEnvelope<TriageReport[]>>(`/api/v1/tickets/${encodeURIComponent(id)}/triages`),
  reviewTriage: (ticketId: string, reportId: string, body: { decision: TriageReview["data"]["decision"]; reason: string; editedResolution?: ReviewedResolution }) => request<ApiEnvelope<TriageReview>>(`/api/v1/tickets/${encodeURIComponent(ticketId)}/triages/${encodeURIComponent(reportId)}/reviews`, { method: "POST", body: JSON.stringify(body) }),
  recommendResolution: (id: string, options: { regenerate?: boolean; reason?: string } = {}) => request<ApiEnvelope<Record<string, unknown>>>(`/api/v1/tickets/${encodeURIComponent(id)}/recommend-resolution`, { method: "POST", body: JSON.stringify(options) }),
  similar: (id: string) => request<ApiEnvelope<unknown>>(`/api/v1/tickets/${encodeURIComponent(id)}/similar`),
  operationalReport: (from: string, to: string) => request<ApiEnvelope<OperationalReport>>(`/api/v1/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  slaPolicies: () => request<ApiEnvelope<unknown[]>>("/api/v1/sla-policies"),
  documents: () => request<ApiEnvelope<TenantDocument[]>>("/api/v1/documents"),
  document: (id: string) => request<ApiEnvelope<{ document: TenantDocument; versions: TenantDocumentVersion[]; extraction: unknown }>>(`/api/v1/documents/${encodeURIComponent(id)}`),
  uploadDocument: (title: string, file: File) => { const body = new FormData(); body.append("title", title); body.append("file", file); return request<ApiEnvelope<{ document: TenantDocument; version: TenantDocumentVersion }>>("/api/v1/documents", { method: "POST", body }); },
  extractDocumentRules: (id: string, retry = false) => request<ApiEnvelope<{ job: Record<string, unknown>; rules: ExtractedRule[] }>>(`/api/v1/documents/${encodeURIComponent(id)}/extract-rules`, { method: "POST", body: JSON.stringify({ retry }) }),
  extractedRules: () => request<ApiEnvelope<ExtractedRule[]>>("/api/v1/extracted-rules"),
  approveExtractedRule: (id: string, reason: string) => request<ApiEnvelope<ExtractedRule>>(`/api/v1/extracted-rules/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({ reason }) }),
  rejectExtractedRule: (id: string, reason: string) => request<ApiEnvelope<ExtractedRule>>(`/api/v1/extracted-rules/${encodeURIComponent(id)}/reject`, { method: "POST", body: JSON.stringify({ reason }) }),
  publishDocumentKnowledge: (id: string, body: { ruleIds: string[]; reason: string; effectiveFrom: string; effectiveTo: string | null; visibility: "administrators" | "support_staff" }) => request<ApiEnvelope<Record<string, unknown>>>(`/api/v1/documents/${encodeURIComponent(id)}/publish-knowledge`, { method: "POST", body: JSON.stringify(body) }),
  createSlaPolicy: (body: { description: string; sourceDocumentId: string; sourceDocumentVersionId: string; effectiveFrom: string; effectiveTo: string | null; payload: Record<string, unknown> }) => request<ApiEnvelope<{ policy: SlaPolicyRecord; version: SlaPolicyVersion }>>("/api/v1/sla-policies", { method: "POST", body: JSON.stringify(body) }),
  approveSlaPolicy: (policyId: string, versionId: string, reason: string) => request<ApiEnvelope<{ version: SlaPolicyVersion }>>(`/api/v1/sla-policies/${encodeURIComponent(policyId)}/versions/${encodeURIComponent(versionId)}/approve`, { method: "POST", body: JSON.stringify({ reason }) }),
  activateSlaPolicy: (policyId: string, versionId: string) => request<ApiEnvelope<{ policy: SlaPolicyRecord; version: SlaPolicyVersion }>>(`/api/v1/sla-policies/${encodeURIComponent(policyId)}/versions/${encodeURIComponent(versionId)}/activate`, { method: "POST", body: "{}" }),
  categories: () => request<ApiEnvelope<CategoryConfiguration[]>>("/api/v1/configuration/categories"),
  priorityPolicies: () => request<ApiEnvelope<PriorityPolicyConfiguration[]>>("/api/v1/configuration/priority-rules"),
  createPriorityPolicy: (body: { matrix: PriorityMatrix; sourceDocumentId: string; sourceDocumentVersionId: string; reason: string }) => request<ApiEnvelope<PriorityPolicyConfiguration>>("/api/v1/configuration/priority-rules", { method: "POST", body: JSON.stringify(body) }),
  decidePriorityPolicy: (id: string, action: "approve" | "activate", reason: string) => request<ApiEnvelope<PriorityPolicyConfiguration>>(`/api/v1/configuration/priority-rules/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify({ reason }) }),
  createCategory: (body: { id: string; name: string; description?: string }) => request<ApiEnvelope<{ id: string; name: string; description?: string }>>("/api/v1/configuration/categories", { method: "POST", body: JSON.stringify(body) }),
  setCategoryStatus: (id: string, status: "enable" | "disable", reason: string) => request<ApiEnvelope<CategoryConfiguration>>(`/api/v1/configuration/categories/${encodeURIComponent(id)}/${status}`, { method: "POST", body: JSON.stringify({ reason }) }),
  routingRules: () => request<ApiEnvelope<RoutingRuleConfiguration[]>>("/api/v1/ai/routing-rules"),
  createRoutingRule: (body: { categoryIds: string[]; teamId: string; effectiveFrom: string; effectiveTo: string | null }) => request<ApiEnvelope<RoutingRuleConfiguration>>("/api/v1/ai/routing-rules", { method: "POST", body: JSON.stringify(body) }),
  decideRoutingRule: (id: string, action: "approve" | "disable", reason: string) => request<ApiEnvelope<RoutingRuleConfiguration>>(`/api/v1/ai/routing-rules/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify({ reason }) }),
  workflows: () => request<ApiEnvelope<Record<string, unknown>[]>>("/api/v1/ticket-workflows"),
  me: () => request<ApiEnvelope<import("@/types/foundation").CurrentUser>>("/api/v1/me"),
  organisations: () => request<PageResult<Organisation>>("/api/v1/organisations?page=1&pageSize=100"),
  organisation: (id: string) => request<ApiEnvelope<Organisation>>(`/api/v1/organisations/${encodeURIComponent(id)}`),
  createOrganisation: (name: string) => request<ApiEnvelope<Organisation>>("/api/v1/organisations", { method: "POST", body: JSON.stringify({ name }) }),
  updateOrganisation: (id: string, body: Partial<Pick<Organisation, "name" | "status" | "settings">>) => request<ApiEnvelope<Organisation>>(`/api/v1/organisations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  users: () => request<PageResult<UserListItem>>("/api/v1/users?page=1&pageSize=100"),
  user: (id: string) => request<ApiEnvelope<UserDetail>>(`/api/v1/users/${encodeURIComponent(id)}`),
  inviteUser: (body: { email: string; displayName: string; roles: string[] }) => request<ApiEnvelope<{ user: UserDetail; membership: unknown }>>("/api/v1/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: string, displayName: string) => request<ApiEnvelope<UserDetail>>(`/api/v1/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ displayName }) }),
  updateMembership: (id: string, body: { status: string; roles: string[] }) => request<ApiEnvelope<{ roles: string[] }>>(`/api/v1/users/${encodeURIComponent(id)}/memberships`, { method: "PUT", body: JSON.stringify(body) }),
  roles: () => request<ApiEnvelope<RoleCapability[]>>("/api/v1/roles"),
  departments: () => request<PageResult<Department>>("/api/v1/departments?page=1&pageSize=100"),
  createDepartment: (name: string) => request<ApiEnvelope<Department>>("/api/v1/departments", { method: "POST", body: JSON.stringify({ name }) }),
  teams: () => request<PageResult<Team>>("/api/v1/teams?page=1&pageSize=100"),
  createTeam: (name: string, departmentId: string | null) => request<ApiEnvelope<Team>>("/api/v1/teams", { method: "POST", body: JSON.stringify({ name, departmentId }) }),
  updateTeam: (id: string, body: { name?: string; departmentId?: string | null }) => request<ApiEnvelope<Team>>(`/api/v1/teams/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  teamMembers: (id: string) => request<PageResult<TeamMembership>>(`/api/v1/teams/${encodeURIComponent(id)}/members?page=1&pageSize=100`),
  setTeamMember: (id: string, body: { userId: string; role: TeamMembership["role"]; status: MembershipStatus }) => request<ApiEnvelope<TeamMembership>>(`/api/v1/teams/${encodeURIComponent(id)}/members`, { method: "PUT", body: JSON.stringify(body) }),
};

import type { MembershipStatus } from "@/types/foundation";

export type TicketEscalation = { id: string; status: "open" | "resolved"; reasonCode: "P1_CRITICAL" | "P2_HIGH" | "SLA_AT_RISK" | "BEYOND_AGENT_AUTHORITY" | "RECURRING_BREACH" | "OTHER"; handoverNotes: string; escalatedBy: string; escalatedAt: string; resolvedBy?: string; resolvedAt?: string; resolutionNotes?: string; automatic?: boolean };
export type AffectedUserScope = "one_user" | "small_group" | "multiple_users_one_department" | "multiple_departments" | "organisation_wide";
export type AffectedUsers = { scope: AffectedUserScope; count?: number };
export type BusinessImpact = "critical" | "high" | "medium" | "low";
export type TicketUrgency = "immediate" | "high" | "medium" | "low";
export type SupportTicket = { id: string; title: string; description?: unknown; product?: string | null; affectedService?: string | null; affectedUsers?: AffectedUsers; businessImpact?: BusinessImpact; urgency?: TicketUrgency; status?: string; priority?: string; teamId?: string | null; requesterId: string; createdAt: string; updatedAt: string; comments?: SupportComment[]; attachments?: { id: string; fileName: string; mimeType: string; fileSizeBytes: number; createdAt: string }[]; escalations?: TicketEscalation[] };
export type TicketWorkflowContext = { workflowId: string; currentStatus: string | null; transitions: string[]; resolvedStatuses: string[] };
export type EscalationQueueItem = { ticket: SupportTicket; escalation: TicketEscalation };
export type TenantDocument = { id: string; organisationId: string; title: string; fileName: string; mimeType: string; version: number; status: string; processingStatus: string; createdAt: string };
export type TenantDocumentVersion = { id: string; documentId: string; organisationId: string; version: number; fileName: string; mimeType: string; fileSizeBytes: number; checksumSha256: string; createdAt: string };
export type ExtractedRule = { id: string; organisationId: string; policyVersionId: string; documentId?: string; documentVersionId?: string; ruleType: string; payload: Record<string, unknown>; evidence: Array<Record<string, unknown>>; confidence: number | null; ambiguous: boolean; warnings?: string[]; reviewStatus?: "pending_review" | "approved" | "rejected" | "changes_requested"; reviewReason?: string };
export type SlaPolicyVersion = { id: string; policyId: string; version: number; status: string; effectiveFrom: string | null; effectiveTo: string | null; payload: Record<string, unknown>; sourceDocumentId?: string; sourceDocumentVersionId?: string };
export type SlaPolicyRecord = { id: string; policyType: string; description: string; status: string; versions: SlaPolicyVersion[] };
export type SupportComment = { id: string; authorId: string; body: string; visibility: "public" | "internal"; createdAt: string };
export type TicketHistory = { id: string; action: string; actorId: string; createdAt: string; changes: Record<string, unknown> };
export type AuditLogEntry = { id: string; actorId: string; action: string; targetType: string; targetId: string; createdAt: string; source: string; details: Record<string, unknown> };
export type CategoryConfiguration = { id: string; name: string; description?: string; status: "active" | "disabled"; source: "organisation" | "environment_default" };
export type RoutingRuleConfiguration = { id: string; data: { categoryIds: string[]; teamId: string; effectiveFrom: string; effectiveTo?: string | null; status: "draft" | "approved" | "disabled"; reason?: string }; createdAt: string; updatedAt: string };
export type PriorityMatrix = Record<"critical" | "high" | "medium" | "low", Record<"immediate" | "high" | "medium" | "low", "P1" | "P2" | "P3" | "P4">>;
export type LegacyPriorityMatrix = Record<"high" | "medium" | "low", Record<"high" | "medium" | "low", "P1" | "P2" | "P3" | "P4">>;
export type PriorityPolicyConfiguration = { id: string; data: { version: number; status: "draft" | "approved" | "active" | "archived"; matrix: PriorityMatrix | LegacyPriorityMatrix; sourceDocumentId: string; sourceDocumentVersionId: string; sourceChecksumSha256: string; reason: string; approvalReason?: string; activationReason?: string } };
export type TicketAnalysis = { id: string; ticketId: string; classification: { category: string | null; reason: string; confidence: number | null; requiresHumanReview: boolean; warnings: string[] }; summary: { summary: string; symptoms: string[]; attemptedActions: string[]; affectedFunctionality?: string | null; businessImpact: string | null; missingInformation: string[]; warnings: string[] }; createdAt: string };
export type OperationalReport = { period: { from: string; to: string }; ticketVolume: number; ticketsByStatus: Record<string, number>; ticketsByPriority: Record<string, number>; slaByState: Record<string, number>; ticketsWithoutEvaluation: number };
export type ReviewedResolution = { summary: string; steps: { instruction: string; citations: { passageId: string; excerpt: string }[] }[]; missingInformation: string[]; warnings: string[] };
export type TriageReview = { id: string; actorId: string; createdAt: string; data: { decision: "accepted" | "rejected" | "needs_information"; reason: string; resolutionRevision?: { before: ReviewedResolution; after: ReviewedResolution } } };
export type TriageReport = { id: string; data: { ticketId: string; result: unknown }; reviews: TriageReview[]; redacted: boolean; staleTicketSnapshot: boolean };
