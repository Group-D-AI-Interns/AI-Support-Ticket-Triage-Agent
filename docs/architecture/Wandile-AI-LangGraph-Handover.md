# Wandile AI and LangGraph handover

Date: 2026-11-19. Scope: Wandile-owned AI implementation against the current backend guide.
The user explicitly approved including LangGraph. Thuto owns Keycloak, identities, shared
authentication and role capabilities; none of that configuration was edited for this work.

## Outcome and execution flow

The existing `TicketAiAnalysisService`, classifier, summarizer, provider-neutral interface,
execution runner and validators are preserved. The service now delegates ordering to a
small typed LangGraph graph. The existing `/tickets/:id/analyze` API reaches it through the
same runtime factory and existing authorization. No ticket API code was changed.

```text
Existing HTTP permission checks / trusted job caller
  -> authorized ticket source -> detached narrow ticket snapshot
  -> LangGraph classify node -> existing classifier / runner / provider
       invalid output -> invalid branch -> safe failure, no successful analysis
       provider failure -> execution_failed branch -> safe failure
       success -> summarize node -> existing summarizer / runner / provider
         invalid/failure -> corresponding terminal branch
         uncertainty/missing information -> review branch
         complete information -> complete branch
  -> safe workflow-run metadata
  -> compatible classification/summary analysis history
```

An uncertain classification still gets summarized, preserving the existing two-component
analysis contract. Transport `status: completed` means an analysis was produced, not that
it is sufficient or approved. Inspect `orchestration.status` and existing result warnings.
Invalid model output still fails existing validation; it is never coerced into success.

Graph state contains only ticket projection, configured categories, information to collect,
classification, summary, execution metadata, warnings, failure code and node trace. Roles,
tokens, permissions and ticket mutation tools are absent. Nodes call injected components;
LLM output cannot choose arbitrary nodes or permissions. Ticket inputs and returned source
data remain untrusted, and existing citation/prompt boundaries remain in use.

Snapshots and configuration are detached per invocation. Each run has a run ID, snapshot
hash, configuration hash, workflow/prompt versions and timestamps. Bump each component's
exported prompt version when its instructions change. Concurrent invocations are
isolated. No LangSmith tracing was configured, no LangGraph server was deployed, and no
checkpointer/store was attached. Transitive checkpoint packages are library dependencies,
not an approved or enabled checkpoint storage design.

## Dependencies and compatibility

Added exact runtime dependencies to `backend/package.json` and its lockfile:

- `@langchain/langgraph` 1.7.5
- `@langchain/core` 1.4.2
- `zod` 4.6.7

