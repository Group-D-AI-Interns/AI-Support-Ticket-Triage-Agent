# Integration and system verification

**Integration snapshot:** `FhuluBranch` at `af6c02c` plus the uncommitted P1–P4 priority contract, ticket/SLA evidence, and ticket OpenAPI contract.

## Summary

The canonical backend is TypeScript. `backend/src/main.ts` starts one server through `backend/src/server.ts` and `backend/src/integrated-app.ts`; it serves the foundation identity/organisation/team APIs and the Express ticket, document, policy, SLA and reporting APIs together.

The integrated ticket API authenticates with the shared Keycloak verifier, resolves active tenant membership server-side, loads active team membership, and applies the shared role-permission policy. The integrated startup does not accept the static development principal.

On 20 November 2026, the local `ai-support` realm was reachable and the integrated API started in Keycloak mode. Realm discovery and API health checks passed. The service-account token passed token verification but received `ACCOUNT_INACTIVE` at application identity lookup because the service account is not an active application user. The support-agent and newly linked support-lead accounts have since logged in through the browser; the supplied support-lead screenshot shows the active role and Support workspace, while the backend `/me` and ticket-list requests returned HTTP 200. Other developers' local realms still require their own verification.

Local role setup was subsequently completed for the newest enabled Keycloak account at the user's direction: it is now an active backend `support_lead` in the active organisation and an active `support_lead` team member on the existing Tier 1 Support team (same team ID; backend display name is `Tier 1 Support Updated`). The backend reports `tickets.read.team` and does not grant `users.manage` to that role. After restart, `/health/ready` returned HTTP 200; the frontend returned HTTP 200. The supplied browser screenshot confirms the support-lead account reaches the Support page.

The support-lead UI now separates the team/unassigned ticket queue from an approval queue. The approval queue reads triage reports only for tickets already returned within the caller's server-authorized ticket scope. It filters redacted, stale, and already-reviewed-by-this-lead reports and records accepted, rejected, or needs-information decisions with a required comment using the existing approval-protected endpoint. Frontend typecheck, lint, and diff check passed; Next.js development compilation and page delivery passed. No local tickets or triage reports are currently available, so the queue is empty. The policy-backed escalation records and lead queue are implemented; automatic percentage-based SLA escalation remains inactive pending tenant approval.

Ticket priority uses the project P1–P4 contract. `support_lead` and `organisation_admin` may change priority with a reason and business justification; the server records the actor, timestamp, and before/after values. Legacy internal labels normalize to P2/P3/P4; legacy external source priority metadata is read-only. The contract does not activate a tenant policy.

SLA response now requires explicit acknowledgement, completed assessment, and first team assignment evidence; resolution requires an evidenced status transition; pause and exclusion intervals are auditable and role-gated. Reopening excludes resolved time without resetting the resolution clock. The reference SLA candidate remains draft because client entitlement, actual targets and calendar definitions are not verified.

The integrated backend now has a combined machine-readable OpenAPI contract at `docs/api/integrated-openapi.json`, generated from the ticket and AI contracts plus implemented foundation, document, policy, SLA, report and extracted-rule routes. Swagger serves it at `/api/v1/openapi.json`; the AI-only contract remains available at `/api/v1/ai/openapi.json`. Rebuild with `npm run openapi:build` from `backend/`.

Ticket classification, summarisation, priority preview and resolution recommendation routes are connected to the integrated API. AI work is opt-in and does not change tickets automatically. Document processing supports TXT, Markdown, PDF and DOCX text conversion. In live ticket-AI mode, both direct processing and policy-bound extraction use the provider-backed adapter; demo/offline mode remains provisional. Extracted rules remain review-required drafts.

Classification now accepts multiple configured category IDs and requires exact source spans from the ticket title or description. Organization administrators can list, add, enable, or disable tenant category records at `/api/v1/configuration/categories`; mutations require a reasoned audit event. An organisation's category records replace the legacy environment category list when present. An empty category list blocks analysis; the system does not invent labels. The support ticket page displays all returned labels, rationale, and evidence excerpts. Category editing/version history and live-provider multi-label quality are not yet verified.

## Six-item checklist

| Item | Status | Evidence / remaining work |
|---|---|---|
| Single application bootstrap | Integrated | One listener serves foundation and Express domain routes; `tests/integrated-app.test.ts` exercises cross-module flows. |
| Authentication and tenant isolation | Integrated; local user flow verified | Local realm discovery and API health passed. An unsigned request received `401`; service-account token received `403 ACCOUNT_INACTIVE`; support-lead browser login showed its active role and Support page, and authenticated `/me`/ticket-list calls returned `200`. |
| Ticket priority contract | Implemented; tenant policy remains inactive | P1–P4 API validation, legacy internal-value normalization, override authorization/evidence/audit, read-only legacy source-priority preservation, and legacy SLA-target compatibility are covered by tests. |
| Ticket/SLA event evidence | Implemented; entitlement and target verification remain | Response evidence, resolution events, pause/exclusion intervals, role restrictions, resolution reopening and overlapping interval accounting are tested. |
| Integrated API contract | Generated combined contract; route spot checks covered | `docs/api/integrated-openapi.json` documents the currently implemented foundation, ticket, AI, document, policy, SLA and reporting routes. `backend/tests/integrated-app.test.ts` verifies representative cross-domain paths are served publicly by Swagger. Automated exhaustive conformance against every route/schema remains pending. |
| Ticket AI | Service and API paths integrated | Demo/live classification and summarisation, priority preview, lexical retrieval and resolution recommendation are permission-gated. AI analysis and recommendations are read-only and require human review. |
| Classification | Implemented with focused synthetic coverage | Multiple configured labels, exact ticket evidence spans, tenant category list/create/enable/disable, audit records, tenant isolation, and UI evidence display. Environment categories remain a compatibility fallback for organisations without category records. |
| Document policy extraction | Provider-backed in live AI mode; review required | Direct document processing and policy-bound extraction share `ProviderDocumentExtractionAdapter` and the approved extraction schemas when live ticket AI is enabled. Demo/offline mode uses the provisional adapter. Provider output remains a draft candidate with verified quotation and document-version evidence; it does not publish policy. |
| Persistence | Shared guarantees integrated | Domain JSON persistence delegates to the validated shared store, preserving schema validation, atomic writes, locking and explicit errors. Multi-file workflows still are not transactional. |
| Organisation creation rule | Implemented | An active organisation administrator can create another organisation and is granted an active `organisation_admin` membership in it; duplicate-name rollback and non-admin denial are tested. |

## Integration risks to close

1. **Verify live extraction configuration per environment.** Live mode is opt-in and development-only. Confirm the approved provider/model and data-handling terms before sending customer documents externally; demo/offline mode remains provisional.
2. **Complete per-developer live auth verification.** This machine's realm discovery, service-account token, and API health checks passed, but no real user's login, active membership, or role access was exercised. Use synthetic ticket/document data and private local credentials; no live LLM provider calls were made.
3. **Harden multi-file workflows.** JSON collection operations are locked, but organisation creation, upload/version, policy approval and extraction result/status changes span files and are not transactional. Organisation creation compensates for a failed organisation write by removing its provisional membership; crash-level multi-file atomicity remains a limitation.

## Checks

