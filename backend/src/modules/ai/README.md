# Ticket AI integration

The existing `TicketAiAnalysisService`, classifier, summarizer, execution runner,
provider-neutral interface and output validators are retained. LangGraph now orchestrates
classification and summarization with explicit review, invalid-output and failure routes.
Existing TypeScript output validators remain authoritative; Zod validates new graph/run
contracts and configurable document-extraction payloads.

## Integrated request flow

1. The shared application verifies the bearer token and resolves active stored tenant membership.
2. It derives team scope from server-side team memberships. Static development principals are disabled on this path.
3. The ticket adapter applies existing requester/team/administrator visibility before returning only the AI ticket projection.
4. LangGraph invokes the existing classifier and summarizer using their execution runners and provider adapters.
5. `JsonAiAnalysisRepository` validates and saves the combined analysis to `ai-analyses.json` using locked atomic JSON writes.
6. History reads re-check ticket access, so revoked membership/team access cannot read prior analyses.
7. A separate `ai-workflow-runs.json` records graph outcomes and safe execution metadata,
   including invalid/provider-failed runs. This is application history, not checkpoint storage.

Use `POST /api/v1/tickets/:ticketId/analyze` with `{}` and
`GET /api/v1/tickets/:ticketId/analyses`. Both require a bearer access token and
`X-Organisation-ID`. Analysis is synchronous and does not mutate ticket records.
The shared server defaults to port 3000. See the root README for Keycloak setup.

## Local demonstration

Set `APP_ENV=development`, `TICKET_AI_DEMO_ENABLED=true`,
`TICKET_AI_LIVE_ENABLED=false` and a JSON `TICKET_AI_CATEGORIES` array of objects
with `id`, `name` and optional `description` fields. Demo results are deterministic
keyword/extractive output with null confidence, mandatory review and `DEMO_ONLY`
warnings. This is not real-model inference.

## Live providers

Set `APP_ENV=development`, `TICKET_AI_LIVE_ENABLED=true`,
`TICKET_AI_DEMO_ENABLED=false`, categories and the task selectors
`TICKET_AI_CLASSIFICATION_PROVIDER` / `TICKET_AI_SUMMARIZATION_PROVIDER` to `groq`
or `inception`. Use the provider/model/token-limit/timeout/retry variables described
in `.env.example`. Credentials belong in the process environment, never Git.
Startup does not automatically load `.env`.

Inception transient failures use bounded retries/backoff before Groq fallback. Groq
credentials are required for fallback. The outer runner does not add another retry
loop. Structured outputs still pass the existing validators. Live mode sends ticket
title and description to external providers; it remains opt-in and development-only.
Provider tests mock HTTP responses and do not verify live model quality/availability.

## Persistence and unfinished work

The integrated application injects durable history into both runtime modes. Standalone
`createTicketApp` and runtime factories retain in-memory defaults for existing focused
tests/isolated demos. Do not use those standalone defaults as the production entry point.

The AI-owned `ProviderDocumentExtractionAdapter` now implements the existing document
batch port, validates configured payload schemas and exact quotations, and requires human
review. Olerato's default processing path still uses the provisional adapter until she
approves schemas and wiring; TXT/PDF/DOCX text conversion is separate from model extraction.
Mistral embeddings remain an adapter, without a persistent semantic index. Real historical
sources, background jobs, durable aggregate triage/reviewer outcomes and broader model
evaluation remain further work. No checkpoint persistence is enabled.

`runtime.createTriageService(capabilities)` composes the core graph with existing priority,
retrieval/resolution and optional routing/SLA sources. Each run reloads authorized upstream
data. Missing sources are explicitly unavailable, and upstream failures remain visible.
Routing recommends from approved eligible-team rules; SLA insight consumes Faith's verified
evaluation and never calculates deadlines with an LLM. This factory is an internal integration
entry point; the existing `/analyze` endpoint continues to expose core classification/summary.

See [the LangGraph handover](../../../../docs/architecture/Wandile-AI-LangGraph-Handover.md)
for ports, ownership, execution flow, changed files, verification and remaining dependencies.
Keycloak, roles and shared authentication configuration remain Thuto's responsibility.

