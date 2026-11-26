import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod';
import type { TenantContext } from '../../shared/tenant.js';
import type { JsonValue, TicketRecord } from '../tickets/domain/ticket.js';
import type { AuthorizedKnowledgeSource, KnowledgeDocument } from '../knowledge/retrieval.js';
import type { AuthorizedRoutingSource } from './team-capability-ports.js';
import type { TicketAiView, TicketClassificationCategory } from './contracts.js';
import type { TicketAiTriageService } from './ticket-ai-triage.service.js';
import { ticketSnapshotHash } from './ticket-analysis.graph.js';
import { SLA_EVIDENCE_ACTIONS } from '../sla/domain/sla-evidence.js';
import { AiOperationsStore, priorityPolicyInput, routingInput, resolutionInput, reviewedResolutionSchema, reviewInput, type Operation, type OfKind } from './operations-store.js';
import { validateResolutionOutput } from './resolution-recommendation.service.js';

export class AiOperationsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const zCategoryInput = z.strictObject({ id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/), name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).optional() });
export function revision(ticket: TicketRecord) { return createHash('sha256').update(JSON.stringify(ticket)).digest('hex'); }
type Result = Awaited<ReturnType<TicketAiTriageService['analyze']>>;
export type AiOperationsDependencies = {
  ticket(tenant: TenantContext, id: string): Promise<TicketRecord | null>;
  project(ticket: TicketRecord): TicketAiView;
  teams(tenant: TenantContext): Promise<Array<{ id: string; organisationId: string; name: string }>>;
  can(tenant: TenantContext, permission: 'configuration.manage' | 'tickets.approve'): boolean;
  teamIds(tenant: TenantContext): string[];
  isResolved(tenant: TenantContext, ticket: TicketRecord): Promise<boolean>;
  categories(tenant: TenantContext): Promise<TicketClassificationCategory[]>;
  defaultCategories?: TicketClassificationCategory[];
  knowledge: AuthorizedKnowledgeSource;
  routing?: AuthorizedRoutingSource;
  triage(tenant: TenantContext, id: string): Promise<Result>;
  prioritySource?(tenant: TenantContext, documentId: string, versionId: string): Promise<{ sha256: string } | null>;
};
function row<K extends Operation['kind']>(kind: K, tenant: TenantContext, data: OfKind<K>['data'], id = `${kind}_${randomUUID()}`): OfKind<K> {
  const now = new Date().toISOString();
  return { id, kind, organisationId: tenant.organisationId, actorId: tenant.userId, createdAt: now, updatedAt: now, data } as OfKind<K>;
}
export class AiOperationsService implements AuthorizedRoutingSource, AuthorizedKnowledgeSource {
  constructor(readonly store: AiOperationsStore, readonly deps: AiOperationsDependencies) {}
  async ticket(tenant: TenantContext, id: string) {
    const ticket = await this.deps.ticket(tenant, id);
    if (!ticket || ticket.organisationId !== tenant.organisationId) throw new AiOperationsError(404, 'TICKET_NOT_FOUND', 'Ticket not found.');
    return ticket;
  }
  private require(tenant: TenantContext, permission: 'configuration.manage' | 'tickets.approve') {
    if (!this.deps.can(tenant, permission)) throw new AiOperationsError(403, 'FORBIDDEN', 'This action is not permitted.');
  }
  private audit(rows: Operation[], tenant: TenantContext, targetId: string, action: string, reason: string, details?: { before: unknown; after: unknown }) {
    const safeDetails = details ? JSON.parse(JSON.stringify(details)) as { before: JsonValue; after: JsonValue } : undefined;
    rows.push(row('audit', tenant, { targetId, action, reason, ...(safeDetails ? { details: safeDetails } : {}) }));
  }
  async categories(tenant: TenantContext): Promise<TicketClassificationCategory[]> {
    const records = await this.store.list(tenant.organisationId, 'category');
    const active = records.filter(record => record.data.status === 'active').map(record => ({ id: record.data.categoryId, name: record.data.name,
      ...(record.data.description ? { description: record.data.description } : {}) }));
    return active.length || records.length ? active : structuredClone(this.deps.defaultCategories ?? []);
  }
  async categoryConfiguration(tenant: TenantContext) {
    const records = await this.store.list(tenant.organisationId, 'category');
    if (!records.length) return structuredClone(this.deps.defaultCategories ?? []).map(category => ({ ...category, status: 'active' as const, source: 'environment_default' as const }));
    return records.map(record => ({ id: record.data.categoryId, name: record.data.name, ...(record.data.description ? { description: record.data.description } : {}), status: record.data.status, source: 'organisation' as const }));
  }
  async createCategory(tenant: TenantContext, input: unknown) {
    this.require(tenant, 'configuration.manage');
    const data = zCategoryInput.parse(input);
    const record = row('category', tenant, { categoryId: data.id, name: data.name, ...(data.description ? { description: data.description } : {}), status: 'active' });
    await this.store.changeForOrganisation(tenant.organisationId, rows => {
      if (rows.some(item => item.kind === 'category' && item.data.categoryId === data.id)) throw new AiOperationsError(409, 'CATEGORY_ALREADY_EXISTS', 'That category ID is already configured.');
      rows.push(record); this.audit(rows, tenant, record.id, 'category.created', 'Tenant ticket category created.');
    });
    return { id: data.id, name: data.name, ...(data.description ? { description: data.description } : {}) };
  }
  async setCategoryStatus(tenant: TenantContext, id: string, status: 'active' | 'disabled', reason: string) {
    this.require(tenant, 'configuration.manage');
    return this.store.changeForOrganisation(tenant.organisationId, rows => {
      const record = rows.find(item => item.kind === 'category' && item.organisationId === tenant.organisationId && item.data.categoryId === id) as OfKind<'category'> | undefined;
      if (!record) throw new AiOperationsError(404, 'CATEGORY_NOT_FOUND', 'Ticket category not found.');
      if (status === 'disabled' && record.data.status === 'active') {
        // Existing routing rules must be revised before disabling a category they reference.
        if (rows.some(item => item.kind === 'routing' && item.data.status === 'approved' && item.data.categoryIds.includes(id))) throw new AiOperationsError(409, 'CATEGORY_IN_USE', 'Disable approved routing rules that reference this category first.');
      }
      record.data.status = status; record.updatedAt = new Date().toISOString(); this.audit(rows, tenant, record.id, `category.${status}`, reason);
      return { id, name: record.data.name, ...(record.data.description ? { description: record.data.description } : {}), status };
    });
  }
  async createRouting(tenant: TenantContext, input: unknown) {
    this.require(tenant, 'configuration.manage');
    const data = routingInput.parse(input);
    await this.validateRouting(tenant, data);
    const record = row('routing', tenant, { ...data, status: 'draft' });
    await this.store.changeForOrganisation(tenant.organisationId, rows => { rows.push(record); this.audit(rows, tenant, record.id, 'routing.created', 'Draft rule created.'); });
    return record;
  }
  private async validateRouting(tenant: TenantContext, data: ReturnType<typeof routingInput.parse>) {
    const categories = await this.categories(tenant);
    if (!data.categoryIds.every(id => categories.some(category => category.id === id)) ||
      !(await this.deps.teams(tenant)).some(team => team.id === data.teamId && team.organisationId === tenant.organisationId) ||
      (data.effectiveTo && Date.parse(data.effectiveTo) <= Date.parse(data.effectiveFrom))) {
      throw new AiOperationsError(400, 'INVALID_ROUTING_RULE', 'Use configured categories, a tenant team and a valid effective window.');
    }
  }
  async decideRouting(tenant: TenantContext, id: string, action: 'approve' | 'disable', reason: string) {
    this.require(tenant, 'configuration.manage');
    const rule = (await this.store.list(tenant.organisationId, 'routing')).find(item => item.id === id);
    if (!rule) throw new AiOperationsError(404, 'NOT_FOUND', 'Routing rule not found.');
    if (action === 'approve') await this.validateRouting(tenant, rule.data);
    return this.store.changeForOrganisation(tenant.organisationId, rows => {
      const current = rows.find(item => item.id === id && item.kind === 'routing' && item.organisationId === tenant.organisationId) as OfKind<'routing'>;
      if (action === 'approve' && current.data.status !== 'draft') throw new AiOperationsError(409, 'RULE_IMMUTABLE', 'Create a new draft version instead.');
      current.data = { ...current.data, status: action === 'approve' ? 'approved' : 'disabled',
        ...(action === 'approve' ? { approvedBy: tenant.userId } : {}), reason };
      current.updatedAt = new Date().toISOString();
      this.audit(rows, tenant, id, `routing.${action}`, reason);
      return current;
    });
  }
  async priorityPolicies(tenant: TenantContext) {
    return (await this.store.list(tenant.organisationId, 'priority_policy')).sort((a, b) => b.data.version - a.data.version);
  }
  async activePriorityPolicy(tenant: TenantContext) {
    const policy = (await this.priorityPolicies(tenant)).find(item => item.data.status === 'active');
    if (!policy || !this.deps.prioritySource) return null;
    const source = await this.deps.prioritySource(tenant, policy.data.sourceDocumentId, policy.data.sourceDocumentVersionId);
    return source?.sha256 === policy.data.sourceChecksumSha256 ? policy : null;
  }
  async createPriorityPolicy(tenant: TenantContext, input: unknown) {
    this.require(tenant, 'configuration.manage');
    const data = priorityPolicyInput.parse(input);
    if (!this.deps.prioritySource) throw new AiOperationsError(503, 'PRIORITY_SOURCE_UNAVAILABLE', 'Verified document sources are unavailable.');
    const source = await this.deps.prioritySource(tenant, data.sourceDocumentId, data.sourceDocumentVersionId);
    if (!source) throw new AiOperationsError(422, 'PRIORITY_SOURCE_NOT_READY', 'Choose a processed document version belonging to this organisation.');
    const record = await this.store.changeForOrganisation(tenant.organisationId, rows => {
      const version = rows.filter(item => item.kind === 'priority_policy').reduce((highest, item) => Math.max(highest, item.data.version), 0) + 1;
      const created = row('priority_policy', tenant, { version, status: 'draft', matrix: data.matrix, sourceDocumentId: data.sourceDocumentId,
        sourceDocumentVersionId: data.sourceDocumentVersionId, sourceChecksumSha256: source.sha256, reason: data.reason });
      rows.push(created); this.audit(rows, tenant, created.id, 'priority_policy.created', data.reason); return created;
    });
    return record;
  }
  async decidePriorityPolicy(tenant: TenantContext, id: string, action: 'approve' | 'activate', reason: string) {
    this.require(tenant, 'configuration.manage');
    if (!reason.trim()) throw new AiOperationsError(400, 'REASON_REQUIRED', 'A decision reason is required.');
    return this.store.changeForOrganisation(tenant.organisationId, async rows => {
      const current = rows.find(item => item.id === id && item.kind === 'priority_policy' && item.organisationId === tenant.organisationId) as OfKind<'priority_policy'> | undefined;
      if (!current) throw new AiOperationsError(404, 'PRIORITY_POLICY_NOT_FOUND', 'Priority policy version not found.');
      if (action === 'approve') {
        if (current.data.status !== 'draft') throw new AiOperationsError(409, 'PRIORITY_POLICY_IMMUTABLE', 'Only a draft policy can be approved.');
        current.data.status = 'approved'; current.data.approvedBy = tenant.userId; current.data.approvalReason = reason;
      } else {
        if (current.data.status !== 'approved') throw new AiOperationsError(409, 'PRIORITY_POLICY_NOT_APPROVED', 'Approve the policy before activation.');
        if (!this.deps.prioritySource) throw new AiOperationsError(503, 'PRIORITY_SOURCE_UNAVAILABLE', 'Verified document sources are unavailable.');
        const source = await this.deps.prioritySource(tenant, current.data.sourceDocumentId, current.data.sourceDocumentVersionId);
        if (!source || source.sha256 !== current.data.sourceChecksumSha256) throw new AiOperationsError(409, 'PRIORITY_SOURCE_CHANGED', 'The approved policy source changed or is no longer available.');
        for (const item of rows) if (item.kind === 'priority_policy' && item.data.status === 'active') { item.data.status = 'archived'; item.updatedAt = new Date().toISOString(); }
        current.data.status = 'active'; current.data.activatedBy = tenant.userId; current.data.activationReason = reason;
      }
      current.updatedAt = new Date().toISOString(); this.audit(rows, tenant, id, `priority_policy.${action}`, reason); return current;
    });
  }
  async getAuthorizedRoutingContext(tenant: TenantContext, ticket: TicketAiView) {
    await this.ticket(tenant, ticket.id);
    const teams = (await this.deps.teams(tenant)).filter(team => this.deps.can(tenant, 'configuration.manage') || this.deps.teamIds(tenant).includes(team.id));
    const rules = await this.store.list(tenant.organisationId, 'routing');
    return { organisationId: tenant.organisationId, eligibleTeams: teams, rules: rules.filter(item => item.data.status === 'approved').map(item => ({
      id: item.id, version: item.updatedAt, organisationId: tenant.organisationId, categoryIds: item.data.categoryIds, teamId: item.data.teamId,
      approved: true, effectiveFrom: item.data.effectiveFrom, effectiveTo: item.data.effectiveTo ?? null,
    })) };
  }
  async verifyResolution(tenant: TenantContext, ticketId: string, input: unknown) {
    this.require(tenant, 'tickets.approve');
    const data = resolutionInput.parse(input);
    const ticket = await this.ticket(tenant, ticketId);
    if (!await this.deps.isResolved(tenant, ticket) || !ticket.history?.some(event => event.action === SLA_EVIDENCE_ACTIONS.resolution)) {
      throw new AiOperationsError(409, 'VERIFIED_RESOLUTION_REQUIRED', 'The ticket needs a configured resolved state and recorded resolution evidence.');
    }
    if (data.visibility === 'organisation_staff') this.require(tenant, 'configuration.manage');
    const record = row('resolution', tenant, { ...data, ticketId, ticketRevision: revision(ticket), active: true });
    await this.store.changeForOrganisation(tenant.organisationId, rows => {
      for (const item of rows) if (item.kind === 'resolution' && item.organisationId === tenant.organisationId && item.data.ticketId === ticketId) item.data.active = false;
      rows.push(record); this.audit(rows, tenant, record.id, 'resolution.verified', data.reason);
    });
    return record;
  }
  async revokeResolution(tenant: TenantContext, id: string, reason: string) {
    this.require(tenant, 'tickets.approve');
    const record = (await this.store.list(tenant.organisationId, 'resolution')).find(item => item.id === id);
    if (!record) throw new AiOperationsError(404, 'NOT_FOUND', 'Verified resolution not found.');
    await this.ticket(tenant, record.data.ticketId);
    if (record.data.visibility === 'organisation_staff') this.require(tenant, 'configuration.manage');
    await this.store.changeForOrganisation(tenant.organisationId, rows => {
      const target = rows.find(item => item.id === id && item.kind === 'resolution' && item.organisationId === tenant.organisationId) as OfKind<'resolution'>;
      target.data.active = false; target.updatedAt = new Date().toISOString(); this.audit(rows, tenant, id, 'resolution.revoked', reason);
    });
  }
  async listAuthorizedDocuments(tenant: TenantContext): Promise<KnowledgeDocument[]> {
    const documents: KnowledgeDocument[] = [];
    for (const item of await this.store.list(tenant.organisationId, 'resolution')) {
      if (!item.data.active) continue;
      const ticket = await this.deps.ticket(tenant, item.data.ticketId);
      if (!ticket || revision(ticket) !== item.data.ticketRevision || !await this.deps.isResolved(tenant, ticket)) continue;
      if (item.data.visibility === 'team' && !this.deps.can(tenant, 'configuration.manage') && (!ticket.teamId || !this.deps.teamIds(tenant).includes(ticket.teamId))) continue;
      documents.push({ id: ticket.id, version: item.id, organisationId: tenant.organisationId, sourceType: 'historical_ticket', title: ticket.title,
        content: item.data.resolution, approved: true, status: 'active', effectiveFrom: item.createdAt, effectiveTo: null });
    }
    return documents;
  }
  async computeReport(tenant: TenantContext, ticketId: string, reportId?: string) {
    const ticket = await this.ticket(tenant, ticketId);
    const snapshot = this.deps.project(ticket);
    const result = await this.deps.triage(tenant, ticketId);
    const current = await this.ticket(tenant, ticketId);
    if (ticketSnapshotHash(this.deps.project(current)) !== ticketSnapshotHash(snapshot) || result.core.orchestration?.snapshotHash !== ticketSnapshotHash(snapshot)) throw new AiOperationsError(409, 'TICKET_CHANGED', 'Ticket changed; request a fresh triage.');
    const report = row('report', tenant, { ticketId, snapshot, result: JSON.parse(JSON.stringify(result)) }, reportId);
    if (!await this.readable(tenant, report)) throw new AiOperationsError(409, 'SOURCE_ACCESS_CHANGED', 'An evidence source changed during triage; request a fresh analysis.');
    return report;
  }
  async saveReport(report: OfKind<'report'>) {
    return this.store.changeForOrganisation(report.organisationId, rows => {
      const existing = rows.find(item => item.id === report.id && item.kind === 'report' && item.organisationId === report.organisationId);
      if (existing) return existing as OfKind<'report'>;
      rows.push(report); return report;
    });
  }
  async run(tenant: TenantContext, ticketId: string) { return this.saveReport(await this.computeReport(tenant, ticketId)); }
  private async readable(tenant: TenantContext, report: OfKind<'report'>) {
    const result = report.data.result as unknown as Result;
    if (result.ticketId !== report.data.ticketId || result.organisationId !== tenant.organisationId) return false;
    const documents = [...await this.deps.knowledge.listAuthorizedDocuments(tenant), ...await this.listAuthorizedDocuments(tenant)];
    const passages = [...(result.evidence.status === 'completed' ? result.evidence.data : []), ...(result.resolution.status === 'completed' ? result.resolution.data.evidence : [])];
    const now = Date.now();
    if (!passages.every(passage => documents.some(doc => doc.organisationId === tenant.organisationId && doc.id === passage.sourceId && doc.version === passage.version &&
      doc.sourceType === passage.sourceType && doc.approved && doc.status === 'active' && Date.parse(doc.effectiveFrom) <= now && (!doc.effectiveTo || Date.parse(doc.effectiveTo) > now) && doc.content.slice(passage.start, passage.end) === passage.excerpt))) return false;
    if (result.sla.status === 'completed' && result.sla.data.evaluation && !this.deps.can(tenant, 'configuration.manage')) return false;
    if (result.routing.status === 'completed' && result.routing.data.evidence.length) {
      const routing = await (this.deps.routing ?? this).getAuthorizedRoutingContext(tenant, report.data.snapshot);
      if (!routing || routing.organisationId !== tenant.organisationId || !result.routing.data.evidence.every(evidence => routing.rules.some(rule => rule.approved && rule.organisationId === tenant.organisationId && rule.id === evidence.ruleId && rule.version === evidence.version &&
        routing.eligibleTeams.some(team => team.id === rule.teamId) && Date.parse(rule.effectiveFrom) <= now && (!rule.effectiveTo || Date.parse(rule.effectiveTo) > now)))) return false;
    }
    return true;
  }
  async reports(tenant: TenantContext, ticketId: string) {
    const ticket = await this.ticket(tenant, ticketId);
    const reviews = await this.store.list(tenant.organisationId, 'review');
    const output = [];
    for (const report of (await this.store.list(tenant.organisationId, 'report')).filter(item => item.data.ticketId === ticketId)) {
      output.push(await this.readable(tenant, report) ? { ...report, redacted: false, staleTicketSnapshot: ticketSnapshotHash(this.deps.project(ticket)) !== ticketSnapshotHash(report.data.snapshot),
        reviews: reviews.filter(review => review.data.reportId === report.id) } : { id: report.id, redacted: true, reason: 'SOURCE_ACCESS_CHANGED' });
    }
    return output;
  }
  async review(tenant: TenantContext, ticketId: string, reportId: string, input: unknown) {
    this.require(tenant, 'tickets.approve');
    const data = reviewInput.parse(input);
    const ticket = await this.ticket(tenant, ticketId);
    const report = (await this.store.list(tenant.organisationId, 'report')).find(item => item.id === reportId && item.data.ticketId === ticketId);
    if (!report || !await this.readable(tenant, report)) throw new AiOperationsError(404, 'NOT_FOUND', 'Triage report not found.');
    if (ticketSnapshotHash(this.deps.project(ticket)) !== ticketSnapshotHash(report.data.snapshot)) throw new AiOperationsError(409, 'STALE_REVIEW', 'Review a fresh ticket snapshot.');
    const result = report.data.result as Result;
    let resolutionRevision: { before: z.infer<typeof reviewedResolutionSchema>; after: z.infer<typeof reviewedResolutionSchema> } | undefined;
    if (data.editedResolution) {
      if (result.resolution.status !== 'completed') throw new AiOperationsError(409, 'RESOLUTION_EDIT_UNAVAILABLE', 'This report does not contain an editable resolution recommendation.');
      const beforeValue = { summary: result.resolution.data.summary, steps: result.resolution.data.steps,
        missingInformation: result.resolution.data.missingInformation, warnings: result.resolution.data.warnings };
      const before = reviewedResolutionSchema.parse(beforeValue);
      const after = validateResolutionOutput(data.editedResolution, result.resolution.data.evidence);
      resolutionRevision = { before, after: reviewedResolutionSchema.parse(after) };
    }
    const { editedResolution: _editedResolution, ...reviewData } = data;
    const record = row('review', tenant, { ...reviewData, reportId, ...(resolutionRevision ? { resolutionRevision } : {}) }, `review_${createHash('sha256').update(`${reportId}:${tenant.userId}`).digest('hex')}`);
    return this.store.changeForOrganisation(report.organisationId, rows => {
      const existing = rows.find(item => item.id === record.id && item.organisationId === tenant.organisationId);
      if (existing) {
        if (JSON.stringify(existing.data) !== JSON.stringify(record.data)) throw new AiOperationsError(409, 'REVIEW_IMMUTABLE', 'Reviewer decisions are immutable.');
        return existing;
      }
      rows.push(record); this.audit(rows, tenant, reportId, 'triage.reviewed', data.reason,
        resolutionRevision ? { before: resolutionRevision.before, after: resolutionRevision.after } : undefined); return record;
    });
  }
}