| Check | Result |
|---|---|
| `npm ci --prefix backend` | Passed. |
| `npm test --prefix backend` | Passed: 213 tests, 0 failures, 11 suites (20 November 2026). Provider and Keycloak integration tests use mocked HTTP/JWKS. |
| `npm run typecheck --prefix backend` | Passed (20 November 2026). |
| `npm run build --prefix backend` | Passed (20 November 2026). |
| `git diff --check` | Passed (20 November 2026). |
| Local Keycloak realm and containers | Passed: Keycloak and PostgreSQL healthy; `ai-support` discovery returned `200`. |
| Local API auth and health probes | Partial: API startup plus liveness/readiness/versioned health returned `200`; unauthenticated `/api/v1/me` returned `401`; the valid service-account token reached identity lookup and returned `403 ACCOUNT_INACTIVE` because it is not an active application user. |
| `support-admin-service` role mappings | Direct `realm-management` assignments are exactly `manage-users`, `view-users`, and `query-users`. Keycloak's built-in `view-users` composite also contributes effective `query-groups`; no shared Keycloak role definition was changed. |
| Live human-user Keycloak login / tenant authorization | Not verified; requires a real developer user token and active local application membership. |
| Live Groq / Inception / Mistral requests | See dated backend acceptance update below; synthetic live calls ran, with DOCX extraction failing `INVALID_OUTPUT`. |

## Next integration actions

- Olerato/Wandile: verify approved extraction schemas, provider/model and data-handling settings per environment before enabling real-document provider calls.
- Team: verify human-user login and tenant authorization in each development realm.
- AI owners: keep live provider calls disabled in production until external data handling and provider configuration are approved.


## Wandile AI completion checks (20 November 2026)

The combined triage endpoint now persists a report and returns triageId. AI-owned APIs add
approved routing rules, verified historical resolutions, immutable human review/quality labels,
synthetic evaluation runs and leased background jobs. These reuse the existing ticket, knowledge,
SLA, authorization, provider and LangGraph components. No AI ticket writeback or role expansion
is included. The earlier extraction-adapter action above is superseded: provider-backed
extraction already exists and is covered by the document/knowledge integration tests.

Use the dedicated [AI completion Postman collection](../../postman/Wandile-AI-Completion.postman_collection.json)
and [AI OpenAPI](ai-openapi.json). The generated [integrated OpenAPI](integrated-openapi.json) is served at `/api/v1/openapi.json`; a running backend serves Swagger at `/api/v1/ai/docs`.
The [AI module guide](../../backend/src/modules/ai/README.md) documents ordering, prerequisites,
source revocation, review semantics, actor mappings, retries and evaluation limitations.

Focused HTTP tests use signed synthetic tokens, local JWKS stubs, temporary JSON storage and
the deterministic provider. They require no live Keycloak or LLM credentials. Run from backend/:

```powershell
npm run typecheck
npm run build
npm test
```

An automatic worker is disabled unless explicitly configured with an actor mapping and intake
start timestamp. Manual queue/process endpoints exercise the same worker contract without
changing environment flags. Tests establish integration and safeguards; real approved tenant
mappings, reviewed resolutions, provider evaluation results and operational rollout remain
team-owned acceptance work.


Final completion verification:

| Check | Result |
|---|---|
| Full regression suite | 197 passed, 0 failures; 11 suites. |
| Source typecheck and complete TypeScript build | Passed. |
| AI completion Postman artifact | 23 requests; JSON bodies parsed and test scripts compiled successfully. |
| Combined OpenAPI artifact | 33 paths; internal component references resolve. |
| Running backend liveness/readiness | Both 200 at 127.0.0.1:3000. |
| Running Swagger/spec/local bundle | All 200. |
| AI governance endpoint without credentials | 401. |
| Whitespace check | git diff --check passed. |
| Live provider calls for this completion change | None; real tenant/provider acceptance remains manual. |

The full test log is local and ignored: backend/.local-data/ai-completion-final-tests.log.
The backend was started for manual testing. Existing staged development-merge work remains
preserved and the completion changes have not been committed.


## Reliability and pilot hardening ? 20 November 2026

The expanded 12-case live dataset ran twice: 24/24 completed, 24/24 matched their
expected categories, 23/24 completed on the first pass, one recovered through the bounded
core-output regeneration, and zero prohibited phrase hits were observed. Semantic
summary/resolution groundedness still requires human review. These are synthetic sample
results, not a production-quality guarantee. Original failures remain in their prior logs.

The final automated suite passed 206 tests in 11 suites, including a joined HTTP flow from
requester intake through approved fixture routing/SLA, resolution evidence verification,
historical retrieval, triage, review persistence, job processing/idempotency and restart
recovery. Typecheck, build and the new CLI typechecks passed. The running backend was
restarted; health/spec returned 200 and a live evaluation through the updated API returned
201 with the new completion/recovery metrics.

Wandile approved Account Support / ACCOUNT_ACCESS and Billing Support / BILLING for local
testing. These teams and rules were created/approved through authenticated APIs using the
refreshed administrator token. Approval reasons are retained in the AI ledger. The older
synthetic smoke rule remains disabled. No operational SLA/knowledge policy was activated.

Wandile approved a local workload limit of ten automatic jobs per organisation per UTC day
and one attempt per job. Atomic budget reservations and duplicate/retry tests now enforce
those limits; this is not a currency budget. Automatic intake remains disabled pending
processing-account, intake-timestamp, provider-budget and live acceptance decisions.

The actual local organisation still needs a legitimate requester submission, a separately
resolved/reviewed historical ticket, and an approved applicable SLA tier/calendar before
live joined acceptance can pass. No accounts/roles or verified resolutions were fabricated.
See backend/.local-data/ai-pilot-readiness.json and approved-ai-pilot.json for local IDs and
current gates. Those files and token files remain ignored; no tokens were copied into the
Postman environment or source control.


## Faith SLA worker and AI merge verification ? 20 November 2026

Verified merged source 45931be with 209 passing tests in 11 suites, source typecheck,
full build and whitespace checks. The joined HTTP integration fixture now explicitly
enables the real SlaEvaluationWorker and SlaEvaluationService instead of leaving the
worker disabled. Before calling AI/manual evaluation it verifies that a ticket-change
event persists a P2 evaluation with the applicable approved fixture policy version.
It then verifies a later periodic evaluation without further ticket writes or AI calls,
unchanged ticket data, current SLA in AI triage, cited historical resolution retrieval,
review history, queued/idempotent processing, restart recovery and empty results for
the unrelated tenant. The worker logger must remain free of hidden evaluation errors.

The local backend process was confirmed to predate the merge and restarted with the
updated source. Liveness/readiness/versioned health/Swagger/OpenAPI returned 200;
unauthenticated SLA and AI governance requests returned 401. The production-configured
SLA polling default is five minutes, and event-driven writes enqueue evaluation sooner.
SLA background work and automatic AI/provider processing remain separate mechanisms.

The actual local organisation still has zero tickets and zero active SLA versions.
An applicable approved/effective tenant SLA policy and actual internal ticket priority
remain prerequisites for live evaluations. Missing input legitimately yields no evaluation
or unavailable AI SLA insight. Existing configuration.manage restrictions on exposed SLA
metrics remain enforced. No customer SLA policy, role or Keycloak configuration was
changed, and no live LLM request was made for this merge verification.

Local evidence: backend/.local-data/sla-worker-final-verification.log,
sla-ai-worker-joined-test.log and sla-merge-runtime-verification.json. The strengthened
test and this note are uncommitted follow-up verification changes after the last push.


### Additional real-provider checks ? 20 November 2026

Real Inception mercury-3 calls were made using synthetic data. The expanded 12-case
classification/summary set ran twice: 24/24 completed on the first pass with expected
categories and zero prohibited phrase hits. This does not establish semantic groundedness.

A separate isolated integration used the real SLA policy repository, simulated policy
review/activation, Faith's resolver/service/event-periodic worker, durable evaluation
repository, FreshVerifiedSlaSource and live LangGraph components. Classification and
summarization passed, AI received available SLA insight for the expected fixture version,
seven evaluations persisted during the run, and the source ticket stayed unchanged.

The first complete provider workflow failed because a resolution response was rejected
as INVALID_OUTPUT after classification/summary/priority-factor calls had passed. An
independent resolution probe validated its output but returned insufficient_evidence;
the combined SLA run did likewise, requesting missing service desk contact information.
These results must not be described as fully passing resolution acceptance.