## Default verified SLA integration

Full `/tickets/:id/triage` now connects `FreshVerifiedSlaSource` to Faith's existing
`SlaEvaluationService`. For callers with `configuration.manage` (the current permission
used by the SLA APIs), it evaluates only the authorized ticket at request time and stores
the result through Faith's repository. The LLM does not calculate SLA deadlines or select
priority, policy, calendar, pause evidence or response evidence.

The adapter checks the ticket snapshot before evaluation, rechecks ticket revision/access
afterwards and confirms the applicable policy/version. Changed inputs yield a stale result
without exposing outdated metrics. Missing priority/applicable policy yields unavailable;
engine errors yield a safe failed component while core analysis can still succeed.

Inspect `data.sla.status` for invocation outcome and `data.sla.data.status` for
`available`, `unavailable` or `stale`. An available result contains
`evaluation.result.metrics.firstResponse` and `resolution`, with Faith's deadlines,
remaining minutes, state and explanations. AI priority recommendations are not applied
automatically: a permitted human must set the ticket's internal priority with override
evidence, and a verified effective SLA policy must exist.

Support-agent/lead access is not widened by this integration. The existing SLA APIs are
administrator-restricted; those callers receive unavailable unless the team's permission
design is changed by its owner or an approved scoped adapter is explicitly injected.

Test the AI alone with synthetic data and existing provider credentials:

```powershell
node --env-file=.env --import tsx scripts/test-live-ai-workflow.ts
```

This opt-in test invokes real providers for graph analysis, priority, cited resolution and
document extraction, using fixture routing/knowledge and isolated temporary JSON history.
It does not configure Keycloak/Jira or activate any policy; provider usage may apply.

Lexical evidence retrieval and cited resolution recommendations are now available through
the API. See [resolution-recommendations.md](resolution-recommendations.md) for connected
sources, permission boundaries, endpoints, tests and the live synthetic smoke command.
The default source combines governed published knowledge and explicitly verified historical
resolutions. Source visibility is checked for the current caller before retrieval and again
when combined history is read. See the completion workflow below.

## Draft priority recommendation component

The independent priority recommendation contract and tests are documented in
[priority-recommendations.md](priority-recommendations.md). It reuses the runner and
provider boundary, validates ticket citations and calculates P1-P4 deterministically.
It is not enabled on existing analysis endpoints and does not change tickets.

## Test live AI without setting up API login

From `backend/`:

```powershell
node --env-file=.env --import tsx scripts/test-live-ai.ts
```

This explicit development smoke test reads provider credentials from the environment,
supplies synthetic ticket/category data, and calls the configured live classification
and summary providers directly through the existing service/runner. It does not start
an unauthenticated API, read real tickets, write application records or require Keycloak.
It overrides demo/live/development flags only in its own process; it does not configure
the regular server or replace tenant membership setup. Calls may incur provider usage.
Request timeouts/retries are capped for this test. Output contains synthetic results and
provider execution metadata, never credentials.

A real Inception mercury-3 classification and summary smoke test passed on 2026-11-19.
The initial request reached the provider but failed output validation; prompts were
corrected to enumerate their exact required JSON keys/types. Validators were preserved.
This verifies connectivity and the output contract for one example, not general model
accuracy, Groq failover or priority inference. The returned summary unnecessarily asked
for further error-message confirmation despite supplied text, so semantic quality still
needs evaluation. The default backend remains protected by Keycloak/membership checks.


## Routing, verified history, reviews and processing jobs

The existing LangGraph core, classifier, summarizer, execution runner and provider adapters
are reused. `operations-service.ts` coordinates AI-owned governance and durable reports;
`operations-api.ts` exposes it through the existing ticket HTTP adapter. No AI endpoint
changes a ticket's priority, assignment, status, permissions or Jira issue.

`operations-store.ts` stores `ai-operations.json` under the configured data directory.
Its versioned JSON envelope contains routing drafts/approvals, reviewed historical resolutions,
combined reports, immutable reviewer decisions, quality runs, jobs and governance audit records.
One atomic ledger lets a job completion and its report commit together. Existing
`ai-analyses.json`, `ai-workflow-runs.json` and Faith's SLA evaluation repository are preserved.
This ledger is application persistence; no LangGraph checkpoints or database were added.

