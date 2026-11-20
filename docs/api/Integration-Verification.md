# Integration and system verification

**Integration snapshot:** `FhuluBranch` at `af6c02c` plus the uncommitted P1–P4 priority contract, ticket/SLA evidence, and ticket OpenAPI contract.

## Summary

The canonical backend is TypeScript. `backend/src/main.ts` starts one server through `backend/src/server.ts` and `backend/src/integrated-app.ts`; it serves the foundation identity/organisation/team APIs and the Express ticket, document, policy, SLA and reporting APIs together.

The integrated ticket API authenticates with the shared Keycloak verifier, resolves active tenant membership server-side, loads active team membership, and applies the shared role-permission policy. The integrated startup does not accept the static development principal.

On 20 November 2026, the local `ai-support` realm was reachable and the integrated API started in Keycloak mode. Realm discovery and API health checks passed. The service-account token passed token verification but received `ACCOUNT_INACTIVE` at application identity lookup because the service account is not an active application user. A real user's login, tenant membership, and effective role access still need verification in each developer's local realm.

Ticket priority uses the project P1–P4 contract. `support_lead` and `organisation_admin` may change priority with a reason and business justification; the server records the actor, timestamp, and before/after values. Legacy internal labels normalize to P2/P3/P4; Jira source priority remains unchanged. The contract does not activate a tenant policy.

SLA response now requires explicit acknowledgement, completed assessment, and first team assignment evidence; resolution requires an evidenced status transition; pause and exclusion intervals are auditable and role-gated. Reopening excludes resolved time without resetting the resolution clock. The reference SLA candidate remains draft because client entitlement, actual targets and calendar definitions are not verified.

The ticket, workflow and ticket/SLA-evidence endpoints now have a machine-readable OpenAPI contract at `docs/api/ticket-openapi.json`. The remaining integrated service domains are not yet represented in that contract.

Ticket classification, summarisation, priority preview and resolution recommendation routes are connected to the integrated API. AI work is opt-in and does not change tickets automatically. Document processing supports TXT, PDF and DOCX text conversion, but still uses the deterministic provisional extraction adapter; a provider-backed `ExtractionAdapter` has not yet been implemented or wired.

## Six-item checklist

| Item | Status | Evidence / remaining work |
|---|---|---|
| Single application bootstrap | Integrated | One listener serves foundation and Express domain routes; `tests/integrated-app.test.ts` exercises cross-module flows. |
| Authentication and tenant isolation | Integrated; local smoke-check partial | Local realm discovery and API health passed. An unsigned request received `401`; a valid service-account token reached identity lookup and received `403 ACCOUNT_INACTIVE`. A real user's login, active membership, and role access remain unverified. |
| Ticket priority contract | Implemented; tenant policy remains inactive | P1–P4 API validation, legacy internal-value normalization, override authorization/evidence/audit, Jira source-priority preservation, and legacy SLA-target compatibility are covered by tests. |
| Ticket/SLA event evidence | Implemented; entitlement and target verification remain | Response evidence, resolution events, pause/exclusion intervals, role restrictions, resolution reopening and overlapping interval accounting are tested. |
| Ticket API contract | Ticket/workflow/SLA paths documented | `docs/api/ticket-openapi.json` covers ticket lifecycle, workflow configuration, evidence, attachments and Jira ingestion; full-service OpenAPI and automated contract conformance are still pending. |
| Ticket AI | Service and API paths integrated | Demo/live classification and summarisation, priority preview, lexical retrieval and resolution recommendation are permission-gated. AI analysis and recommendations are read-only and require human review. |
| Document policy extraction | Contract and processing path integrated; provider pending | Olerato's `ExtractionAdapter` contract, result validation, evidence provenance checks, and TXT/PDF/DOCX text conversion are present. The default remains `ProvisionalExtractionAdapter`; no provider-backed extractor is connected. |
| Persistence | Shared guarantees integrated | Domain JSON persistence delegates to the validated shared store, preserving schema validation, atomic writes, locking and explicit errors. Multi-file workflows still are not transactional. |
| Organisation creation rule | Implemented | An active organisation administrator can create another organisation and is granted an active `organisation_admin` membership in it; duplicate-name rollback and non-admin denial are tested. |

## Integration risks to close

1. **Implement and wire a real extraction adapter.** Use the existing contract and approved policy schema; preserve document/version provenance and human-review rules. Confirm rule payloads and provider/model before sending customer documents externally.
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

- Olerato/Wandile: agree on extraction rule schemas, provider/model, evidence format and review thresholds; implement the provider-backed adapter.
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
