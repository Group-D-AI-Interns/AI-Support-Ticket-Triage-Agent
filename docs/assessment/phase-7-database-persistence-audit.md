# Phase 7 — Database and persistence audit

**Audit date:** 24 November 2026  
**Requirement source:** Phase 7 of the supplied Capstone master prompt  
**Scope:** Source inspection of JSON and MongoDB adapters, domain types, validators, repositories, indexes, migration, isolated Atlas integration checks, and the user-approved import into the configured main Atlas database. Connection strings are not recorded here.

## Result

The requested concepts are represented across tenant-scoped collections, embedded ticket records, and a shared typed AI operations ledger. This is a document model, not a one-collection-per-prompt-entity implementation. Reusing the implemented records is appropriate for the current contract; creating empty collections for every proposed noun would duplicate or fragment existing state.

MongoDB Atlas is the selected application database. Earlier isolated checks covered transaction, rollback, tenant-scoped persistence, indexes, and synthetic import. Normal startup now defaults to MongoDB in development and production; JSON is restricted to tests and the offline synthetic demo. The configured Atlas URI passed a read-only ping and Mongo index initialization. The user-approved import transferred 80 records from 18 validated local collections into the previously empty target; post-import counts matched and source JSON files were unchanged. Atlas backup/restore and authenticated application acceptance remain unverified.

## Entity mapping

MongoDB records use string application IDs as `_id` and retain the domain `id` on read/write. Tenant-owned records carry `organisationId`. UTC timestamps are ISO strings in the current domain model; MongoDB does not coerce them to BSON dates.