The independent live extraction returned a two-hour candidate but omitted the required
top-level warnings array. Strict validation rejected it and the adapter returned failed
with no accepted rules. Validators were preserved. No production prompt/schema/retry
behavior was changed to conceal these outcomes. Groq fallback was not exercised by these
successful Inception calls. The deterministic regression suite remains 209/209 passing;
it does not imply that every live provider response meets the output contracts.

Detailed local evidence: backend/.local-data/sla-merge-live-summary.json,
sla-merge-live-workflow.log, sla-merge-live-capability-probe.json and
sla-merge-live-combined-results.json. Synthetic raw model outputs are local and ignored.


## Backend acceptance update (20 November 2026)

The latest backend changes close two authorization gaps:

- `reports.read.team` now returns only tickets assigned to the caller's active,
  server-resolved teams; associated SLA evaluations are restricted to those tickets.
  Organisation administrators with `reports.read.all` retain tenant-wide aggregates.
- Ticket assignment validates that the target team belongs to the selected organisation.
  Organisation administrators may assign across their tenant; other routing users remain
  limited to their active teams.

The full backend regression suite passes **212/212 tests**. The production TypeScript
build, source type-check and `git diff --check` also pass. The affected ticket API cases
and automatic-intake lifecycle test passed in isolation after the fixture correction.

Follow-up DOCX investigation: local Mammoth conversion of the verifier's synthetic DOCX
produces the expected two paragraphs and segments. The provider adapter receives the same
converted text used by strict schema and exact-quotation validation. Focused converter and
adapter regression tests pass, including rejection of an invented quote with `INVALID_OUTPUT`,
no candidate persistence, and mandatory human review for accepted candidates. No code defect
specific to DOCX conversion, structured-response parsing, or failure handling was reproduced;
the prior live failure's malformed field cannot be identified because its raw model response
was not retained. Validators and prompts were not weakened. The live verifier now reports
PDF and DOCX outcomes separately and exposes only safe status/provider/failure-code details,
so a fresh synthetic live run can distinguish format-specific provider variance. No fresh
live provider run was made during this follow-up.

The full regression suite now passes **213/213 tests** (including the new DOCX regression;
11 suites). The source type-check, complete build, and `git diff --check` pass. This is
deterministic local verification and does not resolve the nondeterministic live DOCX result.

Earlier synthetic live-provider checks found successful Groq/Inception
classification/summarisation, Mistral embeddings, priority preview, and PDF/DOCX
extraction. The latest live verifier re-run on 20 November 2026 confirmed Groq
classification/summarisation, Mistral embeddings, and integrated Inception
classification/summarisation. Priority output passed schema validation but returned
`insufficient_information` with no priority; resolution returned
`insufficient_evidence` with two steps and did not modify the ticket. PDF extraction
returned a validated `response_time` candidate, but DOCX extraction returned
`INVALID_OUTPUT` and the API returned `422`, so the overall live verification failed.
The supplied support-lead browser screenshot confirms login and the role-specific Support landing page; showing populated ticket/approval items awaits local ticket/triage data.
The local DOCX regression does not count as successful live provider extraction. The recorded
live document outcomes remain unresolved until the revised verifier runs with synthetic data.

### Remaining backend acceptance gaps

- **General audit coverage:** `/api/v1/audit-logs` is available to organisation
  administrators and aggregates existing policy/knowledge, AI governance and ticket-history
  records. Identity, organisation and team mutations still do not write to a shared audit log.
- **API contract conformance:** an integrated OpenAPI contract now covers the implemented
  foundation, document, policy, identity, team, ticket, AI, SLA and reporting routes.
  Exhaustive generated conformance against every route and response schema remains pending.
- **Operational controls:** approved public-intake rules and rate limits are not defined
  or implemented. The API and background workers are not yet independently deployable
  production processes.
- **Production file handling:** private object storage, malware scanning, retention and
  recovery policy still require infrastructure and operational decisions. Local file
  storage is not production-ready for uploaded customer documents or attachments.
- **Tenant acceptance:** create/assign approved local tickets and triage reports to verify populated team and approval queues. Do not use the service-account token as an application user.
- **Business configuration:** actual SLA targets/calendars and approved tenant policy
  versions remain tenant-owned; none were invented or activated during these checks.

The role-aware frontend support workspace is implemented against existing ticket APIs.
Authenticated browser acceptance of the operational pages and the listed backend acceptance gaps remain open.


### Synthetic AI end-to-end re-verification (20 November 2026)

The complete backend test suite passed **213/213 tests** across 11 suites. The integrated
HTTP cases cover signed synthetic identities, ticket classification and summarisation,
priority and resolution recommendations, document upload/extraction/review/publication,
tenant isolation, durable history, routing, SLA evaluation and queued processing. Source
type-check, production TypeScript build and `git diff --check` also passed.

The live verifier then passed its synthetic Groq classification/summarisation, Mistral
embedding, integrated Inception ticket analysis, priority validation, resolution safety,
PDF extraction, DOCX extraction and candidate-review route checks. PDF and DOCX each
returned a validated `response_time` candidate in this run. Priority returned the valid
`insufficient_information` result; resolution returned `insufficient_evidence` with two
steps. The verifier confirmed the synthetic ticket remained unchanged. The earlier DOCX
`INVALID_OUTPUT`/HTTP 422 was not reproduced, so provider-output variability remains; this
single passing run does not identify the earlier rejected field or guarantee future live
responses.

All provider inputs and temporary application records in this run were synthetic and
isolated; no real tickets or policies were changed. Keycloak discovery/JWKS passed. The
new support-lead membership and team scope were later provisioned and checked locally, but
that user's browser login remains unverified. These are local acceptance results, not
production provider or service-quality guarantees.

### Capstone role pages and local service check (20 November 2026)

The browser application now exposes role-aware dashboard, ticket intake with optional
attachment upload, searchable/filterable/paginated queue, ticket detail/history, AI
analysis/triage/priority preview, similar/knowledge and editable resolution drafts with
evidence-based outcome capture, a support-lead escalation queue and AI approval queue,
operational reports, ticket-scoped audit, and a configuration view over supported APIs.
Foundation identity and organisation pages remain permission-gated. The approval queue scans all tickets returned by the lead's
server-authorized ticket scope in batches and excludes redacted/stale reports and reports
already reviewed by that lead. Queue sorting is limited to the displayed page because the
backend list contract has no sort parameter.

Verified in this update: backend suite 214/214; backend build/typecheck, frontend typecheck/lint, OpenAPI JSON parsing, and git diff --check passed. Backend readiness and the frontend root returned HTTP 200 after restarting. This verifies service availability, not authenticated page interaction or a browser end-to-end flow. No browser E2E was run.

The screens use only current API behavior: the dashboard's ticket counts/workload are
limited by the caller's visible ticket scope, and report-based SLA metrics require report
permission. The backend global audit API is read-only and admin-only; identity/team event
writes and audit presentation remain incomplete. Configuration does not
offer category/priority CRUD absent from the backend. Resolution recommendations do not record separate AI-quality labels or saved model-suggestion edits; final work notes and outcomes use the existing approved workflow route. Ticket escalation records and scoped lead handling are implemented, but no percentage-based SLA trigger or tenant SLA target/calendar is invented. Full live/user acceptance with populated synthetic
ticket/triage data and authenticated agent, lead, requester and administrator interactions
remains unverified; existing synthetic provider verification above is separate evidence.

