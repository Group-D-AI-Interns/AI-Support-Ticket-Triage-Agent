import { createHash, randomUUID } from 'node:crypto';
import type { TenantContext } from '../../../shared/tenant.js';
import type { JsonTenantStore } from '../../../infrastructure/persistence/json/json-store.js';
import type { PolicyRepository } from '../../policies/repositories/policy.repository.js';
import type { PolicyAuditRecord, PolicyVersionRecord } from '../../policies/domain/policy.js';
import type { DocumentVersionRecord } from '../domain/document.js';
import type { ExtractionJobRecord } from '../domain/extraction-job.js';
import type { DocumentStorageAdapter } from '../storage/document-storage.js';
import { JsonDocumentRepository } from '../repositories/json-document.repository.js';
import { InMemoryExtractionQueue } from '../queue/in-memory-extraction-queue.js';
import { ExtractionWorker } from '../workers/extraction-worker.js';
import type { ExtractionAdapter } from './extraction-adapter.js';
import { ExtractionJobService } from './extraction-job-service.js';
import { CandidateRuleService } from './candidate-rule-service.js';
import { LocalDocumentTextConverter } from './document-text-converter.js';
import { publishedKnowledgeSchema } from '../../knowledge/published-knowledge.js';

export class DocumentKnowledgeError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** Application commands; API must enforce document-management permission before invoking. */
export class DocumentKnowledgeService {
  private readonly documents: JsonDocumentRepository;
  private readonly files: Pick<JsonTenantStore, 'runExclusive'>;
  constructor(private readonly store: JsonTenantStore, private readonly policies: PolicyRepository,
    private readonly storage: DocumentStorageAdapter, private readonly adapter: ExtractionAdapter) {
    this.documents = new JsonDocumentRepository(store);
    this.files = store;
  }
  private async current(tenant: TenantContext, documentId: string) {
    const document = await this.documents.getById(tenant, documentId);
    if (!document) throw new DocumentKnowledgeError(404, 'NOT_FOUND', 'Document not found.');
    const [version] = await this.store.queryCollection<DocumentVersionRecord>('documentVersions', {
      organisationId: tenant.organisationId,
      documentId: document.id,
      version: document.version,
    });
    if (!version) throw new DocumentKnowledgeError(409, 'DOCUMENT_NOT_READY', 'Current document version is unavailable.');
    return { document, version };
  }
  private policyId(tenant: TenantContext, documentId: string) { return `knowledge_${hash([tenant.organisationId, documentId])}`; }
  private lock<T>(tenant: TenantContext, documentId: string, action: () => Promise<T>) {
    return this.files.runExclusive(`knowledge-command-${hash([tenant.organisationId, documentId])}.json`, action);
  }

