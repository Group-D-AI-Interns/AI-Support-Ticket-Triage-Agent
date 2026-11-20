import { createHash, randomUUID } from 'node:crypto';
import type { TenantContext } from '../../shared/tenant.js';
import type { TicketRecord } from '../tickets/domain/ticket.js';
import type { AuthorizedKnowledgeSource, KnowledgeDocument } from '../knowledge/retrieval.js';
import type { AuthorizedRoutingSource } from './team-capability-ports.js';
import type { TicketAiView, TicketClassificationCategory } from './contracts.js';
import type { TicketAiTriageService } from './ticket-ai-triage.service.js';
import { ticketSnapshotHash } from './ticket-analysis.graph.js';
import { SLA_EVIDENCE_ACTIONS } from '../sla/domain/sla-evidence.js';
import { AiOperationsStore, routingInput, resolutionInput, reviewInput, type Operation, type OfKind } from './operations-store.js';

export class AiOperationsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function revision(ticket: TicketRecord) { return createHash('sha256').update(JSON.stringify(ticket)).digest('hex'); }
type Result = Awaited<ReturnType<TicketAiTriageService['analyze']>>;
export type AiOperationsDependencies = {
  ticket(tenant: TenantContext, id: string): Promise<TicketRecord | null>;
  project(ticket: TicketRecord): TicketAiView;
  teams(tenant: TenantContext): Promise<Array<{ id: string; organisationId: string; name: string }>>;
  can(tenant: TenantContext, permission: 'configuration.manage' | 'tickets.approve'): boolean;
  teamIds(tenant: TenantContext): string[];
  isResolved(tenant: TenantContext, ticket: TicketRecord): Promise<boolean>;
  categories(): TicketClassificationCategory[];
  knowledge: AuthorizedKnowledgeSource;
  routing?: AuthorizedRoutingSource;
  triage(tenant: TenantContext, id: string): Promise<Result>;
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
  private audit(rows: Operation[], tenant: TenantContext, targetId: string, action: string, reason: string) {
    rows.push(row('audit', tenant, { targetId, action, reason }));
  }
  async createRouting(tenant: TenantContext, input: unknown) {
    this.require(tenant, 'configuration.manage');
    const data = routingInput.parse(input);
    await this.validateRouting(tenant, data);
    const record = row('routing', tenant, { ...data, status: 'draft' });
    await this.store.change(rows => { rows.push(record); this.audit(rows, tenant, record.id, 'routing.created', 'Draft rule created.'); });
    return record;
  }
  private async validateRouting(tenant: TenantContext, data: ReturnType<typeof routingInput.parse>) {
    if (!data.categoryIds.every(id => this.deps.categories().some(category => category.id === id)) ||
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
    return this.store.change(rows => {
      const current = rows.find(item => item.id === id && item.kind === 'routing' && item.organisationId === tenant.organisationId) as OfKind<'routing'>;
      if (action === 'approve' && current.data.status !== 'draft') throw new AiOperationsError(409, 'RULE_IMMUTABLE', 'Create a new draft version instead.');
      current.data = { ...current.data, status: action === 'approve' ? 'approved' : 'disabled',
        ...(action === 'approve' ? { approvedBy: tenant.userId } : {}), reason };
      current.updatedAt = new Date().toISOString();
      this.audit(rows, tenant, id, `routing.${action}`, reason);
      return current;
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
    await this.store.change(rows => {
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
    await this.store.change(rows => {
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
    return this.store.change(rows => {
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
    const record = row('review', tenant, { ...data, reportId }, `review_${createHash('sha256').update(`${reportId}:${tenant.userId}`).digest('hex')}`);
    return this.store.change(rows => {
      const existing = rows.find(item => item.id === record.id && item.organisationId === tenant.organisationId);
      if (existing) {
        if (JSON.stringify(existing.data) !== JSON.stringify(record.data)) throw new AiOperationsError(409, 'REVIEW_IMMUTABLE', 'Reviewer decisions are immutable.');
        return existing;
      }
      rows.push(record); this.audit(rows, tenant, reportId, 'triage.reviewed', data.reason); return record;
    });
  }
}