The flow is: authorized ticket projection -> existing LangGraph classification/summary ->
priority/evidence/resolution/routing/SLA adapters -> aggregate report -> human review.
`POST /api/v1/tickets/:ticketId/triage` preserves its previous response and adds `data.triageId`.
`GET /api/v1/tickets/:ticketId/triages` returns durable reports with source evidence,
reviewer decisions and a `staleTicketSnapshot` indicator. If cited source access, versions or
routing approvals have changed, the report is redacted instead of exposing old quotations.
Core analysis history remains available through its existing endpoints.

Administrators create draft category-to-team rules using real configured categories and
existing tenant teams, then explicitly approve them. Draft, disabled, future and expired
rules cannot recommend teams. Multiple eligible teams produce insufficient information.
Agents see only their current eligible teams; administrators see tenant teams. Recommendations
never assign a ticket. No category/team mapping was invented or activated on your behalf.

Historical retrieval uses a separately reviewed resolution, not arbitrary closed-ticket
comments. A lead/admin with current ticket access records the reviewed text, visibility and
reason. The original ticket must have an applicable approved SLA policy, its configured
resolved status and recorded resolution evidence. Organisation-wide visibility additionally
requires configuration.manage and still cannot bypass access to the source ticket. The
verified record is bound to the full ticket revision; edits, reopening, revocation or loss
of access remove it from retrieval. The current ticket is excluded from its own matches.
Retrieval is lexical RAG with cited excerpts; no embeddings or vector database are implied.

A lead/admin may record accepted/rejected/needs_information plus optional classification
correctness and groundedness labels. Decisions are immutable per reviewer/report; repeating
an identical decision is idempotent. Acceptance records a review only. It never applies
recommendations. A changed ticket requires a fresh triage before review.

### Postman and Swagger

Start the backend normally from backend/ with `npm start`. Open
http://127.0.0.1:3000/api/v1/ai/docs for Swagger UI; the complete specification is at
`/api/v1/ai/openapi.json` and in `docs/api/ai-openapi.json`. Swagger assets are served locally
using swagger-ui-dist 5.35.1. Documentation is public; business endpoints retain authentication,
tenant membership, permission and ticket/source checks. This does not change Keycloak.

Import `postman/Wandile-AI-Completion.postman_collection.json`. Set collection variables:
baseUrl, accessToken, organisationId, teamId and categoryId. Use an existing administrator
for governance/evaluation; agent/lead testing uses their own tokens and current team membership.
The numbered folders capture created IDs automatically:

1. Check identity and teams, then create a synthetic ticket.
2. Create a real category-to-team draft and approve it after human agreement.
3. Set historicalTicketId to a DIFFERENT resolved test ticket with recorded resolution
   evidence, verify the reviewed resolution, then retrieve similar tickets.
4. Run full triage, inspect persisted history, record a review and inspect human quality labels.
5. Queue, inspect and manually process a leased job, then inspect its terminal state/history.
6. Run the representative labeled evaluation and inspect its persisted results.
7. Test invalid inputs and withdraw test source/routing approvals. Old cited history redacts.

For step 3, use the EXISTING ticket workflow APIs and tenant-approved transitions. Set a
human-approved internal priority with the required priorityOverride reason and business
justification; ensure an effective approved SLA policy exists. A permitted human transitions
using `PATCH /api/v1/tickets/:id/status` with resolutionEvidence containing outcome, note,
customerConfirmation and customerConfirmationEvidence. Then use the NEW verified-resolution
endpoint. Do not fabricate evidence or bypass those ticket-domain rules just to populate RAG.
The regular team Postman collection and merged ticket OpenAPI describe those prerequisites.

Every request uses Authorization: Bearer and X-Organisation-ID. Request bodies never accept
actor IDs, tenant overrides, permissions or roles. AI history and jobs require both existing
AI-review and resolution-review permissions; human verification/review also requires
tickets.approve. SLA metrics keep the existing configuration.manage restriction. Permission
expansion belongs to Thuto and is not included here.

### Evaluation and limitations