Escalation behavior is backed by ticket history: changing internal priority to P1 opens an
escalation; support staff can manually escalate with a reason and handover note; only support
leads and organisation administrators can record follow-up and close it. `GET /api/v1/ticket-escalations` returns only open records on tickets visible to the caller.
The focused `ticket-api.test.ts` regression covers P1 auto-open, agent manual escalation,
lead queue visibility, requester denial, single-open conflict, closure and audit events.
The source SLA document says its target table is illustrative and subject to management
approval; the structured escalation thresholds remain draft. Thus no time-percentage trigger
or outbound notification was enabled. Resolution outcome forms use the existing approved
workflow status route and only send resolution evidence for statuses named resolved by an
active applicable SLA policy. Standalone AI-quality feedback for resolution suggestions is
still not supported by an API.

### MongoDB Atlas production migration (23 November 2026)

The user selected managed MongoDB Atlas as the production application database. Added the
MongoDB Node.js driver and Atlas configuration, MongoDB-backed collection and ticket/workflow
stores, tenant and version indexes, production Keycloak/database guards, container build
definitions, and a dry-run-first JSON migration utility. The migration dry run inventoried
five supported local collections by count only; it made no network connection and changed no
source data. The full backend suite passed 216/216; combined focused ticket/config/Mongo
checks passed 42/42 (the Mongo server integration case is separately gated); backend
typecheck/build and frontend typecheck/lint/build passed. A standalone frontend build served
the root and backend readiness proxy with HTTP 200. After restarting the local backend in
development JSON mode, backend readiness and the frontend root both returned HTTP 200.

MongoDB integration tests remain skipped because no isolated Atlas URI was configured. Ticket
list and single-ticket reads now scope Mongo queries by organisation, with a tenant-isolation
regression in unit coverage and the gated integration test. MongoDB ticket/workflow mutations
and generic collection `update` now write only changed records within their transaction; they
still read full collections to compute those deltas. Legacy whole-collection `write`, application-
side ticket filters/pagination, and most other repository query paths remain, so the query-oriented
repository migration and production-scale validation remain required. The latest backend suite
passed 221/221. Identity/user/membership reads now use the structured query port in both adapters;
MongoDB maps identity IDs to `_id` and filters membership reads by tenant/user/status. Focused
MongoDB tests passed 6/6. Server shutdown now waits for in-flight AI/SLA work before closing
MongoDB; the full run also passed the automatic-intake cleanup scenario. Organisation, team and
document, policy, and SLA evaluation repositories now use structured MongoDB query filters for tenant-owned lookups, active
membership validation, team listings, document status/version reads, ticket-bound SLA history, and policy/version/rule reads; the JSON adapter keeps
legacy-array migration behavior. Focused organisation/team/document and policy tests passed
26/26, and the focused SLA evaluation service test passed 1/1. Policy/version/rule reads now
apply the tenant filter in storage. AI analysis/workflow-run history now queries by organisation
and ticket; AI operation history queries by organisation and operation kind. Worker polling
queries only queued/running jobs before applying its existing due-time checks. Compound indexes
cover these AI history and polling lookups. Focused AI operations plus MongoDB persistence tests
passed 17/17 after the worker polling update; document extraction/policy tests passed 7/7 after
the document query update. Document current-version, extraction job/history, and approval checks now query by
tenant plus their document/version identifiers. Approved knowledge and ticket SLA source document
checks also load only tenant-matching approval/version records. Focused document, policy, retrieval,
ticket API and MongoDB tests passed 45/45. The latest complete backend suite passed 222/222 (13 suites), with backend typecheck,
production build, and `git diff --check` passing. These local adapter/unit results do not verify Atlas query
plans, transactions, production-sized pagination, migration, or failure recovery. Several
mutation paths and broad list operations still use collection snapshots and need query-oriented
migration before production-scale use. Focused policy/document tests passed 7/7 after the policy query update.
Atlas integration remains skipped. Local document and
attachment bytes were not migrated. Docker
images, Atlas backup/restore, authenticated browser E2E, production
cutover, malware scanning, storage hosting and retention are unverified or undecided; see
`docs/deployment/production-readiness.md`. No credentials, real tickets or policies were
used for migration.

The ticket list now has a MongoDB pagination path when no free-text `q` is supplied. It applies
organisation and server-derived role/team scope, the supported status/priority/team/requester
filters, stable newest-first ordering, field projection, count and limit/offset in MongoDB.
Existing free-text search stays on the legacy matching path and remains an unbounded candidate
scan. The open escalation queue also filters by organisation, open status, and server-derived
requester/team/unassigned scope in MongoDB; the API rechecks ticket access before returning it.
Compatibility snapshot writes now compare persisted records and apply upserts/deletes per record;
they no longer clear the entire MongoDB collection before reinserting. Document and policy
mutations use tenant-scoped MongoDB queries and record-level writes, including policy reviews and
their audit records. JSON fallback tests verify other tenants are preserved and tenant ownership
changes are rejected. Extraction job enqueue/claim/update, extraction history, SLA evaluation
history, and knowledge-publication audit appends now also use tenant-scoped mutations; job updates
preserve the stored tenant and ID. Focused document, policy, and SLA tests passed 20/20. The latest
complete backend run passed 233/233 (13 suites); focused MongoDB and migration validation/safety
tests passed 17/17. Mongo transaction callbacks now run through the driver's retry helper and nested calls
reuse its session. The JSON migration permits only empty pre-indexed application collections,
creates indexes before importing, and verifies source/target counts within the transaction before
commit. Source IDs, selected domain schemas, and tenant ownership are validated before Atlas
connection. Typecheck, production build, and
`git diff --check` passed. These are adapter/unit and synthetic API results; the MongoDB
integration suite remains skipped without `MONGODB_TEST_URI`, so Atlas transactions, migration,
and scale behavior remain unverified. Compatibility read/write/update methods remain in use for
legacy/global operations, including identity user/email uniqueness and organisation-name
uniqueness; the latest scoped-mutation coverage and remaining global operations are summarized
in the update below. Broad tenant list paths and free-text ticket matching still need bounded
query work and scale testing.

### Latest MongoDB production-readiness update (23 November 2026)

The project owner selected managed MongoDB Atlas. The Atlas adapter and dry-run-first
JSON migration remain configured for production mode, while local development/tests retain
JSON storage. Tenant mutations for team, organisation membership, AI operation/history,
documents, policies, extraction jobs/history, and SLA history use tenant filters where the
adapter supports them. AI workflow-run records use `runId` as the Mongo storage ID; their
existing JSON and API shape is preserved. Migration validation now accepts this domain key
and normalizes it before import. A regression test covers validation and normalization.

Verified locally: backend suite **235/235 passed** across 13 suites; focused MongoDB and
AI-operation tests **28/28 passed**; backend TypeScript typecheck and production build passed.
The test runner initially hit Windows `spawn EPERM` under the default sandbox and passed
when rerun with the needed process permission. This is test evidence against the local
adapters and mocked MongoDB interfaces. No `MONGODB_TEST_URI` was configured, so no Atlas
or replica-set integration test, transaction, index creation, migration import, backup or
restore was exercised. No credentials, live tickets, or live policies were used.

Production readiness remains blocked on an isolated Atlas integration run and an approved
cutover/backup-restore plan. Broad tenant and administrative lists and free-text ticket search
need bounded query and scale work. Local document and attachment bytes still require a selected private
object store and malware-scanning process. Worker deployment topology, rate-limit/public
intake rules, retention periods, recovery/observability targets, identity/team audit event writes and
coverage, real-user Keycloak membership validation, and tenant-approved SLA targets and
calendars also remain unverified or unspecified. These choices are not inferred here.

### Uniqueness race protection (23 November 2026)

