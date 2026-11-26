import type { TenantContext } from '../../shared/tenant.js';
import type { TicketClassifier } from './components/ticket-classifier.js';
import type { TicketSummarizer } from './components/ticket-summarizer.js';
import type { PriorityRecommender } from './components/priority-recommender.js';
import type { AiExecutionRunner } from './ai-execution-runner.js';
import type { AiAnalysisRepository, AuthorizedTicketAnalysisSource } from './ports.js';
import type { TicketClassificationCategory } from './contracts.js';
import type { AuthorizedKnowledgeSource } from '../knowledge/retrieval.js';
import { KnowledgeRetriever } from '../knowledge/retrieval.js';
import { loadAuthorizedTicket } from './authorized-ticket.js';
import { TicketAiAnalysisService } from './ticket-ai-analysis.service.js';
import { ResolutionRecommendationService } from './resolution-recommendation.service.js';
import { recommendRouting, verifiedSlaInsight } from './team-recommendations.js';
import type { AuthorizedRoutingSource, VerifiedSlaInsightSource } from './team-capability-ports.js';
import type { AiOperationsStore } from './operations-store.js';

export type CapabilityResult<T> = { status: 'completed'; data: T } | { status: 'unavailable' | 'failed'; code: string; data: null };
export type AiTriageCapabilities = { priority?: PriorityRecommender; knowledge?: AuthorizedKnowledgeSource;
  resolutionRunner?: AiExecutionRunner; resolutionOperations?: AiOperationsStore; routing?: AuthorizedRoutingSource; sla?: VerifiedSlaInsightSource };

/** AI-owned composition entry point for future ticket/job adapters. No user impersonation or writes. */
export class TicketAiTriageService {
  constructor(private readonly source: AuthorizedTicketAnalysisSource, private readonly classifier: TicketClassifier,
    private readonly summarizer: TicketSummarizer, private readonly repository: AiAnalysisRepository,
    private readonly capabilities: AiTriageCapabilities = {}) {}
  async analyze(input: { tenant: TenantContext; ticketId: string; categories: TicketClassificationCategory[]; informationToCollect?: string[] }) {
    const ticket = await loadAuthorizedTicket(this.source, input.tenant, input.ticketId);
    // Freeze the authorized projection for this run. A new run reloads teammate-owned sources.
    const source: AuthorizedTicketAnalysisSource = { async getAuthorizedTicket(tenant, id) {
      return tenant.organisationId === ticket.organisationId && id === ticket.id ? structuredClone(ticket) : null;
    } };
    const core = await new TicketAiAnalysisService(source, this.classifier, this.summarizer, this.repository).analyze(input);
    async function optional<T>(action: (() => Promise<T>) | undefined, code: string): Promise<CapabilityResult<T>> {
      if (!action) return { status: 'unavailable', code, data: null };
      try { return { status: 'completed', data: await action() }; }
      catch { return { status: 'failed', code: `${code}_FAILED`, data: null }; }
    }
    const priority = await optional(this.capabilities.priority ? () => this.capabilities.priority!.recommend(structuredClone(ticket), input.tenant) : undefined, 'PRIORITY');
    const knowledge = await optional(this.capabilities.knowledge ? () => this.capabilities.knowledge!.listAuthorizedDocuments(input.tenant) : undefined, 'KNOWLEDGE_SOURCE');
    const documents = knowledge.status === 'completed' ? structuredClone(knowledge.data) : null;
    const retrieval = documents ? new KnowledgeRetriever({ async listAuthorizedDocuments() { return structuredClone(documents); } }) : null;
    const evidence = knowledge.status === 'failed' ? knowledge : await optional(retrieval ? () => retrieval.retrieve(input.tenant, `${ticket.title}\n${ticket.description}`, { excludeTicketId: ticket.id }) : undefined, 'RETRIEVAL');
    const resolution = knowledge.status === 'failed' ? knowledge : await optional(retrieval && this.capabilities.resolutionRunner
      ? () => new ResolutionRecommendationService(source, retrieval, this.capabilities.resolutionRunner!, this.capabilities.resolutionOperations).recommend(input.tenant, ticket.id) : undefined, 'RESOLUTION');
    const routing = await optional(() => recommendRouting(input.tenant, ticket, core.classification.categories, this.capabilities.routing), 'ROUTING');
    const sla = await optional(() => verifiedSlaInsight(input.tenant, ticket, this.capabilities.sla), 'SLA');
    return { ticketId: ticket.id, organisationId: ticket.organisationId, requiresHumanReview: true as const, core,
      priority, evidence, resolution, routing, sla };
  }
}
