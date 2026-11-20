# Jira-to-AI integration assessment

Date: 2026-11-19. Status: proposal for team review, not an approved implementation contract.
Baseline: current repository and `AI_SUPPORT_TICKET_TRIAGE_AGENT_BACKEND_IMPLEMENTATION.md`,
especially sections 3, Phase 3/5, 11.4, 11.6 and 15. No runtime, teammate module,
dependency manifest, existing API specification or environment settings were changed.
Earlier uncommitted verification changes were preserved.

## 1. What exists

The canonical backend is Node.js/TypeScript. Fhulu's ticket API uses Express 5 in
`backend/src/modules/tickets/api.ts`, composed with the foundation HTTP application
through `integrated-app.ts` and `server.ts`. No additional runtime is needed.

| Capability | Current evidence | Assessment |
| --- | --- | --- |
| Jira webhook intake | `POST /api/v1/tickets/ingest/jira/:webhookSecret` | Exists, protected by a configured per-organisation URL secret |
| Tenant selection | `tickets/config.ts`, `JIRA_TENANT_CONFIG` | Project-key mapping plus reporter account-ID mapping; body organisation ID is ignored |
| Validation | `parseJiraBody`, `mapJiraIssue` | Created/updated events, project/key, issue ID, reporter and summary checked |
| Duplicate issue storage | `JsonTicketStore.upsertJiraTicket` | Tenant + issue ID identifies a record; identical data is a duplicate; changed data updates it |
| Jira identity | `TicketSource` | Issue ID/key/project key, source status/priority retained |
| Description projection | `descriptionText` | Extracts text from string/ADF-like nested content; not a complete Jira normalization boundary |
| Jira REST read/write | No Jira REST adapter found | Missing |
| Automatic AI handoff | Ingestion handler ends after storage/response | Missing; current AI analysis is explicitly requested through another endpoint |
| AI source port | `modules/ai/ports.ts` | `AuthorizedTicketAnalysisSource.getAuthorizedTicket(tenant, ticketId)` |
| AI source implementation | Local source in ticket API | Local ticket lookup plus caller/team access check; returns a narrow text projection |
| AI results | `JsonAiAnalysisRepository` | `ai-analyses.json`; completed classification/summary with execution metadata |
| Other recommendations | Priority and resolution services/endpoints | Separate on-demand results; not a persisted combined triage run |
| Execution tracking | `AiExecutionLogger`, runtime console logger | Task metadata exists; no durable all-status run/event repository |
| Knowledge | Permission-filtered lexical retrieval | Default policies admin-only; no connected verified historical-ticket source |
| Routing / SLA insight | No AI routing or SLA-insight component found | Faith's evaluation service/repository exists; AI consumption is missing |

Current intake is not the requested complete Jira integration. It trusts the authenticated
webhook's issue fields without an authoritative REST fetch. It stores a mutable local
ticket and deliberately preserves internal workflow status separately from Jira status.
Local PATCH/comment/status operations do not write back to Jira. This conflicts with the
new requirement that Jira own lifecycle changes and must be resolved with Fhulu.

Current timestamps are local ingestion/update times, not Jira creation/update times.
The importer does not map Jira product/service custom fields or retrieve attachments.
Existing issue-level deduplication is not durable event/job idempotency, does not reject
older revisions, and does not prevent two AI runs for duplicate deliveries. Integration
identity/site is also absent, so multiple Jira sites can collide on issue/project IDs.

Four existing Jira-focused tests passed using synthetic payloads: source/internal status
separation, idempotent intake/updates, rejected secrets/reporters/events and configuration
validation. No live Jira read, webhook registration or writeback was attempted.

## 2. Proposed component responsibilities

```text
Jira / JSM
  -> authenticated webhook receiver                         [integration owner + Thuto]
  -> durable JSON event inbox                              [integration owner]
  -> trusted scoped worker -> Jira REST adapter             [Fhulu/team-approved owner]
  -> validate remote identity/project/access/revision
  -> minimal authorised snapshot + TicketAnalysisRequested
  -> Wandile AI coordinator -> existing classifier/summarizer/runner
                           -> priority / approved retrieval / resolution
                           -> permitted routing data / Faith verified SLA evaluation
  -> AI run/result repositories -> authorised review API
  -> explicit reviewed action -> approved Jira action service [Fhulu + Thuto]
  -> audit + reconciliation -> Jira acknowledgement/event
```