MongoDB startup now provisions case-insensitive unique indexes for user email and
organisation name. If concurrent requests race past the existing repository duplicate
checks, MongoDB's duplicate-key response is converted to the existing `409 USER_ALREADY_EXISTS`
or `409 DUPLICATE_ORGANISATION` response. Organisation creation removes its provisional
administrator membership when the unique insert/update fails. User and organisation creates
now use direct MongoDB inserts; user updates/deletes and organisation updates use ID-scoped
record operations. The JSON adapter retains its serialized collection fallback. Local
regression tests verify index declarations, point-operation filters, conflict mapping and
rollback; no Atlas instance was available to exercise server-side index behavior. Backend
suite passed **238/238** (14 suites), focused identity, organisation and Mongo persistence
checks passed **23/23**, and backend typecheck/build and `git diff --check` passed. Remaining
broad list/search paths and legacy compatibility operations still need bounded query work and
production-scale testing.

### HTTP security response headers (23 November 2026)

The shared HTTP handler now sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, and a `Permissions-Policy` disabling
camera, microphone and geolocation. Express has `X-Powered-By` disabled. Focused HTTP
foundation tests verified the headers on both the raw health handler and an Express-served
API response. Foundation tests passed **22/22**; the full backend suite passed **238/238**
(14 suites); backend typecheck, build and `git diff --check` passed. HSTS/TLS remains a
deployment-level verification because the TLS termination setup has not been selected.

### Integrated OpenAPI and organisation audit API (23 November 2026)

Generated `docs/api/integrated-openapi.json` from the ticket/AI contracts and implemented
foundation, document, policy, SLA, report and extracted-rule routes. The generator is
available as `npm run openapi:build`; Swagger at `/api/v1/ai/docs` now displays the integrated
contract at `/api/v1/openapi.json`, while `/api/v1/ai/openapi.json` remains compatible.
The document contains **73 paths and 88 operations**, each with a unique `operationId`. An
automated test compares every literal ticket and AI Express route declaration with the integrated contract. Foundation route
inventory and response-schema conformance are still not generated exhaustively.

Added `GET /api/v1/audit-logs` after the owner specified organisation-admin-only access and
aggregation of existing records only. It returns current-organisation policy/knowledge audit
records, AI governance records and ticket history events, sorted newest-first with pagination.
It does not add event writes for identity, organisation or team changes. Regression tests
verify denial for support agents and leads, cross-tenant isolation for administrators,
pagination validation, public OpenAPI delivery and representative integrated-contract paths.
An Atlas compound index covers organisation plus audit creation time.

Verification on this update: backend suite **240/240 passed** across 14 suites; focused audit,
Swagger and route-parity regressions **3/3 passed**; backend typecheck, production build and `git diff --check`
passed. These tests use synthetic in-process data; the Atlas integration suite was skipped
because `MONGODB_TEST_URI` is not configured. No live AI provider request, real ticket or real
policy was used for these checks. Docker image build remains unverified because the local
Docker Desktop engine pipe denied access.

Remaining production blockers include isolated Atlas integration plus a cutover/backup-restore
plan; bounded tenant/admin history and free-text searches; private object storage, malware
scanning and approved retention; an independently deployable worker/queue design; agreed
rate-limit/public-intake rules, recovery/observability targets and tenant-approved SLA targets
and calendars; real-user Keycloak tenant authorization verification; identity/team audit event
writes; authenticated browser E2E; and a working Docker image build. These are unverified or
require product/operations decisions and have not been invented here.

### Phase 2 architecture alignment documentation (23 November 2026)

The architecture set was reconciled against the current source and production-readiness record:
Architecture, HLD, LLD, Component Design, Data Flow, Security and Permissions, and Database
Design now distinguish implemented behavior from target deployment gaps. Atlas is recorded as
the selected production database; JSON remains local/test. The server's foundation dispatcher
plus Express domain application, in-process workers, lexical retrieval, local file storage,
backend-derived role authorization, and partial audit coverage are described as they exist.
The earlier conceptual relational entity list is explicitly historical; performance/KPI
capabilities are not claimed as implemented.

No runtime code, frontend code, or live services were changed or tested in this documentation
pass. The latest applicable source verification remains the 240/240 backend suite, backend
typecheck/build, and focused audit/OpenAPI/route-parity checks recorded above. Atlas integration
remains skipped without an isolated `MONGODB_TEST_URI`; this is not production acceptance.

### Phase 3 functional audit verification (23 November 2026)

Phase 3 functional requirements A–I are assessed in
[`docs/assessment/initial-assessment.md`](../assessment/initial-assessment.md). The phase
remains Partial overall: ticket, AI, SLA, and review flows have synthetic backend coverage,
while live and production acceptance is unverified. Classification with tenant-managed multi-label categories is now implemented;
approved SLA-linked priority, semantic retrieval, product/expertise/workload routing,
persisted recommendation edits, and complete audit event coverage remain gaps or unverified.

Seven focused backend test files were run directly with `node --import tsx` after the normal
`npm test` command hit Windows `spawn EPERM` launching test workers. They passed **93/93**:
ticket API 20, ticket AI API integration 4, AI phase 1 9, priority recommendation 16,
retrieval/resolution 11, SLA engine 8, and integrated application 25. The failures from the
standard command were worker-launch failures, not test assertion failures. These synthetic
tests do not establish live Atlas, live provider quality, authenticated browser E2E, or
production tenant behavior. No application code was changed during this audit.

#### Ticket intake implementation follow-up (23 November 2026)

The requester form now sends optional `product` and `affectedService` fields and shows the
current account as read-only requester context. The backend derives stored requester and
tenant identity and assigns creation/update timestamps. The focused ticket API test passed
**20/20** after adding assertions for requester ID, product, affected service, and timestamps.
Frontend `npm run typecheck` and `npm run lint` passed. The authenticated UI flow has not been
exercised in browser E2E; production attachment storage/scanning remains unverified.

#### Classification implementation follow-up (23 November 2026)

Classification accepts multiple configured category IDs, an explanation, and exact source
evidence spans tied to the authorized ticket snapshot. Unconfigured or duplicate IDs,
malformed evidence, and excerpts/offsets that do not match are rejected as invalid provider
output; empty/uncertain results still require human review. Tenant administrators can list,
create, enable, and disable categories through `/api/v1/configuration/categories`.
Mutations are tenant-scoped and recorded in AI governance audit history; approved routing
rules prevent disabling categories they still reference. These behaviors are available
through authenticated backend endpoints. Environment categories remain a compatibility
fallback when an organisation has no category records. Frontend rendering of the new
multi-label response was not included in this backend-only change.

Synthetic regression coverage exercises multiple labels, evidence validation, uncertainty,
provider failover, category isolation and audit behavior. Live-provider multi-label quality
and authenticated browser E2E remain unverified.

Verification for this follow-up: focused classification/category/API tests passed **72/72**;
the full backend suite passed **244/244**. Backend build and typecheck passed. Integrated
OpenAPI generation completed, and `git diff --check`
passed. No live provider calls were made for this classification change.

#### Summarisation implementation follow-up (23 November 2026)

The ticket summary now has a separate `affectedFunctionality` field. The summarizer prompt
requires a short, ticket-grounded function description and `null` when the ticket does not
identify one; output validation still requires the exact schema and rejects missing,
empty, or incorrectly typed values. The prompt version is `ticket-summary-v2`. Existing
persisted summaries without the field remain readable through a storage-only compatibility
normalizer that supplies `null`; provider responses are never normalized or relaxed.
Synthetic tests cover supported and unknown function values, legacy history, invalid output,
and prompt version metadata. These are backend synthetic checks; no live model or authenticated
browser E2E was run for this change, so summary quality and frontend presentation remain
unverified.

#### Phase 10 testing and verification (24 November 2026)