`backend/data/evaluation/triage-v1.json` contains six synthetic access/billing/ambiguous/
prompt-injection cases. POST it to `/api/v1/ai/evaluations` with an administrator token.
Its expected categories must match YOUR server taxonomy; adjust labels deliberately if the
team uses different IDs. Cases are bounded to ten per request. Live mode makes provider
calls; deterministic demo mode measures the heuristic only. Reports retain model/provider,
prompt/execution metadata, dataset hash and per-case outcomes. Accuracy is reported over
successful cases with failures counted separately. Required-fact coverage and prohibited
phrase hits are lexical proxies. Semantic groundedness requires human labels; the
`/api/v1/ai/quality-summary` endpoint aggregates those labels from readable reports.
This starter dataset does not establish production accuracy or universal correctness.

### Background processing contract

`triage-jobs.ts` implements durable queued/running/completed/failed jobs, atomic leases,
current actor/source checks, bounded transient-provider retries and crash recovery.
Manual queue/process endpoints work without enabling automatic intake. Inspect BOTH job
status and individual triage capability statuses: a completed job can contain unavailable
or failed optional capabilities. Failed jobs have a safe errorCode; enqueue a new job
explicitly after correcting a terminal failure. A stale job never analyzes a newer ticket
silently. Completed aggregates have stable report IDs, preventing duplicate final records.
External LLM calls are at-least-once after a crash or expired lease; exactly-once provider
billing is not promised. The five-minute lease suits development; longer provider budgets
need lease renewal/approved deployment tuning before multi-worker production use.

Automatic intake is OFF by default. After agreeing the processing account and provider budget,
configure local environment values explicitly (no secret/Keycloak edits are made here):

```dotenv
AI_AUTOMATION_ENABLED=true
AI_AUTOMATION_ACTORS={"your-organisation-id":"your-active-processing-user-id"}
AI_AUTOMATION_CREATED_AFTER=2026-11-20T00:00:00.000Z
AI_AUTOMATION_INTERVAL_MS=2000
```

Use a deliberate timestamp to bound reconciliation; older tickets are excluded from scanning.
Normal manual/Jira creation enqueues analysis using the configured actor. The opt-in worker
reconciles bounded batches and resumes durable jobs on startup; it re-resolves current
membership/team access on EVERY attempt. Automatic keys include tenant, actor, ticket snapshot
and category configuration. Content changes can produce a fresh run; approved-source/model
updates alone require an explicit new run. No requester token or role snapshot is persisted.
An enqueue/provider failure cannot undo ticket creation. Worker timers start/stop with the
integrated server. One Node runtime and JSON storage remain in use.

Before wider rollout, the team still needs to approve real category/team mappings, reviewed
historical resolutions and visibility, representative evaluation labels/thresholds, processing
actors/budget/timestamp and operational storage retention/worker lease sizing. These are
business/deployment choices; the implementation does not invent approvals.


### Files in this completion change

New AI implementation files under src/modules/ai/: operations-api.ts, operations-service.ts,
operations-store.ts, triage-result-validation.ts, triage-jobs.ts, triage-worker.ts,
quality-evaluation.ts and ai-documentation.ts. Existing local-demo-runtime.ts and
live-ticket-ai-runtime.ts add synthetic evaluation entry points using the same components.

Integration changes: src/modules/tickets/api.ts connects the AI sources, durable reports,
API router and intake notifications; src/app.ts forwards the AI prefix; src/integrated-app.ts
connects worker lifecycle. package.json/package-lock.json add pinned local Swagger assets.
No identity/Keycloak configuration, role catalogue, ticket lifecycle implementation,
document governance rules or SLA engine logic were changed for this completion work.

Tests/fixtures: tests/ai-operations.test.ts, tests/integrated-app.test.ts and
backend/data/evaluation/triage-v1.json. Documentation/artifacts: this README,
docs/api/ai-openapi.json, docs/api/Integration-Verification.md,
docs/architecture/AI_SUPPORT_TICKET_TRIAGE_AGENT_BACKEND_IMPLEMENTATION.md and
postman/Wandile-AI-Completion.postman_collection.json. Existing merge changes and previously
uncommitted SLA integration work are preserved separately; no commit or merge completion
was performed.