| Master-prompt entity | Implemented persistence | Fields, validation, relationships and tenant scope | Indexes / finding |
|---|---|---|---|
| `users` | `app_users` | `id`, `email`, `displayName`, `status`, `createdAt`, `updatedAt`; global identity, with organisation membership stored separately. `isUser` checks required strings, status enum, and parseable timestamps. | Case-insensitive unique email. User is global, not duplicated per tenant. |
| organisation memberships | `app_memberships` | `id`, `organisationId`, `userId`, `status`, `roles[]`, timestamps; references user and organisation IDs. `isMembership` checks strings, status, role array and timestamps. | Unique `(organisationId,userId)` plus active-membership lookup indexes. |
| `support_teams` | `app_departments`, `app_teams`, `app_team-memberships` | Department/team/membership IDs, `organisationId`, team `departmentId`, member `teamId`/`userId`/role/status and timestamps. Repository methods check tenant ownership and related membership before writes. | Tenant lookup; unique `(organisationId,teamId,userId)` membership key. IDs are application-enforced references; MongoDB has no foreign-key constraint. |
| `tickets` | `app_tickets` | `id`, `organisationId`, `requesterId`, optional `workflowId`, `title`, JSON-compatible `description`, optional product/service/team/status/priority, timestamps. `isTicketRecord` validates required IDs/title/timestamps and nested optional structures. Request schemas additionally reject unrecognized intake fields. | Tenant queue `(organisationId,createdAt)`, team queue, requester queue, and open-escalation lookup. List/detail/page reads include tenant filters and ticket visibility scope. |
| `ticket_comments` | Embedded `tickets.comments[]` | Comment ID, author, body, visibility (`internal`/`public`), timestamp; caller role determines visibility. No independent comment repository/collection. | Ticket document access and ticket history; no separate comment index. |
| `ticket_attachments` | Embedded `tickets.attachments[]` metadata | Attachment ID, filename, MIME type, storage key, SHA-256, size, uploader, timestamp. File bytes are stored under local private filesystem storage, not in MongoDB. | No separate attachment collection. Production private object storage, malware scanning, and retention/deletion are not implemented or selected. |
| `ticket_categories` | `app_ai-operations`, records with `kind: "category"` | Strict Zod discriminated schema with `id`, `organisationId`, actor/timestamps and category ID/name/optional description/status. | Shared `(organisationId,kind,createdAt)` history index. |
| `ticket_classifications` | `app_ai-analyses`; triage reports also in `app_ai-operations` with `kind: "report"` | Analysis includes tenant/ticket IDs, status, classification categories/reason/confidence/evidence/review flag/warnings, summary, provider execution records and timestamps. Stored analysis is normalized and validated before persistence. | `(organisationId,ticketId,createdAt)` on analyses; AI operation history index for reports. |
| `ticket_summaries` | Same `app_ai-analyses` record as classification | Structured summary fields are persisted with their paired classification and execution metadata; they are not independent records. | Same analysis-history index. |
| `ticket_priorities` | `tickets.priority`, `tickets.history[]`, and `app_ai-operations` `priority_policy` records | Internal P1–P4 priority lives on the ticket; overrides are audited in history. Versioned matrix drafts carry source document/version/checksum, state, reason, approver and activation metadata. | Ticket queue indexes do not include priority. Priority policy reads share AI operation history. |
| `ticket_resolutions` | `app_ai-operations` records of kind `resolution` and `review`; resolution evidence may also be in ticket history | Recommendation stores ticket ID/revision, resolution text, visibility, reason and active flag. Review records decision/reason and optional immutable before/after edited-resolution snapshots. Schemas are strict Zod records. | Shared tenant/kind history index. |
| `historical_tickets` | No separate archive collection; eligible records remain in `app_tickets` | Similar-ticket retrieval derives candidates from existing scoped tickets and verified resolution evidence; it rejects reopened/revoked evidence. This avoids copying tickets into a second lifecycle. | Ticket query path; no dedicated archive index. Retention/archival policy remains unspecified. |
| `knowledge_base` | `app_policies`, `app_policyVersions`, `app_extractedRules`, `app_policyApprovals` | Published knowledge is represented by active, approved policy-version payloads with source document/version IDs and extracted clauses/excerpts. `publishedKnowledgeSchema` validates published payloads; access filters by tenant, approval, active version and visibility. | Tenant policy type/status, unique tenant/policy/version, extracted-rule, and approval indexes. No separate knowledge-article repository is implemented. |
| `routing_rules` | `app_ai-operations`, `kind: "routing"` | Category IDs, team ID, effective interval, status and approval metadata; strict schema. | Shared tenant/kind history index. Team/tenant checks are performed by the service. |
| `priority_rules` | `app_ai-operations`, `kind: "priority_policy"` | Version, matrix, source document/version/checksum, status, reason and approval/activation metadata; strict schema. | Shared tenant/kind history index. |
| `sla_policies` | `app_policies` and `app_policyVersions` with SLA policy type/payload; `app_slaEvaluations` for results | Versioned tenant policy holds approved targets/calendar-related payload; evaluation records hold ticket/policy/version IDs, input, result and evaluation timestamp. These models are app-validated; no separate calendar entity is defined. | Tenant policy type/status, unique tenant policy/version; `(organisationId,ticketId,evaluatedAt)` for evaluation history. Actual tenant-approved targets/calendars remain unverified. |
| `approvals` | `app_policyApprovals`, ticket-workflow state, and `app_ai-operations` review records | Approval models are domain-specific: policy/version/rule decisions have reviewer/reason/timestamps; workflow approval state is on `ticket-workflows`; triage reviews are immutable operation records. There is no generic approval collection. | Tenant decision/version lookup for policy approvals; workflow unique active-per-tenant index; AI operation history. |
| `ticket_audit_logs` | Embedded `tickets.history[]`; some policy/document events use `app_auditLogs`; AI audit events use `app_ai-operations`, `kind: "audit"` | Ticket events include action, actor, timestamp and before/after changes. Shared records include tenant, actor, action, target and optional before/after data. Audit coverage is split by domain and is not a complete immutable universal ledger. | Tenant/createdAt index on `auditLogs`; ticket history is embedded. Identity/team events are not uniformly recorded. |
| `agent_executions` | `app_ai-workflow-runs` plus execution arrays in `app_ai-analyses` | Workflow run stores engine/version/status/hashes/timestamps/trace/warnings, tenant/ticket/initiator, execution metadata and failure. Zod validates run shape and status consistency. Mongo migration maps `runId` to storage `id` while preserving the domain field. | `(organisationId,ticketId,startedAt)` index. |