Recorded test coverage, exact synthetic AI evaluation results, and limitations in
[`docs/assessment/phase-10-testing-verification.md`](../assessment/phase-10-testing-verification.md).
The compiled backend suite passed **270/270** across 21 suites using an in-process runner
because sandboxed worker spawning fails with `spawn EPERM`; backend type-check/build passed.
Frontend API/navigation tests passed **5/5**, and frontend type-check and lint passed.
The local deterministic demo evaluation completed all six synthetic cases, measured 3/6
classification accuracy, 4/4 lexical summary-fact coverage, and zero prohibited phrase hits.
This is explicitly not a live model evaluation; the local classifier result does not support
a production quality claim. Playwright/browser E2E and independently labelled evaluations for
priority, retrieval, resolution, and routing were not run. Phase 10 remains open for those
acceptance items and live provider verification.

#### Phase 3 role behavior cross-check (23 November 2026)

The requested backend role behaviors were checked against their services and focused API tests:

| Agent | Verified behavior | Remaining boundary |
|---|---|---|
| Priority Recommendation Agent | Evidence-backed impact/urgency assessment and deterministic P1–P4 matrix preview; insufficient evidence returns no priority; recommendation requires human review and does not mutate the ticket. | The configured matrix remains a development-only draft candidate. It is not an active tenant-approved priority policy. |
| Similarity Retrieval Agent | Permission-filtered lexical retrieval can return approved knowledge articles and separately verified historical resolutions with source/version/excerpt references. Current ticket and unauthorized/stale sources are excluded. | Semantic/vector indexing is not connected. Relevance quality on tenant data remains unverified. |
| Resolution Recommender Agent | Returns ordered troubleshooting steps only when each step cites an exact excerpt from currently permitted evidence; returns insufficient evidence safely and leaves the ticket unchanged. | Numeric confidence and persisted edits to a generated suggestion are not defined by the current review contract. |
| Routing Agent | Full triage applies active approved category-to-team rules, checks caller eligibility and ambiguity, and returns a review-required recommendation without assigning the ticket. | Product ownership, expertise and workload are not configured inputs; routing is exposed through triage rather than a standalone recommendation route. |
| SLA Evaluator | Reuses the deterministic evaluator against active tenant policy versions, configured calendars and recorded ticket timestamps/evidence; missing applicable policy yields no fabricated evaluation. | No real tenant-approved active target/calendar set was verified in this pass; automated time-threshold notifications are not active. |
| Approval Workflow Manager | AI recommendations are review-required and do not execute ticket changes. Triage decisions and ticket, policy, SLA and workflow approvals are separately permission-gated and recorded. | There is no universal approval manager for arbitrary actions or one shared complete audit ledger. Additional approval/edit semantics require a specified action matrix. |

Focused tests passed **92/92** across priority recommendation, lexical retrieval/resolution,
AI operations and review, SLA engine, integrated application and ticket API. These are
synthetic backend checks; no live provider, tenant policy activation, Atlas vector index or
browser E2E was run. Accordingly, the listed agent behaviors are implemented in the tested
backend paths, while the boundaries above remain open. No new policy, confidence calculation,
workload rule, approval action or infrastructure choice was introduced.

#### Priority and per-priority SLA policy alignment (23 November 2026)

Priority factor instructions now consider stated business criticality when assessing impact
and workaround availability when assessing urgency. The existing impact/urgency matrix,
exact ticket evidence requirement, insufficient-information result, and mandatory human review
remain unchanged.

SLA policy versions can define a separate validated calendar for each configured priority;
legacy shared-calendar versions remain supported. Both first-response and resolution
calculations now use the calendar for that ticket priority. Calendar maps must contain exactly
the same priority keys as configured targets. `API-Specification.md` documents the shape.

The attached `SLA-VOD-001` is explicitly a fictional test agreement, effective 1 December
2026, with unsigned approval lines. Synthetic regressions use its P1 24/7 and P2–P4 weekday
schedules/targets to verify weekend and weekday deadline calculations. An isolated API test
verifies priority-specific calendars through policy creation, approval, activation, and
versioning. No tenant data was seeded or changed, and the sample agreement was not activated.
Its update-frequency targets and timed escalation recipients are not implemented by this
change; actual customer-notification channels and escalation owner mappings are not configured.

Verification: focused priority/SLA/API tests **45/45 passed**; complete backend suite
**246/246 passed** (14 suites); backend build and typecheck passed; `git diff --check` passed.
No live provider calls or tenant policy activation were performed.

#### SLA document workflow in the administration UI (24 November 2026)

The Configuration page now connects to the existing tenant document APIs. An organisation
administrator can upload a TXT, Markdown, PDF, or DOCX source, request candidate extraction, inspect
provenance/evidence, approve or reject candidates with a reason, and explicitly publish
approved evidence for AI retrieval. The same page supports entering a tenant-approved
structured SLA payload tied to a selected source document version; creation, approval, and
activation remain separate steps. The backend continues to validate the policy and only an
activated SLA version is available to the SLA evaluator. Published document evidence can
support authorised similarity and resolution retrieval; it does not alter the priority matrix.

Focused document tests passed **10/10**, including validated Markdown upload and UTF-8
conversion. The complete backend suite passed **249/249** (14 suites), backend build and
type-check passed, and frontend type-check/build passed. A later focused integrated-API
regression passed **1/1** for routing configuration reads with a legacy report. No browser
E2E, live upload, provider extraction, or SLA activation was run. The local backend and
frontend both returned HTTP 200 after the compatibility fix; persisted records were not
modified.

#### Configuration read compatibility (24 November 2026)

The configuration banner's 503 was traced to one previously saved AI triage report whose
summary predates the required `affectedFunctionality` field. The report validator now uses the
existing strict legacy-summary normalizer, mapping only that absent legacy field to `null`.
Responses receive the normalized view without rewriting the stored report. Other malformed or
unsupported report shapes remain rejected. A focused regression confirms the same shared store
can serve routing-configuration reads and the legacy report remains unchanged on disk. The
running backend was restarted with the fix and its readiness check returned HTTP 200; refresh
the signed-in Configuration page to fetch the repaired routing-rules response.

#### Phase 4 AI agent architecture and execution usage (24 November 2026)

The Phase 4 master prompt was checked against backend components and tests. The eight bounded
capabilities exist in differing forms: classifier, summarizer, priority, retrieval, resolution,
routing, SLA evaluation and separate approval/review paths. The core LangGraph orchestrates
classification and summary; full triage composes the other capabilities. Provider-specific
code remains behind adapters, and the tested model-facing paths use typed output validation,
execution IDs, timeouts, safe failures and mandatory uncertainty/review handling where
specified.

The OpenAI-compatible provider now captures valid provider-reported prompt/completion/total
token counts. The runner carries these counts through execution metadata and logging; durable
core analysis/workflow records preserve them. Missing or malformed counts are omitted, and
legacy records remain valid. Focused tests cover valid counts, malformed counts, runner logging
and persistence. This is usage metadata only; no cost calculation or quota behavior was added.

Phase 4 remains **partially complete**. Similarity is lexical rather than semantic/vector;
prompt contents are source constants rather than an externally managed prompt registry;
there is no complete component-level ledger for deterministic capabilities; provider usage
exists only when returned; and approval enforcement is split among existing workflows rather
than controlled by a universal approval manager/action matrix. Priority policy activation,
resolution confidence/edit semantics, SLA tenant approval and the authorization/versioning
contract for editable prompts remain open. These gaps need product policy or infrastructure
decisions before implementation. No new approval behavior or tenant policy was inferred.

Verification: focused provider/execution tests **13/13 passed**; complete backend suite
**251/251 passed** (14 suites); backend type-check and build passed; `git diff --check` passed.
No live provider call was made. The backend process must restart before its loaded code can
report the new token-usage fields.

#### Phase 5 frontend requirements audit (24 November 2026)

