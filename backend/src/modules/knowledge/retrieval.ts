import { createHash } from 'node:crypto';
import type { TenantContext } from '../../shared/tenant.js';

export type KnowledgeSourceType = 'approved_policy' | 'knowledge_article' | 'historical_ticket';
export type KnowledgeDocument = {
  id: string;
  version: string;
  organisationId: string;
  sourceType: KnowledgeSourceType;
  title: string;
  content: string;
  approved: boolean;
  status: 'active' | 'draft' | 'archived';
  effectiveFrom: string;
  effectiveTo: string | null;
};
/** Must enforce source-level permissions before returning content. No global unfiltered index. */
export interface AuthorizedKnowledgeSource {
  listAuthorizedDocuments(tenant: TenantContext): Promise<KnowledgeDocument[]>;
}
export type RetrievedPassage = {
  passageId: string;
  sourceId: string;
  version: string;
  sourceType: KnowledgeSourceType;
  title: string;
  excerpt: string;
  start: number;
  end: number;
  score: number;
};
const stopWords = new Set(['the','and','for','that','this','with','from','have','your','are','was','not']);
function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length > 2 && !stopWords.has(word)));
}

/** Bounded lexical retrieval: no embeddings, persistent vector index or provider call. */
export class KnowledgeRetriever {
  constructor(private readonly source: AuthorizedKnowledgeSource) {}
  async retrieve(tenant: TenantContext, query: string, options: { excludeTicketId?: string; now?: string; sourceType?: KnowledgeSourceType } = {}): Promise<RetrievedPassage[]> {
    if (!tenant?.organisationId || !tenant.userId || typeof query !== 'string' || !query.trim()) throw new Error('Trusted tenant and nonempty retrieval query are required.');
    const now = Date.parse(options.now ?? new Date().toISOString());
    if (!Number.isFinite(now)) throw new Error('Invalid retrieval time.');
    const queryTerms = terms(query.slice(0, 8_000));
    const candidates: RetrievedPassage[] = [];
    const seen = new Set<string>();
    for (const document of await this.source.listAuthorizedDocuments(tenant)) {
      // Filter before tokenisation/ranking. Dates fail closed, including malformed expiry.
      if (document.organisationId !== tenant.organisationId || document.approved !== true || document.status !== 'active' ||
        (options.sourceType !== undefined && document.sourceType !== options.sourceType) ||
        !Number.isFinite(Date.parse(document.effectiveFrom)) || Date.parse(document.effectiveFrom) > now ||
        (document.effectiveTo !== null && (!Number.isFinite(Date.parse(document.effectiveTo)) || Date.parse(document.effectiveTo) <= now)) ||
        (document.sourceType === 'historical_ticket' && document.id === options.excludeTicketId)) continue;
      if (!['approved_policy','knowledge_article','historical_ticket'].includes(document.sourceType) ||
        typeof document.id !== 'string' || !document.id.trim() || typeof document.version !== 'string' || !document.version.trim() ||
        typeof document.title !== 'string' || !document.title.trim() || typeof document.content !== 'string') continue;
      // Cap context from any one record. Caller source must paginate/bound its own scan.
      const content = document.content.slice(0, 24_000);
      for (let start = 0; start < content.length; start += 600) {
        const excerpt = content.slice(start, start + 800);
        if (!excerpt.trim()) continue;
        const words = terms(excerpt);
        const overlap = [...queryTerms].filter(word => words.has(word)).length;
        if (!overlap) continue;
        const passageId = `passage_${createHash('sha256').update(JSON.stringify([document.organisationId, document.sourceType, document.id, document.version, start, excerpt])).digest('hex')}`;
        if (seen.has(passageId)) continue;
        seen.add(passageId);
        candidates.push({ passageId, sourceId: document.id, version: document.version, sourceType: document.sourceType,
          title: document.title, excerpt, start, end: start + excerpt.length, score: overlap / Math.max(queryTerms.size, 1) });
      }
    }
    return candidates.sort((a, b) => b.score - a.score || a.passageId.localeCompare(b.passageId)).slice(0, 5);
  }
}