The diagram is a proposal. Do not move Jira management into `modules/ai` or mount a
static development principal as integration authorization. Jira client HTTP/authentication
belongs behind infrastructure; ticket applications own ticket semantics; Wandile consumes
their approved ports. LLM adapters remain independent of Jira adapters.

Retain existing manual-ticket behavior while the team approves a source-specific mode:
for Jira-backed tickets, reads use a bounded authorized projection, and proposed lifecycle
changes become governed Jira commands. Successful Jira outcomes reconcile the local
projection. This change must not silently alter existing manual ticket workflows.

## 3. DTO mapping and source interface

The existing port returns exactly the usable core:

```typescript
interface AuthorizedTicketAnalysisSource {
  getAuthorizedTicket(tenant: TenantContext, ticketId: string): Promise<TicketAiView | null>;
}
// TicketAiView: { id, organisationId, title, description: string }
```

Use a stable internal ticket-reference ID for `id`, not the display Jira key. Fhulu's
application service can implement this port by obtaining an authorized Jira snapshot and
projecting it to `TicketAiView`. Both service-credential remote visibility and caller/job
access must be enforced; a broad integration credential does not grant every reviewer access.

Proposed companion envelope, subject to agreement (not a replacement for the current port):

```typescript
type TicketAnalysisEnvelope = {
  ticket: TicketAiView;
  source: {
    system: 'jira'; integrationId: string; siteId: string;
    issueId: string; issueKey: string; projectId: string; projectKey: string;
  };
  product: string | null;
  affectedService: string | null;
  jiraStatus: { id: string; name: string };
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  fetchedAt: string;
  snapshotHash: string;
  warnings: string[];
};
```

| Jira input | Internal mapping / treatment |
| --- | --- |
| Integration registration | Trusted `integrationId`, site and tenant binding; never infer trust from a payload URL |
| `issue.id`, `issue.key` | Source reference; issue ID stable within the site; key may change |
| `fields.project.id/key` | Verify against registered site/project allowlist after REST fetch |
| `fields.summary` | Required bounded `ticket.title` |
| `fields.description` | Validate and convert rich text into bounded plain text; missing becomes empty text plus warning |
| `fields.reporter.accountId` | Ticket domain resolves requester mapping; do not forward identity/contact details to the LLM by default |
| Approved custom field IDs | Product/service only; mapping is per Jira configuration, not guessed from display names |
| `fields.status.id/name` | Jira-owned status reference, separate from any approved internal SLA category mapping |
| `fields.priority.id/name` | Existing source priority; do not automatically equate it with P1-P4 or the internal SLA priority |
| `fields.created/updated` | Original timestamps, separate from fetch/processing timestamps |
| Authorized attachments | Optional governed evidence-ingestion path, not raw binary/URLs in the initial AI request |

The current narrow projection can remain unchanged for classification/summary. Store
source provenance alongside a run and make any envelope expansion additive/versioned.
All components in one run must refer to the same snapshot/hash; do not silently analyze
different revisions when priority/resolution services independently re-read a ticket.

## 4. Missing shared contracts

These are proposed contracts, not approved interfaces or filenames:

| Contract | Required agreement |
| --- | --- |
| Integration registration | Deployment type, site/base URL allowlist, credential reference, tenant/project binding, field/requester/team mappings |
| Authorized ticket snapshot | Caller/job access, minimal projection, source timestamps/revision and snapshot consistency |
| Integration processing identity | Scoped service principal, who initiated a job, permission rechecks and revocation behavior |
| Event inbox / ticket-analysis request | Event identity, validated source, durable acceptance, revision, retries, deduplication and recovery |
| AI run repository | Pending/running/completed/partial/failed states; component outcomes and source/prompt/config/policy versions |
| Routing input | Permitted teams, approved routing rules and available verified workload data |
| SLA insight input | Faith's authorized evaluation ID, policy version, evaluated time and freshness; no LLM deadline calculation |
| Recommendation review | Reviewer authority, recorded decision, proposed source snapshot and changes |
| Approved Jira action | Allowlisted field/transition, expected source state, actor/reason/approval, dispatch status and safe reconciliation |

## 5. Webhook and Jira API requirements

First confirm Jira Cloud versus Data Center and Jira versus JSM. Do not apply Cloud
authentication/signature instructions to a different deployment by assumption.