Installed on Node 22.19.0; package engine requirements fit the current Node/TypeScript/ESM
architecture. No new runtime, database, storage backend or provider SDK was introduced.
Installation reported zero audit vulnerabilities. Teammates should run `npm ci` after merge.
The graph follows the documented [StateGraph/state/conditional-edge API](https://docs.langchain.com/oss/javascript/langgraph/graph-api).

## Application persistence

`ai-analyses.json` remains compatible with legacy records. New records optionally include
`orchestration` metadata, validated on read/write. It still stores exactly the existing
classification and summary task results; extra workflow components are not appended to
its two-execution schema.

`ai-workflow-runs.json` is a separate schema-versioned JSON envelope containing tenant,
ticket, initiating user, run/configuration/snapshot references, trace, terminal outcome,
successful task metadata and safe failure identifiers. It does not store ticket body,
prompt, credentials or raw provider errors. The existing locked atomic JSON store is reused.
Invalid/provider-failed graph outcomes are recorded before the service returns its existing
safe AI error. Denied ticket access does not start a graph or create a workflow record.

`listWorkflowRuns` rechecks ticket access before reading metadata. No new public route was
added; Fhulu can expose it through an approved API contract later. Repository-level methods
are internal ports, not an authorization layer. Existing custom repositories remain compatible
because workflow methods are optional; production adapters should implement them, as the
current JSON adapter does. In-memory factories retain isolated in-memory history.

Run metadata and final analysis writes are separate collection writes, not a transaction.
A result-save failure may leave a terminal run without an analysis record. Durable queued
jobs/recovery and aggregate recommendation/reviewer-outcome persistence remain a separate
integration increment. New optional triage outputs are returned to the caller, not silently
written into a new unapproved aggregate format.

## Teammate updates and capability ports

Both runtime factories expose `createTriageService(capabilities)`. It authorizes a ticket
through `AuthorizedTicketAnalysisSource`, fixes one snapshot, runs core analysis, and then
composes optional read-only capabilities. Core failures stop the run; optional upstream
failures produce safe component failure codes without corrupting core history.

| Input | Owner / adapter responsibility | AI behavior |
| --- | --- | --- |
| `AuthorizedTicketAnalysisSource` | Fhulu: enforce caller/team/source access and return current minimal text | Reload on every run; same snapshot used by all ticket components |
| Categories / information to collect | Server-owned approved configuration | Supplied every run; configuration hash captures the actual snapshot |
| `AuthorizedKnowledgeSource` | Olerato: return only caller-permitted approved content | Reload each run; filter tenant/status/effective dates before lexical ranking |
| `AuthorizedRoutingSource` | Team/Fhulu/Thuto: permitted teams and approved effective category-routing rules | Recommend only an unambiguous eligible team, with rule/version evidence; never assign |
| `VerifiedSlaInsightSource` | Faith: authorize evaluation and explicitly verify current policy/input freshness | Pass through verified engine metrics; stale/missing is explicit; never infer deadlines |
| Existing `PriorityRecommender` | Approved AI priority preview configuration | Reuse strict ticket citation validation and deterministic matrix |

The ports in `team-capability-ports.ts` are AI-side adapter contracts for review; they do
not change teammate modules or confer access rights. Adapters must not return all teams,
all policy documents or a latest-by-date SLA result without checking actual caller scope
and relevance. The existing policy source remains administrator-only; support-agent AI
permissions do not automatically grant policy-document access.

Within a triage run, permitted knowledge is captured once so evidence and resolution use
the same content versions. A later run sees source updates/revocations. No global content
cache, automatic Git merge, branch polling or permission bypass is introduced. When teammates
merge their work, implement/wire the agreed ports and run contract tests; AI components need
not be rewritten. Actual push/event-triggered reanalysis still needs the shared job contract.

`CapabilityResult.status` reports invocation outcome (`completed`, `unavailable`, `failed`).
Also inspect `data.status`: a completed invocation may correctly return insufficient evidence
or an unavailable verified SLA. A failed knowledge source propagates failure codes to dependent
retrieval/resolution rather than pretending the source was empty.

## Provider-backed document extraction

`ProviderDocumentExtractionAdapter` now implements Olerato's existing `ExtractionAdapter`
interface from inside Wandile's module. It reuses the runner and provider abstraction.
It requires explicitly configured rule types, descriptions and Zod payload schemas. There
is no universal policy schema, invented business target or production default allowlist.

The provider sees bounded plain text and rule schemas, not tenant/user/document identifiers.
Output must match a strict shape. Payloads are validated against their configured schema;
quotes must occur in the original text. Document/version/execution provenance is supplied
by trusted code, and page/section evidence is attached only when its segment is unambiguous.
All extracted rules require human review, including high-confidence ones. Null confidence
becomes an explicitly uncertain candidate. Safe retryable/terminal failures follow the
existing batch envelope. Exact quotations do not prove semantic correctness of a rule;
candidate review and evaluation are still required.

Olerato's default document processor remains unchanged and still uses the provisional adapter.
Her integration step is to agree the actual payload schemas and provider/data policy, then
inject this adapter through the existing processor/worker dependencies. No interface redesign
is needed; an explicit `ExtractionAdapter` annotation keeps composition clear. No automatic
policy activation, ticket mutation, assignment, closure, customer comment or Jira writeback
was added. PDF/DOCX/TXT conversion remains a separate existing component; OCR is not added.

## Verification

- Baseline: 154 tests passed before orchestration changes.
- Full verification: 171 tests passed, 0 failed; typecheck/build and live-script typecheck passed.
- Existing core AI service/API compatibility tests passed through the graph.
- Focused tests cover graph routes, provider failures/timeouts, denied access, Unicode-safe
  evidence handling, source updates, concurrent isolation, legacy JSON compatibility and
  tenant-filtered workflow metadata.
- Adapter tests cover approved/expired/foreign/ambiguous routing, verified/stale/foreign
  SLA data, exact document evidence, malformed payloads/types/provenance and safe failures.
- Live synthetic Inception mercury-3 check passed for graph classification/summary, priority,
  cited resolution and provider-backed document extraction. Routing used explicit synthetic
  approved rules. SLA was correctly unavailable without Faith's real adapter. The core graph
  took the review branch because the summary requested information; recommendations remain
  suggestions even when individual components return a recommendation.
- Live synthetic Groq `openai/gpt-oss-120b` classification/summary also passed through
  the graph, using process-only provider selection; environment files were unchanged.
- Final focused verification passed all 17 AI tests after prompt-version and knowledge
  snapshot hardening. The live smoke script also passed its standalone TypeScript check.
- No live customer documents/tickets were sent. No live Keycloak/Jira setup was needed.

From `backend/`:

```powershell
npm ci
npm run typecheck
npm run build
npm test
node --env-file=.env --import tsx scripts/test-live-ai-workflow.ts
```

The last command makes explicit live calls (usage may apply), uses synthetic identity,
ticket/document/knowledge/routing inputs and temporary JSON data, verifies the resulting
run record, and deletes its temporary directory. It is not proof of real teammate source
integration, production readiness, model accuracy or real-user Keycloak permissions.
An already-running backend must restart to load the new orchestration code. Normal startup
keeps all existing authentication and AI environment guards.

## File record for this increment

- Dependencies: `backend/package.json`, `backend/package-lock.json`.
- Core: `ai/authorized-ticket.ts`, `ai/ticket-analysis.graph.ts`, `ai/workflow-run.ts`,
  `ai/contracts.ts`, `ai/ports.ts`, `ai/ticket-ai-analysis.service.ts`, `ai/json-ai-analysis.repository.ts`.
- Prompt version metadata: `ai/components/ticket-classifier.ts`, `ai/components/ticket-summarizer.ts` (implementation logic preserved).
- Composition: `ai/live-ticket-ai-runtime.ts`, `ai/local-demo-runtime.ts`,
  `ai/ticket-ai-triage.service.ts`, `ai/team-capability-ports.ts`, `ai/team-recommendations.ts`.
- Extraction: `ai/provider-document-extraction.adapter.ts`.
- Tests: `tests/ticket-analysis-graph.test.ts`, `tests/ai-team-capabilities.test.ts`,
  `tests/provider-document-extraction.test.ts`.
- Live test: `scripts/test-live-ai-workflow.ts`.
- Existing verifier: `scripts/verify-project.ts` capability labels updated to distinguish
  the implemented document adapter from default document-path wiring.
- Documentation: AI `README.md`, this handover.

AI paths above are relative to `backend/src/modules/`; test/script paths relative to
`backend/`. Earlier priority/PDF verification and Jira-assessment changes in the working
tree were preserved and are not new changes from this increment.

Remaining external dependencies: Fhulu's Jira/job/review API wiring, Thuto's real identities
and capability authorization, Olerato's governed sources/extraction wiring, Faith's fresh
evaluation adapter and agreed routing data. Historical-ticket RAG, persistent semantic
indexing, queued retries, reviewer decisions and full aggregate triage persistence must not
be described as complete merely because their AI-side ports or provider adapters work.
# Ticket/document integration update — 2026-11-20

Full triage is now exposed at `POST /api/v1/tickets/:ticketId/triage` with `{}`.
It requires both AI-review and resolution-review permissions plus existing ticket scope.
`GET /api/v1/tickets/:ticketId/ai-runs` exposes authorized workflow metadata.
Core analyses and run metadata persist; aggregate optional recommendation history remains future work.

The main server now forwards candidate-review routes to the existing secured handlers.
Administrators can upload a TXT/PDF/DOCX file, call
`POST /api/v1/documents/:documentId/extract-rules`, inspect candidates through
`GET /api/v1/extracted-rules`, then approve or reject individual candidates.
Live AI configuration selects the provider-backed extractor for this explicit extraction
command; demo/offline mode uses provisional extraction. The existing `/process` behavior
is preserved. Extraction creates draft candidates, not an active knowledge publication.

After reviewing candidates, an administrator explicitly calls
`POST /api/v1/documents/:documentId/publish-knowledge` with `ruleIds`, `reason`,
`effectiveFrom`, optional `effectiveTo`, and `visibility` (`administrators` or `support_staff`).
The service checks actual approval records, current source/version, checksum and quotations.
Publication records a full version approval, activation and audit event. Sharing with
support staff exposes only selected approved excerpts to permitted reviewers, while original
documents and candidate-management endpoints retain administrator access requirements.
Publishing a later restricted version removes staff retrieval access on subsequent requests.

Extraction jobs use the current source version and job-specific claims. Stale provider
output cannot replace a newer document revision. Failed jobs require explicit retry;
`GET /api/v1/documents/:documentId/extractions` exposes their safe status metadata.
Concurrent review approval writes are locked. Windows transient atomic-rename failures
are retried within the existing storage timeout without deleting the original collection.
The Jira intake URL secret is redacted from application access logs.

Import `postman/AI-Triage-Ticket-Document.postman_collection.json` in Postman.
Set `baseUrl`, `organisationId`, `adminToken`, `requesterToken`, and optionally `agentToken`
locally. Follow folders in order; select a file for the multipart upload. Inspect the
candidate before manually choosing approve or reject. Do not run all review actions
unattended. Agent success requests require actual active team/ticket access.
Disabled priority preview correctly returns 503 until explicitly configured.

Verification: 176 tests passed before this resumed session. A live synthetic HTTP smoke
test passed upload, provider extraction, simulated administrator review/publication and
support-agent LangGraph triage using the actual governed knowledge source. Provider
results still identified missing information; passing integration does not guarantee a fix.
Repeat with `node --env-file=.env --import tsx scripts/test-live-document-ticket-integration.ts`
from `backend/`. This sends synthetic data to configured providers and removes its temporary
records. Real Keycloak configuration and real user onboarding remain Thuto's responsibility.
Jira REST synchronization, automatic job scheduling, real routing rules and Faith's verified
SLA adapter remain separate integrations. No Jira issue mutation was introduced.

