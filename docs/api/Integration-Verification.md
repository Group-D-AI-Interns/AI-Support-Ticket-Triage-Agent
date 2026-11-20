# Integration and system verification

**Integration snapshot:** `FhuluBranch` at `af6c02c` plus the uncommitted P1–P4 priority contract, ticket/SLA evidence, and ticket OpenAPI contract.

## Summary

The canonical backend is TypeScript. `backend/src/main.ts` starts one server through `backend/src/server.ts` and `backend/src/integrated-app.ts`; it serves the foundation identity/organisation/team APIs and the Express ticket, document, policy, SLA and reporting APIs together.

The integrated ticket API authenticates with the shared Keycloak verifier, resolves active tenant membership server-side, loads active team membership, and applies the shared role-permission policy. The integrated startup does not accept the static development principal.

On 20 November 2026, the local `ai-support` realm was reachable and the integrated API started in Keycloak mode. Realm discovery and API health checks passed. The service-account token passed token verification but received `ACCOUNT_INACTIVE` at application identity lookup because the service account is not an active application user. A real user's login, tenant membership, and effective role access still need verification in each developer's local realm.

Ticket priority uses the project P1–P4 contract. `support_lead` and `organisation_admin` may change priority with a reason and business justification; the server records the actor, timestamp, and before/after values. Legacy internal labels normalize to P2/P3/P4; Jira source priority remains unchanged. The contract does not activate a tenant policy.

SLA response now requires explicit acknowledgement, completed assessment, and first team assignment evidence; resolution requires an evidenced status transition; pause and exclusion intervals are auditable and role-gated. Reopening excludes resolved time without resetting the resolution clock. The reference SLA candidate remains draft because client entitlement, actual targets and calendar definitions are not verified.

The ticket, workflow and ticket/SLA-evidence endpoints now have a machine-readable OpenAPI contract at `docs/api/ticket-openapi.json`. The remaining integrated service domains are not yet represented in that contract.

Ticket classification, summarisation, priority preview and resolution recommendation routes are connected to the integrated API. AI work is opt-in and does not change tickets automatically. Document processing supports TXT, PDF and DOCX text conversion. In live ticket-AI mode, both direct processing and policy-bound extraction use the provider-backed adapter; demo/offline mode remains provisional. Extracted rules remain review-required drafts.

## Six-item checklist

| Item | Status | Evidence / remaining work |
|---|---|---|
| Single application bootstrap | Integrated | One listener serves foundation and Express domain routes; `tests/integrated-app.test.ts` exercises cross-module flows. |
| Authentication and tenant isolation | Integrated; local smoke-check partial | Local realm discovery and API health passed. An unsigned request received `401`; a valid service-account token reached identity lookup and received `403 ACCOUNT_INACTIVE`. A real user's login, active membership, and role access remain unverified. |
| Ticket priority contract | Implemented; tenant policy remains inactive | P1–P4 API validation, legacy internal-value normalization, override authorization/evidence/audit, Jira source-priority preservation, and legacy SLA-target compatibility are covered by tests. |
| Ticket/SLA event evidence | Implemented; entitlement and target verification remain | Response evidence, resolution events, pause/exclusion intervals, role restrictions, resolution reopening and overlapping interval accounting are tested. |
| Ticket API contract | Ticket/workflow/SLA paths documented | `docs/api/ticket-openapi.json` covers ticket lifecycle, workflow configuration, evidence, attachments and Jira ingestion; full-service OpenAPI and automated contract conformance are still pending. |
| Ticket AI | Service and API paths integrated | Demo/live classification and summarisation, priority preview, lexical retrieval and resolution recommendation are permission-gated. AI analysis and recommendations are read-only and require human review. |
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
| `npm test --prefix backend` | Passed: 158 tests, 0 failures (20 November 2026). Provider and Keycloak integration tests use mocked HTTP/JWKS. |
| `npm run typecheck --prefix backend` | Passed (20 November 2026). |
| `npm run build --prefix backend` | Passed (20 November 2026). |
| `git diff --check` | Passed (20 November 2026). |
| Local Keycloak realm and containers | Passed: Keycloak and PostgreSQL healthy; `ai-support` discovery returned `200`. |
| Local API auth and health probes | Partial: API startup plus liveness/readiness/versioned health returned `200`; unauthenticated `/api/v1/me` returned `401`; the valid service-account token reached identity lookup and returned `403 ACCOUNT_INACTIVE` because it is not an active application user. |
| `support-admin-service` role mappings | Direct `realm-management` assignments are exactly `manage-users`, `view-users`, and `query-users`. Keycloak's built-in `view-users` composite also contributes effective `query-groups`; no shared Keycloak role definition was changed. |
| Live human-user Keycloak login / tenant authorization | Not verified; requires a real developer user token and active local application membership. |
| Live Groq / Inception / Mistral requests | Not run. |

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
and [AI OpenAPI](ai-openapi.json). A running backend serves Swagger at `/api/v1/ai/docs`.
The [AI module guide](../../backend/src/modules/ai/README.md) documents ordering, prerequisites,
source revocation, review semantics, actor mappings, retries and evaluation limitations.

Focused HTTP tests use signed synthetic tokens, local JWKS stubs, temporary JSON storage and
the deterministic provider. They require no live Keycloak/Jira/LLM credentials. Run from backend/:

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
| Live provider/Jira calls for this completion change | None; real tenant/provider acceptance remains manual. |

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
changed, and no live LLM/Jira request was made for this merge verification.

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

Earlier synthetic live-provider checks found successful Groq/Inception
classification/summarisation, Mistral embeddings, priority preview, and PDF/DOCX
extraction. The latest live verifier re-run on 20 November 2026 confirmed Groq
classification/summarisation, Mistral embeddings, and integrated Inception
classification/summarisation. Priority output passed schema validation but returned
`insufficient_information` with no priority; resolution returned
`insufficient_evidence` with two steps and did not modify the ticket. PDF extraction
returned a validated `response_time` candidate, but DOCX extraction returned
`INVALID_OUTPUT` and the API returned `422`, so the overall live verification failed.
A real user's Keycloak login and effective tenant/team authorization were not exercised.

### Remaining backend acceptance gaps

- **General audit coverage:** ticket change history and policy/candidate audit records
  exist, but identity, organisation and team mutations are not written to a shared audit
  log. The draft `GET /api/v1/audit-logs` route is not implemented.
- **Complete API contract:** ticket/workflow/SLA and AI OpenAPI documents exist, but the
  foundation, document, policy, identity, team and reporting APIs do not yet have one
  complete integrated contract.
- **Operational controls:** approved public-intake rules and rate limits are not defined
  or implemented. The API and background workers are not yet independently deployable
  production processes.
- **Production file handling:** private object storage, malware scanning, retention and
  recovery policy still require infrastructure and operational decisions. Local file
  storage is not production-ready for uploaded customer documents or attachments.
- **Tenant acceptance:** verify a real developer user's Keycloak token, active local
  membership, role grants and team membership. Do not use the service-account token as
  an application user.
- **Business configuration:** actual SLA targets/calendars and approved tenant policy
  versions remain tenant-owned; none were invented or activated during these checks.

Frontend work remains paused until these backend acceptance gaps are resolved or
explicitly accepted by the project owner.