For supported signed Jira Cloud admin webhooks, configure a high-entropy webhook secret
and verify `X-Hub-Signature` using the original request-body bytes and the agreed supported
algorithm, with constant-time comparison. Apply raw-body capture before `express.json`
changes the representation. Reject malformed/unsupported signatures and payloads before
processing. Atlassian documents signed admin webhooks and signature verification in its
[webhook guide](https://developer.atlassian.com/cloud/jira/platform/webhooks/).

The existing URL secret is a bearer-style credential, not payload authenticity verification.
Current API documentation describes it as the initial design. More urgently, `app.ts`
logs the request pathname and `config/logger.ts` serializes it without redaction, so the
current secret-bearing webhook path can leak through application access logs. Fix with
Thuto/Fhulu before public exposure; rotate any exposed secret. Do not bypass authentication.

Resolve the tenant from trusted integration registration, then validate the received and
fetched project/site against that registration. The existing globally keyed project mapping
cannot distinguish two Jira sites using the same project key. Never follow arbitrary
payload `self` or attachment URLs with integration credentials.

Persist a receipt before returning a success acknowledgement; perform REST/LLM work
outside the webhook response path. Use both delivery deduplication and semantic job
deduplication. Jira Cloud supplies `X-Atlassian-Webhook-Identifier`, which is site-scoped
and stable across retries; it is not an authorization credential. Combine it with trusted
integration identity. Coalesce repeated events for an unchanged normalized snapshot.
See the same [webhook guide](https://developer.atlassian.com/cloud/jira/platform/webhooks/).

Fetch the issue through an approved read-only integration identity and explicit field list.
Respect project/issue security as documented by the [issue REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).
Do not infer local caller access merely because a service account can fetch the issue.
Agree delegated access versus an approved local ACL mirror, including restriction refresh.
Use timeouts, bounded backoff, rate-limit handling, safe error codes and failed-job recovery.
Refetch current state for out-of-order events; suppress duplicate analysis by current
snapshot hash and pipeline/config version. Do not assume Jira's updated timestamp is a
universally reliable compare-and-swap token for every mutation endpoint.

For development, start with a mock adapter. If real polling is approved, use bounded,
project-filtered, paginated JQL queries with an overlap window and persisted watermark;
deduplicate before jobs, and advance only after durable acceptance. Cloud's documented
[enhanced JQL search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
supports pagination. Polling uses the same authorization and normalization path, not an
unauthenticated substitute webhook.

## 6. JSON persistence, review and writeback

Keep `ai-analyses.json` and existing history compatible. The current validator requires
exactly two completed classification/summary task entries, so a seven-component workflow
must not simply append more executions to that format. Add a versioned aggregate/run
repository or a reviewed migration. Do not silently rename the file to the conceptual
`ticket_ai_analyses.json` or create a second competing analysis history.

Proposed additional logical repositories cover integration receipts, analysis requests,
AI runs/executions, review decisions and approved-action delivery/audit. Names and schemas
need ownership approval. Persist bounded necessary snapshots/references and sanitized
errors, not a Jira database replica or full webhook/attachment archive. Explicitly agree
retention and access. Execution records should survive failure before the full result is saved.

Use existing JSON envelopes, schema validation, atomic replacement and locks. Multiple
collections are not transactional: define stable IDs and recoverable state transitions,
so a persisted receipt with a missing job can be repaired after restart. Avoid holding
collection locks during remote Jira/LLM requests. No database, new backend runtime,
external queue or LangGraph checkpoint store is proposed.

AI produces suggestions only. A separate action service reauthorizes an explicit human
decision, re-fetches source state, rejects stale approvals, checks target field/transition
and performs only the approved Jira command. Record actor, reason, approval/run IDs,
timestamps, source revision, before/after values and sanitized Jira outcome/correlation.
An ambiguous timeout after sending a write is `unknown`: reconcile with Jira before retrying.
Do not blindly retry non-idempotent comment creation or assume all Jira endpoints accept
an idempotency key. Persist failed attempts without marking them successful.

Internal JSM comments need explicit visibility handling: the
[JSM request API](https://developer.atlassian.com/cloud/jira/service-desk/rest/api-group-request/)
distinguishes public/internal access. AI must not publish customer comments, close tickets
or update protected fields. Jira assignee is not automatically the same as an internal team;
team fields and permitted users require approved mappings.

Prevent writeback loops using approved action IDs, reconciliation state and relevant-field
snapshot hashes. A webhook is not human approval. Avoid blanket exclusion of every event
by an integration account; genuine changes may still need reconciliation. AI failures change
only AI processing state, never delete or corrupt Jira issues.

## 7. Team boundaries

| Owner | Responsibility |
| --- | --- |
| Thuto | Identity, integration/job principals, tenant/site binding, permissions, shared configuration, credential/log handling |
| Fhulu + team-approved integration owner | Jira intake/read/sync adapter ownership, ticket/source DTO, lifecycle authority, requester/team mappings, authorized ticket snapshot and approved actions |
| Olerato | Approved policy/knowledge visibility, evidence provenance, document/attachment governance and verified historical-resolution admission |
| Faith | Verified SLA evaluation, original event timestamps, Jira-status/priority/calendar mapping and reporting semantics |
| Wandile | Reuse classifier/summarizer/runner; read-only AI coordination, recommendations/retrieval, versioned AI-run persistence and evaluation |

Faith's current evaluator reads local priority, ingestion timestamps and internal transition
history. Jira source status/priority are not automatically applied to those inputs. The team
must define authoritative Jira timestamps, eligible response events, pauses and status/priority
mapping before describing an SLA insight as verified. Missing/stale evaluation is an explicit
unavailable insight, not an invitation for the LLM to calculate deadlines.

## 8. Incremental implementation and approval gates

1. Agree Jira deployment/site, source-of-truth policy, integration owner, identity/security
   mechanism and minimum data/field mappings. Record an ADR; preserve existing manual mode.
2. Approve snapshot, job and service-principal contracts jointly with Fhulu/Thuto. Wandile
   then implements only AI-owned mock-source tests for the existing classifier/summary flow.
3. Integration owner adds read-only Jira fetch/normalization behind a mock-tested adapter;
   Thuto reviews authorization and removes secret-path logging. No writeback in this step.
4. Add durable event receipt/recovery and a single classification/summary job per revision.
   Prove duplicate/reordered events, denied projects, restarts, rate limits and provider errors.
5. Add versioned AI-run provenance and authorized review. Keep existing analysis endpoints
   and repository compatibility. Recheck access on read and before execution.
6. Add existing priority/retrieval/resolution components incrementally. Record unavailable
   approved evidence honestly; history sources and active priority mapping remain approvals.
7. Add routing only with approved eligible-team data, and SLA insight only from Faith's
   fresh authorized evaluation. No assignment or status change from the AI path.
8. If dependency changes are approved, wrap existing AI calls in the smallest LangGraph
   orchestration graph. Jira auth/intake/writeback stay outside the graph; no checkpoints.
9. Separately approve and implement the audited human-action/writeback/reconciliation path.
   Test stale decisions, denied fields/transitions, comment privacy and webhook loop prevention.

Decisions before dependent coding: integration owner; Cloud/Data Center and JSM choice;
site/project tenancy; credential/delegation model; original timestamp and revision semantics;
minimal projection/retention; reporter mapping fallback; field/priority/status/team mappings;
event/run schemas and recovery; review/action authority; permitted internal comments;
approved external AI data; LangGraph dependencies. Do not block a mock AI-only slice on
unrelated writeback decisions, but do not silently choose those decisions either.

## 9. Documentation changes requiring owner review

- Implementation guide: amend architecture, Phase 3/5, team allocation, ticket-to-AI/SLA
  flows and shared-contract decisions for Jira lifecycle authority and async intake.
- `docs/api/API-Specification.md`: replace obsolete URL-secret-only guidance, define signed
  delivery/raw-body verification and async acknowledgement/status behavior, document Jira-backed
  read/update rules, analysis provenance and reviewed-action errors. Remove outdated static
  development-principal instructions where integrated Keycloak is required.
- Existing ticket source/JSON schema documentation: add integration/site identity, original
  Jira times, freshness and source-specific mutation rules through a compatible migration.
- AI module guide: distinguish the two-task service from the proposed composite workflow;
  show unavailable routing/history/SLA capabilities explicitly and record pipeline versions.
- Deployment/operations/Postman: document webhook registration, HTTPS reachability, credential
  rotation/log redaction, retries/reconciliation and synthetic mock/polling instructions.

No shared document or code was edited to declare these proposals approved. This assessment
is the only new file for this task. Test log: ignored `backend/.local-data/jira-assessment-tests.log`.