Additional persisted equivalents include `app_documents`, `app_documentVersions`, `app_extractionJobs`, and `app_documentExtractions`. Document records retain storage keys, checksum, MIME type, size, version, actor and processing state; uploaded bytes remain outside MongoDB.

## Representative synthetic records

These are shape examples from the implemented models, not records read from a database. Values are synthetic and sensitive fields are omitted.

```json
{
  "_id": "ticket_synthetic_1",
  "id": "ticket_synthetic_1",
  "organisationId": "org_synthetic",
  "requesterId": "user_synthetic",
  "title": "Synthetic access issue",
  "priority": "P2",
  "comments": [],
  "attachments": [],
  "history": [],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

```json
{
  "_id": "operation_synthetic_1",
  "id": "operation_synthetic_1",
  "organisationId": "org_synthetic",
  "actorId": "user_synthetic",
  "kind": "category",
  "data": { "categoryId": "ACCOUNT_ACCESS", "name": "Account access", "status": "active" },
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

## Validation, query and migration findings

- Application schemas and record validators are the primary validation boundary. MongoDB collections do not currently have server-side JSON Schema validators. Migration validation now checks field shapes, status enums, timestamps, checksums, nested extraction results, SLA metric structures, and strict AI operation/analysis contracts across supported collections. Policy-version payloads remain opaque objects at the generic migration boundary because their schema depends on policy type; policy-specific validation still occurs in application services.
- Repository/service calls provide tenant scoping for identity membership, ticket reads and mutations, workflows, teams, documents, policies, SLA, analysis, and AI operations. Ticket list/detail/pagination queries include tenant filters. Ticket and workflow mutations now pass the authenticated organisation into Mongo transactions, read only that tenant's records, and include the tenant in replace/delete filters. JSON stores retain their existing whole-file implementation for local/test use.
- `MongoFileStore` also retains generic whole-collection read/update operations for compatibility. Not every repository operation is translated into a bounded query. The organisation list and some global worker polling likewise scan across tenants by design or compatibility.
- Migration is opt-in: the default is a source validation/dry run; `--apply` requires Mongo environment settings and rejects a database containing application records. It imports in a transaction, verifies per-collection counts, and leaves source JSON files unchanged. The current approved import moved 80 records across 18 collections into an empty Atlas target; it did not copy document or attachment bytes.
- The migration script's allowlist and validators should be reviewed whenever a new persisted logical collection is added. The active published-knowledge implementation uses policy/version records rather than the unused `knowledge-articles` and `knowledge-actions` index entries; those entries were removed so startup no longer creates unused collections solely to add indexes.

## Retention, deletion, and infrastructure status

The source requirements do not give retention periods, deletion semantics, legal-hold behavior, or whether historical tickets should be anonymized. No TTL indexes or automatic expiry are configured. These behaviors are **unspecified**, not verified as a policy; do not invent them. Ticket deletion is not presented as an automatic retention mechanism. Attachment bytes are local private files and do not inherit MongoDB backup/restore.

Production Atlas network restrictions, least-privilege permissions, encryption/key management, and data residency remain **unverified**. The configured main target was pinged and application indexes initialized; 80 records were imported transactionally after confirming the target collections were empty. Atlas snapshot backup/restore was not exercised; `mongodump`/`mongorestore` are not installed in this workspace. Production object storage and malware scanning remain unselected. The migration preserved source JSON and did not copy document/attachment file bytes. Legacy Jira source metadata remains readable, but webhook route/configuration/upsert code and new source-identity index creation are absent.

## Phase 7 status

**Partially complete.** MongoDB Atlas connectivity, index initialization, and the user-approved 80-record/18-collection import are verified with per-collection count parity; source JSON is intact. Earlier isolated persistence tests passed **20/20**. Backend type-check/build pass. Remaining Phase 7 work includes authenticated application acceptance, backup/restore and production access verification, private file storage/scanning decisions, and retention/deletion policy. The Node test runner is restricted by `spawn EPERM`, so the current configuration regression tests did not execute in this pass.