The browser implementation was checked against the Phase 5 master-prompt screens and the
actual `/api/v1` routes. Ticket intake uses the authenticated create and attachment endpoints;
the queue uses backend search/filter/pagination with page-local sorting; ticket detail loads
the ticket, comments, workflow context, permitted history and analyses. Dashboard counts and
workload use role-visible ticket data; report and SLA metrics use the report endpoint when
the role has report permission. The AI workspace calls analysis, full triage, priority,
similarity and resolution endpoints. Resolution notes, outcome and customer confirmation are
submitted through the permitted status transition. Support leads see scoped escalations and
AI reviews. Configuration exposes the SLA document workflow, tenant categories, and
draft/approve/disable routing rules through backend APIs. Priority scoring now has
tenant-scoped immutable versions: administrators create a complete 3×3 impact/urgency matrix
draft against a processed organisation document version, approve it with a reason, then
activate it separately. Activation verifies the source checksum and archives the previous
version; lifecycle actions are audited. Production recommendations resolve only an active,
source-verified policy; the environment matrix remains a development-only fallback. A
confidence threshold must still be explicitly configured.

This pass wired the existing administrator-only `GET /api/v1/audit-logs` route into the Audit
page for organisation administrators, with server pagination and explicit loading, empty and
error states. Other audit-capable support roles continue to see ticket-scoped history. The AI
recommendation result is now presented in named classification, priority, routing, similarity
and resolution sections with evidence, while retaining the raw response behind a disclosure.
The summary view also displays the separate affected-functionality field when present.

Phase 5 remains **partially verified**. Support leads can now edit the AI resolution summary
and ordered steps from the approval queue. The server validates citations against the report's
approved evidence, stores an immutable before/after revision with decision, comment, reviewer,
and timestamp, and records the revision in the audit ledger. This does not perform ticket
actions. Responsive layouts, keyboard and screen-reader behavior, and complete role-based
browser journeys still require browser E2E and manual accessibility verification; no browser
session was available in this pass. Backend authorization remains authoritative for all
actions.

Verification: focused AI operations suite **14/14 passed**; focused integrated API
regressions **2/2 passed**; full backend suite **254/254 passed** (14 suites). Backend
type-check/build and frontend type-check/ESLint/isolated production build passed. The generated
integrated OpenAPI file includes the four priority-policy lifecycle routes. Build output used
an isolated `.next-phase5-check` directory so the running development server's cache was not
replaced; Next.js's temporary `tsconfig.json` include and build directory were removed. No
frontend test suite or browser E2E was run.

#### Phase 6 backend API audit (24 November 2026)

Compared the master prompt's endpoint table with the integrated server, validation,
authorization, persistence, response handling, OpenAPI, and synthetic tests. The API uses
`/api/v1`; ticket/AI/configuration routes dispatch through the integrated application. Exact,
equivalent, and composed route mappings (including authenticated ticket intake, combined
classification/summarisation, full-triage routing, and review decisions) are recorded in
[`docs/assessment/phase-6-backend-api-audit.md`](../assessment/phase-6-backend-api-audit.md).
No duplicate aliases were added. Tenant priority versions and SLA policy version approval and
activation use their documented lifecycle routes.

The generated OpenAPI document now contains 78 paths and 95 operations after the Jira webhook
was removed. The regression checks
literal ticket/AI routes and the Phase 6 contract paths, including dynamically constructed
priority and routing lifecycle routes. The focused OpenAPI contract test passed **1/1**. The
latest full backend suite passed **254/254** (14 suites); backend type-check/build also passed.
This audit did not call live AI providers or establish production Atlas connectivity,
real-user Keycloak authorization, or a generic third-party ingestion contract beyond the
authenticated ticket API. No generic external intake contract is implemented.

#### Jira webhook removal and Phase 7 persistence audit (24 November 2026)

Removed the Jira webhook route, Jira environment parser, authentication bypass, secret-path
log handling, Jira ticket upsert implementation, and its MongoDB source-identity index
creation. The API and Postman contracts no longer advertise Jira intake. Existing stored Jira
source metadata remains schema-readable for compatibility; no stored tickets or indexes were
deleted, and no database migration was run. Authenticated `POST /api/v1/tickets` remains the
supported ticket intake operation. Generic external ingestion is not implemented.

Phase 7 maps each master-prompt data concept to the current JSON/MongoDB persistence model,
including embedded ticket comments/attachments/history, AI analysis and operations records,
policy-backed knowledge, SLA versions/evaluations, and execution records. It records field
shapes, application validation, tenant relationships, index definitions, synthetic examples,
migration behavior, and retention/deletion gaps in
[`docs/assessment/phase-7-database-persistence-audit.md`](../assessment/phase-7-database-persistence-audit.md).
Unused `knowledge-articles` and `knowledge-actions` index initialization was removed because
the running knowledge implementation stores approved material in policy/version records.

Phase 7 is **partially complete**. JSON is still the local/test default. The main Atlas URI
passed a read-only ping; an isolated test URI was used only for temporary databases. Migration
apply to the main database, Atlas backup/restore, production network/user policy, and real-user
authorization remain unverified. A dry run validated the repository's one local team record
without connecting to a database. Ticket/workflow Mongo mutations carry authenticated
organisation scope into the transaction, query only tenant records, and scope writes by
organisation. Retention/deletion policy, production object storage, and malware scanning remain
unspecified or unselected.

Verification for this pass: focused API tests **45/45 passed**; full backend suite **251/251
passed** across 14 suites; backend type-check and build passed; integrated OpenAPI regenerated
with **78 paths / 95 operations**; `git diff --check` passed. These are synthetic/local
checks and do not establish production Atlas availability. Frontend files were not changed.

#### Phase 7 tenant-scoped mutation follow-up (24 November 2026)

Updated ticket and workflow store mutations so MongoDB transactions receive tenant context,
read only that organisation's records, and filter replacements/deletions by both record ID and
organisation ID. Added regression coverage for tenant-scoped ticket/workflow writes. Backend
type-check and production build pass; `git diff --check` passes. The test runner was attempted
but could not start test files because the sandbox denied child-process spawning (`spawn EPERM`),
so those regression tests are not yet verified. Atlas, migration, restore, production file
storage/scanning, and retention remain unverified, unselected, or dependent on owner policy.

Migration validation now checks document/version metadata, policy and approval records,
extracted rules, extraction jobs/results, SLA evaluations, and AI analysis records. Policy
payload contents remain policy-type-specific and are validated by application logic. The local
dry run read one team record and made no database changes. Type-check, build, and
`git diff --check` passed after the validation changes. Direct compiled-code smoke checks for
tenant-scoped ticket reads/writes and migration document validation passed; the formal Node
test runner remains blocked by `spawn EPERM`.

#### Phase 7 Atlas verification follow-up (24 November 2026)

The isolated Atlas persistence suite passed **20/20** tests. To work around the sandbox's
`spawn EPERM` restriction in the Node test runner, the current TypeScript test file was
transpiled with the installed TypeScript API and executed directly. The tests covered migration
validation, tenant-scoped ticket/workflow persistence, transactions and rollback, and mock
adapter behavior. Separate isolated Atlas checks passed a main-URI read-only ping, actual
tenant-scoped ticket update and workflow persistence, selected server-side index inspection,
and a synthetic transactional import with count verification. Every temporary test database
was dropped afterward. No writes were made to the main database. Atlas backup/restore and
production data cutover remain unverified; production file storage/scanning and retention still
need owner decisions.

#### Phase 8 authentication, authorisation and security audit (24 November 2026)

Added the repository-aligned Phase 8 review at
[`docs/assessment/phase-8-security-audit.md`](../assessment/phase-8-security-audit.md).
Code inspection confirms production Keycloak token validation, backend-derived role and
membership permissions, tenant/team/requester ticket scopes, protected upload/download routes,
request/file size bounds, tenant-scoped local private storage, and AI input/output validation.
Tightened document upload validation so supported extensions must match their MIME type, and
changed unexpected API and scheduled-worker error logging to record exception type instead of
raw exception content. Removed a credential from the tracked environment example; rotate that
database user's credential before shared or production use.