  async extract(tenant: TenantContext, documentId: string, retry = false) {
    // Serialize setup only. No collection lock is held during the provider request.
    const prepared = await this.lock(tenant, documentId, async () => {
      const { document, version } = await this.current(tenant, documentId);
      const policyId = this.policyId(tenant, documentId);
      const versionId = `extraction_${hash([tenant.organisationId, version.id])}`;
      const existing = (await this.store.queryCollection<ExtractionJobRecord>('extractionJobs', {
        organisationId: tenant.organisationId,
        documentId: document.id,
        documentVersionId: version.id,
        policyVersionId: versionId,
      }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (existing && !(existing.status === 'failed' && retry)) return existing;
      const now = new Date().toISOString();
      if (!await this.policies.getPolicyById(tenant, policyId)) await this.policies.createPolicy({ id: policyId, organisationId: tenant.organisationId,
        ownerId: tenant.userId, policyType: 'knowledge', status: 'draft', version: 1, description: document.title, createdAt: now, updatedAt: now }, tenant);
      if (!await this.policies.getVersionById(tenant, versionId)) {
        const versions = await this.policies.listVersionsForPolicy(tenant, policyId);
        await this.policies.createVersion(policyId, { id: versionId, policyId, organisationId: tenant.organisationId,
          version: Math.max(0, ...versions.map(item => item.version)) + 1, status: 'draft', effectiveFrom: null, effectiveTo: null, payload: {},
          sourceDocumentId: document.id, sourceDocumentVersionId: version.id, createdAt: now, updatedAt: now }, tenant);
      }
      return new ExtractionJobService(this.store, this.policies).processDocument({ tenant, documentId, policyId, policyVersionId: versionId, maxAttempts: 1 });
    });
    const queue = new InMemoryExtractionQueue(this.store);
    if (prepared.status === 'queued' || prepared.status === 'retrying') {
      const targetedQueue = { enqueue: queue.enqueue.bind(queue), getById: queue.getById.bind(queue), update: queue.update.bind(queue),
        claimNext: (context: TenantContext) => queue.claimById(context, prepared.id) };
      await new ExtractionWorker(this.store, targetedQueue, this.adapter, this.storage, new CandidateRuleService(this.policies)).processNextForTenant(tenant);
    }
    const job = await queue.getById(tenant, prepared.id);
    const rules = (await this.policies.listExtractedRules(tenant, prepared.policyVersionId)).filter(rule => rule.executionId === prepared.executionId);
    return { job: job ?? prepared, rules };
  }

  async history(tenant: TenantContext, documentId: string) {
    await this.current(tenant, documentId);
    return this.store.queryCollection<ExtractionJobRecord>('extractionJobs', {
      organisationId: tenant.organisationId,
      documentId,
    });
  }

  private async recordPublication(tenant: TenantContext, version: PolicyVersionRecord, reason: string) {
    await this.store.withCollectionLock('auditLogs', async () => {
      const id = `knowledge-published-${version.id}`;
      await this.store.updateTenantCollection<PolicyAuditRecord, void>('auditLogs', tenant.organisationId, records => {
        if (!records.some(record => record.id === id)) {
          records.push({ id, organisationId: tenant.organisationId, actorId: tenant.userId, action: 'knowledge.published',
          targetType: 'policy_version', targetId: version.id, createdAt: new Date().toISOString(),
          after: { status: version.status, visibility: version.payload.visibility, reason: reason.trim(),
            sourceDocumentId: version.sourceDocumentId, sourceDocumentVersionId: version.sourceDocumentVersionId } });
        }
      });
    });
  }

  async publish(tenant: TenantContext, documentId: string, input: { ruleIds: string[]; reason: string; effectiveFrom: string; effectiveTo: string | null; visibility: 'administrators' | 'support_staff' }) {
    return this.lock(tenant, documentId, async () => {
      const { document, version } = await this.current(tenant, documentId);
      if (document.status !== 'processed' || document.processingStatus !== 'completed') {
        throw new DocumentKnowledgeError(409, 'DOCUMENT_NOT_READY', 'Complete extraction of the current source version before publication.');
      }
      const from = Date.parse(input.effectiveFrom);
      const to = input.effectiveTo === null ? null : Date.parse(input.effectiveTo);
      if (!input.reason.trim() || !input.ruleIds.length || new Set(input.ruleIds).size !== input.ruleIds.length ||
        !Number.isFinite(from) || from > Date.now() || (to !== null && (!Number.isFinite(to) || to <= Date.now() || to <= from))) {
        throw new DocumentKnowledgeError(400, 'INVALID_PUBLICATION', 'Choose approved rules, a reason and an effective publication window.');
      }
      const policyId = this.policyId(tenant, documentId);
      const extractionVersionId = `extraction_${hash([tenant.organisationId, version.id])}`;
      const rules = await this.policies.listExtractedRules(tenant, extractionVersionId);
      const selected = input.ruleIds.map(id => rules.find(rule => rule.id === id));
      const approvals = await this.store.queryCollection<{ id: string; organisationId: string; extractedRuleId?: string; policyVersionId: string; decision: string; reviewerId: string }>('policyApprovals', {
        organisationId: tenant.organisationId,
        policyVersionId: extractionVersionId,
        decision: 'approved',
      });
      if (selected.some(rule => !rule || rule.reviewStatus !== 'approved' || rule.documentId !== document.id || rule.documentVersionId !== version.id ||
        !approvals.some(approval => approval.organisationId === tenant.organisationId && approval.extractedRuleId === rule.id &&
          approval.policyVersionId === extractionVersionId && approval.decision === 'approved' && approval.reviewerId === rule.reviewedBy))) {
        throw new DocumentKnowledgeError(409, 'APPROVED_RULES_REQUIRED', 'Every selected rule must be approved for the current document version.');
      }
      const content = await this.storage.getDocument(tenant, version.storageKey);
      if (!content || createHash('sha256').update(content).digest('hex') !== version.checksumSha256) {
        throw new DocumentKnowledgeError(409, 'SOURCE_DOCUMENT_CHANGED', 'The approved source document is unavailable or changed.');
      }
      const text = (await new LocalDocumentTextConverter().convert(content, version)).content;
      const clauses = selected.map(rule => {
        const excerpts = rule!.evidence.filter(item => item.sourceType === 'document' && item.sourceId === document.id && item.versionId === version.id)
          .map(item => item.excerpt).filter((excerpt): excerpt is string => typeof excerpt === 'string' && !!excerpt.trim());
        if (!excerpts.length || excerpts.some(excerpt => !text.includes(excerpt))) throw new DocumentKnowledgeError(409, 'INVALID_RULE_EVIDENCE', 'Selected rule evidence no longer matches its source.');
        return { ruleId: rule!.id, ruleType: rule!.ruleType, excerpts };
      }).sort((a, b) => a.ruleId.localeCompare(b.ruleId));
      const payload = publishedKnowledgeSchema.parse({ kind: 'published_document_knowledge', title: document.title, visibility: input.visibility,
        sourceDocumentId: document.id, sourceDocumentVersionId: version.id, extractionVersionId, clauses });
      const publicationId = `publication_${hash([tenant.organisationId, payload, input.effectiveFrom, input.effectiveTo, input.reason.trim()])}`;
      let publication = await this.policies.getVersionById(tenant, publicationId);
      if (publication?.status === 'active') { await this.recordPublication(tenant, publication, input.reason); return publication; }
      const now = new Date().toISOString();
      if (!publication) {
        const versions = await this.policies.listVersionsForPolicy(tenant, policyId);
        publication = await this.policies.createVersion(policyId, { id: publicationId, policyId, organisationId: tenant.organisationId,
          version: Math.max(0, ...versions.map(item => item.version)) + 1, status: 'draft', effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo,
          sourceDocumentId: document.id, sourceDocumentVersionId: version.id, payload, createdAt: now, updatedAt: now }, tenant);
      }
      if (publication.status === 'draft') publication = await this.policies.transitionVersionStatus(tenant, publicationId, 'pending_approval');
      if (publication?.status === 'pending_approval') {
        await this.policies.addApproval({ id: `approval_${randomUUID()}`, organisationId: tenant.organisationId, policyVersionId: publicationId,
          reviewerId: tenant.userId, decision: 'approved', reason: input.reason.trim(), createdAt: now }, tenant);
      }
      const active = await this.policies.activateVersion(tenant, policyId, publicationId);
      if (!active) throw new DocumentKnowledgeError(409, 'PUBLICATION_CONFLICT', 'Publication could not be activated; check the existing version and effective window.');
      await this.recordPublication(tenant, active, input.reason);
      return active;
    });
  }
}