The integrated API enforces authenticated-only ticket intake and process-local rate defaults:
5 failed bearer attempts per socket peer IP per minute, 10 ticket creations per user and tenant
per minute, and 5 expensive AI operations per user and tenant per minute. Rate rejections return
429 and `Retry-After`. These are recommended defaults because the specification requires rate
limiting but gives no numeric values. Multi-instance deployments need a shared gateway limiter;
Keycloak login traffic itself needs Keycloak-side controls.

Focused document, ticket API, unified authentication/role, and foundation/Keycloak suites passed
**45/45**; backend type-check and build passed; `git diff --check` passed. The sandbox blocked
the standard Node test runner with `spawn EPERM`, so focused suites were transpiled and executed
directly in-process. An additional integrated API suite previously ran 23 tests with 6 failures:
five depend on test fixture paths unavailable from the isolated compiled-test directory, and one
stale Jira webhook test expects a route that was intentionally removed. No live Keycloak
user/role matrix or penetration test was run. Malware scanning, production private storage,
browser session behavior, deployment network controls, and exhaustive route-by-role testing
remain unverified. These are code and synthetic test results, not production security
certification.

#### Phase 9 frontend/backend integration (24 November 2026)

Recorded the browser-to-backend path and acceptance boundaries in
[`docs/assessment/phase-9-frontend-backend-integration.md`](../assessment/phase-9-frontend-backend-integration.md).
The Next proxy now preserves rate-limit and file-download headers. Ticket attachment downloads
are connected from the authenticated support UI through the frontend API client and proxy.
Frontend type-check and ESLint passed; a synthetic proxy check verified bearer/organisation
header and query forwarding, HTTP 429 with `Retry-After`, and attachment disposition. An
isolated Next production build stopped before compilation because the sandbox denied child
process creation (`spawn EPERM`). No app server was started and no live browser session was
exercised. The current backend environment uses JSON persistence, not Atlas. Browser E2E for
all roles, Atlas-backed acceptance, and production private file storage/scanning remain
unverified.

#### Phase 11 non-functional requirements (24 November 2026)

Recorded the control-by-control review in
[`docs/assessment/phase-11-nonfunctional-requirements.md`](../assessment/phase-11-nonfunctional-requirements.md).
Focused health, auth/RBAC, pagination, file handling, provider failure, Mongo adapter/index,
and worker tests passed **78/78** across 11 suites. Backend source and test type-checks,
build, and `git diff --check` passed. This is code/synthetic evidence: live Atlas integration
was skipped, and no production load, fault, penetration, or deployment test was run. Process-
local limiters and workers, in-memory extraction queue, missing aggregate metrics, ticket
creation idempotency, and unapproved retention/deletion policy remain open. No numeric
performance, availability, or retention targets were invented.

#### MongoDB runtime default (24 November 2026)

Changed normal application startup to use MongoDB by default in development and production.
`DATABASE_PROVIDER=json` is now rejected outside `NODE_ENV=test`, and the integrated app
factories reject accidental JSON fallback when the Mongo adapter was not injected. Updated
`backend/.env.example`, local setup documentation, database and architecture documents to
make MongoDB the runtime requirement. The offline demo and test suites still use isolated
synthetic JSON fixtures; they do not represent application runtime storage. Document and
ticket-attachment bytes remain in the separate local private-file adapter, so this change
does not claim those blobs are stored in MongoDB.

The local source dry-run validated **80 records in 18 collections** without printing record
contents. The ignored `backend/.env` supplied the configured Atlas connection privately. A
read-only preflight confirmed the target had **21 application collections and 0 records**.
After the user approved migration, the existing importer applied the source in one MongoDB
transaction, verified each collection's count, and left the JSON source unchanged. A separate
read-only post-check confirmed **80 records in 18 collections**. No API or background worker
was started. This verifies configured Mongo connectivity, index initialization, import and
count parity; it does not verify an authenticated API journey, and the migration does not
copy document or attachment bytes from local private storage. Normal startup defaults to
MongoDB and fails closed if connection or index initialization fails; it does not fall back
to JSON.

#### Phase 12 documentation and deployment deliverables (24 November 2026)

Reconciled repository deliverables against the Phase 12 checklist. The required architecture
set is present (`Architecture.md`, `HLD.md`, `LLD.md`, `Component-Design.md`, `Data-Flow.md`,
`Database-Design.md`). The existing security document was renamed to
[`Security-Architecture.md`](../architecture/Security-Architecture.md), and references to
its former filename were updated. The API guide points to the generated contract and marks
the original requirements draft as historical where it conflicts with implementation. The
README and handover now point to the production readiness tracker and current OpenAPI status.

| Deliverable | Repository location | Verified state |
|---|---|---|
| Frontend and backend source | `frontend/`, `backend/` | Present. Frontend is Next.js/React; backend is a Node/TypeScript modular monolith. |
| Architecture and data design | `docs/architecture/` | Required documents present; they describe current behavior and explicit target gaps. |
| API specification and generated Swagger/OpenAPI | `docs/api/API-Specification.md`, `integrated-openapi.json`, `ticket-openapi.json`, `ai-openapi.json` | Integrated contract regenerated in this pass: 78 paths, 95 operations. Swagger serves `/api/v1/openapi.json` and `/api/v1/ai/docs` when running. Exhaustive route parity remains unverified. |
| Database model and indexes | `docs/architecture/Database-Design.md`, `backend/src/infrastructure/persistence/mongodb/` | Model, collections, index definitions and migration limits documented; Atlas deployment/cutover tracked separately. |
| Agents and prompts/configuration | `backend/src/modules/ai/`, `backend/src/infrastructure/llm/`, `backend/data/evaluation/` | Implementations, configuration and evaluation fixtures present. Fixture tests do not establish live provider quality. |
| Unit/integration/E2E/AI evaluation | `backend/tests/`, `backend/src/`, `frontend/tests/`, `backend/data/evaluation/`, `docs/assessment/phase-10-testing-verification.md` | Backend unit/API integration and synthetic AI evaluation exist. Frontend has Node API integration checks; no Playwright/browser E2E suite exists. |
| Containers and local identity configuration | `backend/Dockerfile`, `frontend/Dockerfile`, `deploy/keycloak/docker-compose.yml`, `.dockerignore` files | Backend/frontend images and Keycloak compose exist. There is no root application compose or selected production orchestrator. |
| Environment examples | `backend/.env.example`, `frontend/.env.example`, `deploy/keycloak/.env.example` | Present. Populated `.env` files are excluded from this review and must remain private. |
| Setup and deployment instructions | `README.md`, `frontend/README.md`, `docs/operations/Deployment-and-Handover.md`, `docs/deployment/production-readiness.md` | Local setup is documented; production release remains blocked by items in the readiness tracker. |
| Sample requests and actual response evidence | `postman/`, generated OpenAPI, HTTP integration tests and this file | Request collections, schemas and synthetic HTTP tests exist. Previous local smoke notes retain selected status codes but not full response-body captures. No service was started for this review; a sanitized request/response transcript from a running deployment remains outstanding. Contract examples are not presented as captured runtime output. |

Documented local verification commands are `cd backend; npm ci; npm run typecheck; npm run
build; npm test`, `cd frontend; npm ci; npm run typecheck; npm run lint; npm test`, and
`cd backend; npm run openapi:build`. Latest recorded test evidence is backend **270/270**
for Phase 10 and focused backend **78/78** across 11 suites for Phase 11; frontend API
integration checks were **5/5** in Phase 10. These are prior phase records, not tests rerun
for this documentation-only update. Docker image builds and browser E2E remain unverified.
See [`production-readiness.md`](../deployment/production-readiness.md) for Atlas, storage,
scanning, workers, access, retention, telemetry and release blockers.
