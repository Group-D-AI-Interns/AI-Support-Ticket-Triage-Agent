# Initial Capstone Requirements Assessment

**Assessment date:** 20 November 2026

**Scope:** Existing repository compared with `Capstone_05_ai-support-ticket-triage-agent.docx`.

**Decision boundary:** Initial findings are being closed where existing contracts fully specify behavior. Product policy and infrastructure decisions remain open and are not inferred.

## Assessment method and status meanings

The supplied Capstone document is treated as the requirements specification. Its instructions to a coding agent are not treated as permission to bypass the user's phase gate or to select infrastructure. The pasted master prompt is the user's task: inspect, assess, document gaps, propose a staged plan, and stop for approval before the next major phase.

- **Complete:** The behavior exists and has relevant automated or runtime evidence.
- **Partial:** Some behavior exists, but required screens, rules, integrations, coverage, or production controls are missing.
- **Missing:** No implementation of the requirement was found.
- **Unverified:** Code or configuration exists, but the behavior was not demonstrated in the current environment.
- **Non-compliant:** Current behavior conflicts with the stated requirement or the proposed target architecture.

## 1. Existing architecture

| Layer | Observed implementation |
|---|---|
| Frontend | `frontend/` is a Next.js App Router application using React, TypeScript, Tailwind CSS, React Hook Form, Zod, TanStack Table and Lucide. It implements the Foundation identity/organisation console and a role-aware support ticket workspace for listing, intake, detail, public comments and available AI actions. A Keycloak browser adapter uses authorization-code sign-in with PKCE S256. A same-origin Next route proxies requests to the backend. |
| Backend | Node.js and TypeScript modular monolith. `src/main.ts` starts `src/server.ts`; one Node HTTP server dispatches identity/organisation routes and mounts an Express 5 ticket/domain API. AI, documents, policies, SLA, reporting and identity/team modules are separate source modules. |
| Authentication and RBAC | Keycloak JWT verification validates signature, issuer, audience, expiry and subject. The backend resolves `sub` to a local active user and active organisation membership. Backend membership roles produce permissions; the API is the access-control authority. Frontend navigation uses `/api/v1/me` permissions as a presentation aid. |
| Persistence | JSON remains the local test/demo adapter. On 23 November 2026, the user selected managed MongoDB Atlas for production. The MongoDB driver, collection adapter, ticket/workflow adapters, production configuration checks and JSON migration utility are being introduced; no Atlas URI or live integration result is recorded yet. Keycloak's PostgreSQL is separate from application data. |
| AI and retrieval | Explicit typed classifier, summarizer, priority, retrieval, resolution, routing and SLA components are orchestrated through LangGraph/custom services. Live LLM providers are Inception and Groq behind OpenAI-compatible adapters; Mistral is an embedding adapter. Offline/demo behavior is deterministic/local. Similarity retrieval is lexical; a persisted vector index is not wired. |
| Background work | SLA and AI workers are started by the integrated process. Extraction uses the configured extraction queue (in-memory implementation in this composition); triage jobs persist leases/state in the JSON store. Workers are not separately deployable services. |
| API and docs | APIs are under `/api/v1`. Ticket/workflow/SLA and AI OpenAPI documents exist, but there is no complete integrated OpenAPI contract covering all mounted domains. `docs/api/API-Specification.md` contains both current and historical/draft sections. |
| Tests | Backend uses Node's built-in test runner, with unit and HTTP integration coverage. Frontend has ESLint, TypeScript and production build scripts, but no Playwright or other browser E2E suite. |
| Deployment | `deploy/keycloak/` has a local Keycloak/PostgreSQL Compose stack. Application persistence and uploads use local files. No production object-storage, malware-scanning, retention, independent-worker or application-container deployment has been selected. |

### Existing-document consistency

- `README.md` still says the repository has no frontend, which no longer matches the current `frontend/` tree.
- `docs/initial-assessment.md` describes a 17 November placeholder baseline and stale test/build failures. It should remain historical or be clearly superseded; this new assessment reflects the current repository.
- Existing architecture documents describe JSON as an initial store in some places, while the Capstone proposes MongoDB. `docs/architecture/Architecture.md` and `Database-Design.md` call the database choice unresolved. There is no evidence of coach approval for JSON as a Capstone deviation.
- The Capstone-required file names are mostly represented by existing architecture documents, but a single current compliance view and complete integrated API contract are absent.

### Required documentation deliverables

| Deliverable | Status | Observation |
|---|---|---|
| Architecture, HLD, LLD, Component Design, Data Flow | Present | Existing Markdown documents are available; they need reconciliation with current implementation and approved decisions. |
| Database Design | Present, unresolved | Describes a relational logical design while the Capstone proposes MongoDB and runtime uses JSON files. |
| Security Architecture | Partial | `Security-Architecture.md` exists under a different name; an integrated security architecture needs to reflect active Keycloak configuration and actual deployment. |
| API Specification and generated OpenAPI | Partial | API draft, ticket OpenAPI and AI OpenAPI exist, but no complete integrated contract. |
| Models/index definitions and migrations | Partial | JSON schemas and a document migration exist; Mongo index definitions are absent because Mongo is not used. |
| Test execution evidence | Partial | Backend suite and AI verification evidence are recorded; no browser E2E evidence or full role-login evidence. |
| Docker and deployment documentation | Partial | Local Keycloak/PostgreSQL only; no production application deployment/storage/worker design. |
| Sample requests and actual responses | Partial | Postman collections and API examples exist; they do not cover all routes and role workflows. |

## 2. Traced workflows

### Ticket intake

`POST /api/v1/tickets` in `backend/src/modules/tickets/api.ts` validates title/description and optional product/service, takes requester and organisation from authenticated server context, writes through the ticket store, and enqueues configured intake work. The prior Jira webhook route has been removed. No generic external `/tickets/ingest` contract is defined or mounted.

### Classification and summarisation

`POST /api/v1/tickets/:ticketId/analyze` invokes the configured ticket analysis service. `TicketClassifier`, `TicketSummarizer`, `AiExecutionRunner` and `ticket-analysis.graph.ts` implement bounded components, schemas, execution metadata, validation, timeouts and safe failure paths. The analysis repository persists history. `POST /tickets/:ticketId/triage` composes broader AI/retrieval/SLA/routing results and persists a tenant-scoped triage report. The support workspace exposes triage, similar/evidence retrieval, and resolution recommendation behind returned permissions; results are presented as provider/backend output, not applied to the ticket.

### Priority, routing and resolution

Priority preview uses the explicit draft matrix and server-side evidence; the model cannot set the final priority. A human priority override is a ticket update requiring reason and business justification, with actor/time/before/after history. Routing recommendations use approved category-to-eligible-team rules and return a review-required recommendation; the current recommender does not calculate workload, product ownership or expertise. Resolution retrieves permitted approved knowledge and verified historical resolution passages, validates citations/quotations, flags insufficient evidence and does not modify tickets.

### Human review and SLA

AI triage review decisions are persisted through `POST /api/v1/tickets/:ticketId/triages/:id/reviews`; reviewer decisions are immutable and include accepted/rejected/needs-information outcomes. Ticket workflow drafts, SLA policy versions and reopen requests have separate approval flows. Ticket status changes enforce the approved workflow and require evidence for configured pause/resolution transitions. SLA evaluation uses approved/effective tenant policies and persisted ticket evidence; no tenant target/calendar is inferred.

### Identity and organisation access

The frontend calls `/api/v1/me`, organisations, users, roles, departments and teams through the proxy. The local Keycloak account requested earlier has been linked to an active backend user and an active `support_agent` membership in the only active organisation. This is local ignored runtime state, not a source-controlled seed. No personal identifiers or credentials are included here.

## 3. Capstone requirement matrix

| Requirement | Status | Existing implementation | Gap | Recommended action |
|---|---|---|---|---|
| Modular monolith and API/domain separation | Complete | Integrated Node/TypeScript server, Express domain API, services, repositories, AI components and shared middleware. | Some domain routes are concentrated in a large ticket API module. | Keep the modular monolith; split route modules only where contract work justifies it. |
| Ticket intake through UI and secured API | Partial | Authenticated `POST /api/v1/tickets`; UI ticket form; title/description, requester, optional product/service, timestamps and attachments. | No external-source `/tickets/ingest` route. | Define an external-source contract before adding any integration intake route. |
| Configurable classification | Implemented (synthetic verification) | Organisation administrators can list, add, enable, and disable tenant categories through the backend. Provider output accepts multiple configured category IDs and requires per-category exact title/description evidence spans. Invalid labels, duplicate labels, and fabricated/mismatched evidence fail closed; uncertain results remain review-required. | Existing environment category lists remain a compatibility fallback until an organisation creates its own category records. Category editing/version history and frontend support for the new response are outside this backend-only change. Live-provider multi-label quality remains unverified. |
| Structured summarisation and source preservation | Partial | Summary includes structured fields and missing information; tests verify ticket is unchanged. Ticket detail renders latest structured analysis and history. | Provider evidence/history remains bounded by current API response; browser flow has no automated E2E coverage. | Add browser coverage and extend only if an API field is specified. |
| Priority recommendation, explanation and human override | Partial | Draft-matrix preview and evidence/factors are available in ticket detail; override is permission-gated and audited in ticket history. | Preview is not active tenant policy; tenant-approved scoring/SLA linkage is incomplete. | Preserve draft status; obtain policy/threshold approval. |
| Similar resolved tickets and approved knowledge | Partial | Tenant/permission-aware lexical retrieval; approved knowledge and separately reviewed historical resolution; source references and citation checks; ticket detail exposes the recommendation endpoint. | No persisted semantic index; Mistral embedding adapter is not connected to vector search. | Evaluate lexical relevance; choose vector storage/index only after infrastructure approval. |
| Evidence-backed resolution | Partial | Ordered recommendation schemas, citations, quotation validation, safe insufficient-evidence behavior; editable draft and final outcome capture use the existing workflow status/resolution-evidence route. | No standalone reviewer-quality feedback endpoint; real tenant knowledge/history may be absent. | Add resolution quality labels only after defining the review contract; validate with approved tenant sources. |
| Team routing | Partial | Approved category-to-team routing rules, tenant-team checks and human-review flag; manual assignment API exists. | No direct recommendation endpoint; workload, product, expertise and ownership signals are not modeled. | Decide routing inputs and assignment approval rules; do not invent workload semantics. |
| SLA evaluation | Partial | Versioned draft/approval/activation policy lifecycle, evidence-based evaluation, business calendar calculations and in-process worker; report-enabled roles see SLA metrics in dashboard/reports. P1 priority opens a lead escalation; staff can record SLA-risk handovers. | Actual tenant targets/calendar and applicable active policy are unverified; time-threshold escalation and notifications remain disabled because the candidate is draft. | Obtain tenant-approved targets/calendars, escalation owners and response actions before activating automatic SLA triggers. |
| Human approval and audit | Partial | Workflow/SLA/reopen approvals, ticket history, AI review decisions and AI governance audit records exist. | No unified approval queue; no generic approve/reject/edit/request-more-info workflow for every recommendation; identity/team changes lack shared audit coverage; `/api/v1/audit-logs` is absent. | Map each consequential action to an existing approval contract; approve audit scope before expanding writes. |
| Support Dashboard | Partial | Role-scoped ticket counts, priority distribution and team workload; SLA risk from reports for roles with report permission. | Non-report roles cannot see SLA metrics; counts use role-visible data; no escalation trigger. | Keep scope labels explicit; configure escalation only after approved rules exist. |
| Ticket Intake screen | Partial | Permission-gated form with optional attachment upload and API errors/results. | Private production storage/scanning/retention remain unimplemented. | Complete approved production file handling separately. |
| Ticket Queue | Partial | Backend-scoped queue with search, status/priority/team filters, sort and pagination. | No browser E2E test yet. | Add browser E2E coverage. |
| Ticket Detail and history | Partial | Detail, public comments, attachments, ticket history, summary and analysis history. | No browser E2E test; customer-impact field is not present in the ticket contract. | Add browser coverage; do not fabricate missing ticket attributes. |
| AI Triage Panel | Partial | Analyze, full triage and priority preview results render from existing typed API responses. | No browser E2E test; category/scoring management is not tenant-configurable. | Add browser coverage and wait for approved config API. |
| Similar tickets and knowledge screen | Partial | Ticket detail displays similar-ticket/knowledge endpoint results with references. | Retrieval is lexical and no persisted semantic index is connected. | Evaluate relevance; vector infrastructure needs approval. |
| Resolution workspace | Partial | Recommendation UI displays evidence-backed result, allows editing the final work note, and records outcome/customer-confirmation evidence on resolved transitions configured by an active SLA. | No separate saved reviewer edits to the model suggestion or resolution-quality label. | Add persistent AI feedback only after a review contract is approved. |
| Approval Queue | Partial | Support-lead queue records accepted/rejected/needs-information with reviewer comment using existing triage review APIs. | Only AI triage reviews are in this queue; no generic queue and no reviewer edits; local synthetic queue data may be empty. | Keep current behavior; define any additional approval semantics before extending. |
| Configuration Console | Partial | Foundation manages users/orgs/teams; support configuration reads SLA policies, routing rules and admin workflows where permitted. | No tenant category/priority CRUD or policy writes from the support page; actual business rules remain unverified. | Implement writes only when supported by approved endpoints and roles. |
| Audit and reports | Partial | Role-scoped operational report and ticket history/review audit pages use existing APIs. | No global audit UI because `/api/v1/audit-logs` is absent; identity/team shared audit coverage and OpenAPI gaps remain. | Add global audit only after backend route/authorization contract is specified. |
| Role-based access and tenant isolation | Partial | Keycloak bearer verification; active user/membership resolution; role-derived permission policy; ticket/team/tenant scope tests; frontend uses returned permissions for navigation and controls. Support-agent and support-lead sign-ins were manually verified. | Requester and administrator page flows and new operational-page interactions are not browser-E2E verified; backend remains authority. | Add authenticated browser E2E for each role. |
| Email sign-in | Unverified | Frontend delegates login to Keycloak; checked-in realm template enables email login and public `support-web` client. | Active realm's login settings and actual credential flow were not verified; authorization request currently returns HTTP 400 for invalid redirect. | Verify the active realm after fixing its client allowlist; do not put passwords or tokens into the frontend. |
| MongoDB domain persistence and indexes | Non-compliant with proposed target; decision unresolved | JSON repositories provide schema validation, atomic file replacement and single-host locks. | Capstone proposes MongoDB collections/indexes; application has no Mongo client, indexes, migrations or multi-document transactions. Existing docs also contain a JSON-first direction and mark database choice unresolved. | Coach/project owner must approve JSON as a documented prototype alternative or select a database before a migration design is produced. |
| AI agent contracts and execution tracking | Partial | Typed classifier/summarizer/priority/resolution/routing/SLA components; execution IDs, provider adapters, timeouts, safe errors, prompt-injection defenses, triage history and evaluations. | Provider set differs from recommended Claude/OpenAI; several prompts remain source constants; full token/usage accounting and production evaluation/calibration are incomplete. | Approve provider/data-handling choices; externalize/version prompts and configuration as part of architecture phase. |
| Semantic vector retrieval | Missing | Mistral embedding adapter is implemented and unit/live verified. | No vector database/index or integrated vector retrieval. | Decide whether semantic search is required for this capstone and select storage only with approval. |
| Rate limits and public-intake policy | Missing | Authenticated intake exists. | No general rate limiting or agreed public-intake policy. | Define actor/tenant limits and abuse policy before implementation. |
| Independently deployable workers | Partial | Durable triage-job records and workers execute inside the integrated process; SLA polling also runs in-process; extraction queue is in-memory in current composition. | Workers cannot be deployed/scaled independently; cross-process job durability/leases differ by subsystem. | Approve runtime/queue infrastructure and delivery semantics before splitting workers. |
| Private storage, malware scan, retention and deletion | Partial | Local uploads are tenant-authorized and downloaded through scoped routes; file type/size validation and safe names are present. | Local filesystem is not production object storage; malware scanning, retention/deletion rules and recovery are absent. | Choose storage/scanning infrastructure and approve retention/deletion policy before implementation. |
| OpenAPI and API contract completeness | Partial | `ticket-openapi.json` and `ai-openapi.json` cover important ticket/workflow/SLA/AI routes. | No single contract for all integrated identity, documents, policies, teams, SLA administration and reporting; several Capstone endpoint names differ from actual routes. | Publish one generated integrated contract after resolving route equivalence and schemas. |
| Testing and E2E verification | Partial | Node backend unit/API tests include signed-token, tenant-isolation, persistence and complete synthetic HTTP workflows. Current backend run: 213/213 passed. Frontend typecheck, lint and production build pass. | No browser/Playwright E2E suite, no successful real-user browser login, no E2E from frontend ticket form through persisted result because ticket UI is absent. | Add browser E2E after login configuration and ticket screens are approved. |
| Deployment/handover | Partial | Local Keycloak/PostgreSQL compose, environment examples, README and operational docs exist. | App data is local JSON; no approved production app deployment, scalable storage/workers, monitoring targets or secret-manager configuration. | Record deployment/infrastructure decisions before production readiness claims. |

## 4. API equivalence against the Capstone table

All routes below are under `/api/v1`. Authentication is Keycloak bearer auth plus a verified active application membership.

| Capstone route | Current route or behavior | Assessment |
|---|---|---|
| `POST /tickets` | Same route; authenticated requester context and validated ticket persistence. | Implemented; no frontend intake screen. |
| `POST /tickets/ingest` | No route. | Missing; no external-source contract has been defined. |
| `GET /tickets`, `GET /tickets/:id` | Same paths. | Implemented with role/tenant scope; no UI. |
| `POST /tickets/:id/analyze` | Same path; classification and summary are combined. | Implemented; no separate classify/summarize routes. |
| `POST /tickets/:id/classify`, `/summarize` | No separate routes. | Missing as separate operations; combined analyze may satisfy product behavior if accepted. |
| `POST /tickets/:id/priority` | `POST /tickets/:id/recommend-priority`; manual override uses `PATCH /tickets/:id`. | Equivalent recommendation under a different name; preview remains draft/review-only. |
| `GET /tickets/:id/similar` | Same path (lexical retrieval). | Implemented; no persisted vector index or UI. |
| `POST /tickets/:id/recommend-resolution` | Same path. | Implemented and evidence-checked; no UI. |
| `POST /tickets/:id/recommend-routing` | Routing is part of `POST /tickets/:id/triage`; rule configuration is `/ai/routing-rules`. | No direct recommendation endpoint; current routing inputs are narrower than specification. |
| `POST /tickets/:id/approve`, `/reject` | Human triage review at `/tickets/:id/triages/:triageId/reviews`; other approval routes are specific to workflow, SLA, reopen or verified resolution. | No generic ticket action approve/reject endpoint; approval semantics are split by domain. |
| `GET /tickets/:id/audit` | Same path. | Implemented for ticket history; not a shared audit-log search. |
| `GET /teams` | Same path. | Implemented. |
| `GET /configuration/categories`, `POST /configuration/categories` | List effective categories or create an organisation category; disable/enable is audit-reasoned. | Implemented for organisation admins with tenant-scoped persistence; environment list remains a compatibility fallback when the organisation has no category records. |
| `POST /configuration/routing-rules` | `/ai/routing-rules` plus approve/disable actions. | Equivalent capability with different route and versioning shape. |
| `POST /configuration/priority-rules` | No tenant priority-rule CRUD route; checked-in draft priority matrix powers preview. | Missing. |
| `POST /configuration/sla-policies` | `/sla-policies`, versions, approval and activation routes. | Equivalent lifecycle exists under different paths. |

Additional existing APIs cover `/me`, organisations/users/roles/departments/teams, documents and extraction, policies, SLA evaluation/reports, ticket workflow, AI triage reports/reviews/jobs, routing rules, verified resolutions, evaluations and quality summaries. A full route inventory belongs in the integrated OpenAPI contract.

## 5. Verification evidence

| Check | Result | Limit |
|---|---|---|
| Backend `npm test` | Passed: **213 tests, 0 failures, 11 suites** on 20 November 2026. | Automated tests use isolated fixtures/stubs; does not prove production deployment. |
| Backend typecheck/build | Passed in the same-day verification. | No backend source change was made in this remediation pass. |
| Frontend typecheck/lint/build | Typecheck and lint pass; Next.js dev compilation succeeds. | Production `npm run build` currently fails with Windows `spawn EPERM`; no automated browser E2E suite. |
| HTTP smoke: backend liveness | HTTP 200. | Health only. |
| HTTP smoke: frontend page | HTTP 200. | Page delivery only. |
| HTTP smoke: frontend backend proxy `/api/v1/me` without credentials | HTTP 401. | Confirms proxy reaches protected backend and missing auth is rejected; not authenticated frontend-to-backend use. |
| Keycloak discovery | HTTP 200. | Discovery does not prove user login or application membership. |
| Keycloak discovery and authorization request for `support-web` and `http://localhost:3002/` | Discovery HTTP 200; authorization request HTTP 200 login page after updating the active local client allowlist and enabling email login. | Login was manually confirmed for support agent and support lead; no automated browser E2E suite. |
| Synthetic live AI verifier (latest run) | Groq classification/summary, integrated Inception classification/summary, Mistral embedding, priority validation, resolution safety, PDF and DOCX extraction passed. | Priority honestly returned `insufficient_information`; resolution returned `insufficient_evidence`; only synthetic data. No live human approval or production quality guarantee. |
| Real-user Keycloak login and role page verification | Manually verified for support agent and support lead. | Screenshot confirms support-lead role and Support page; team/approval queues are empty because local ticket and triage data are absent. |

The local support-agent and support-lead memberships are backend data. The sign-in route accepts email/password on Keycloak's hosted login page; the frontend never collects a password. Both role landing pages have been shown in the browser, and authenticated `/me`/ticket requests succeeded for the support lead.

### Support-lead workspace

The Capstone master prompt explicitly requires a support-lead approval queue. The ticket page now distinguishes **Team & unassigned**, **Escalations**, and **AI approvals**. AI approvals use the per-ticket triage-report/review APIs, exclude redacted/stale reports and reports already reviewed by the current lead, and record accepted/rejected/needs-information plus required reviewer comments. Support agents can create an escalation with reason and handover notes; P1 internal priority changes open one automatically. Leads see open escalations within their ticket scope and record follow-up before closing them. Backend ticket and role scope is enforced on every route. The SLA escalation threshold candidate remains draft, so time-percent triggers and outbound notifications are not activated. Resolution editing captures the actual final outcome through the existing status API, but standalone AI-quality feedback is not supported.

### Role landing-page correction

The user reported that a support-agent login still displayed the Foundation Overview and administration navigation. Inspection found that a previously started frontend process was serving the old page. The frontend now selects its landing page from the active organisation's `/api/v1/me` permissions: support-only roles land on Support tickets and do not receive Foundation administration navigation; administrator permissions enable Administration and its permitted screens. Changing organisation recalculates the landing view. The stale frontend process was stopped and the updated Next.js dev server was started with process permission; the frontend and backend readiness return HTTP 200. Frontend typecheck, lint, and diff check pass. Browser screenshots now confirm both support roles land in Support.

## 6. Main gaps and risks

1. **Frontend acceptance is partial.** Capstone ticket intake, queue, detail, triage, similar/knowledge, resolution outcomes, lead escalation/AI approval queues, operational dashboard, reports and ticket audit screens are represented. Browser E2E and populated acceptance data are still missing; generic/global audit, resolution-quality feedback, and automatic SLA threshold rules remain gaps.
2. **Authentication cannot yet be demonstrated in this local realm.** The API rejects unsigned access, and role authorization is server-derived, but the active Keycloak client rejects the port-3002 redirect URI. The role menu behavior is therefore unverified.
3. **Persistence rollout is incomplete.** Atlas is approved, but repositories still need query-oriented MongoDB implementations and integration verification; local files and attachments remain outside MongoDB. No Atlas environment, migration execution, backup/restore evidence or production cutover has been verified.
4. **Configuration/API gaps.** Categories and priority rules lack tenant CRUD; direct routing recommendation and generic action approval routes differ from the Capstone table; OpenAPI is split and incomplete.
5. **Operational controls are incomplete.** Rate limiting/public-intake policy, independently deployed workers, production private file storage, malware scanning, retention/deletion, production recovery and observability targets are unresolved or absent.
6. **Business configuration remains tenant-owned.** Real category/team routing mappings, approved knowledge/history and SLA targets/calendars must be supplied and reviewed; no values should be fabricated.
7. **Provider selection differs from the suggested stack.** Current live adapters use Inception/Groq and Mistral embeddings. Do not replace them with Claude/OpenAI without approval, credentials and data-handling review.
8. **Several source documents are stale or conflict.** Update the README, initial assessment and API/architecture docs after decisions are approved; do not treat draft designs as deployed behavior.

## 7. Proposed phased implementation plan (for approval)

| Priority | Phase | Proposed work | Decisions/dependencies |
|---|---|---|---|
| 0 | Close local sign-in verification | Update the already-imported Keycloak `support-web` redirect/origin allowlist for port 3002; verify email login; exercise the new support-agent account and separate lead/requester/admin memberships. | Local Keycloak admin access; test accounts. The client currently rejects the redirect. |
| 1 | Architecture and contract alignment | Approve the persistence target and document actual route equivalence; create/refresh integrated API and data-flow designs. Decide whether JSON is accepted for the capstone prototype or MongoDB is required. | Coach/project owner approval; MongoDB choice must not be inferred. |
| 2 | Backend requirement gaps | Define and implement only approved gaps: category/priority configuration, direct routing contract if required, audit coverage, approval semantics, rate limits and intake policy. | Permission, audit, rate-limit and approval behavior require product decisions. |
| 3 | Support frontend verification | Add authenticated browser E2E for each role and verify populated pages against synthetic data. Keep unsupported writes hidden until APIs specify them. | Browser test infrastructure and synthetic fixtures. |
| 4 | Persistence and operations | Complete and verify the Atlas repository migration and safe data cutover; decide worker deployment, private object storage, malware scanning, retention/deletion, recovery and monitoring. | Atlas selected; credentials/network access and data-governance/infrastructure decisions remain. |
| 5 | Verification and handover | Add Playwright browser flows, authenticated role tests, API contract conformance, AI evaluations and update README/OpenAPI/architecture/deployment docs with actual results. | Test users, providers, policy fixtures, approved tenant SLA/routing data. |

### Decisions to confirm before Phase 2

- Atlas has been selected for production. The remaining decision is whether JSON may remain as a local/demo adapter after the production migration.
- Should the current Keycloak public `support-web` client remain the login integration for the local frontend? (The implementation uses this existing client; its active redirect allowlist needs updating.)
- Are Inception/Groq/Mistral accepted provider choices for this project, or must Claude/OpenAI be added? No provider switch was made.

Rate limits, SLA values/calendars, retention rules and infrastructure were not invented.

### MongoDB Atlas production migration — 23 November 2026

The user selected managed MongoDB Atlas. Added the official MongoDB Node.js driver, a reusable client with connection reuse and graceful close, MongoDB-backed collection and ticket/workflow stores, production checks requiring Atlas SRV plus Keycloak, and a dry-run-first JSON import that refuses a non-empty target and leaves source files unchanged. The current MongoDB compatibility repositories still read/replace full collections; this is a migration step, not evidence of production-scale query readiness. Local Atlas credentials and network access are not available for this verification, so MongoDB integration tests are gated on `MONGODB_TEST_URI` and were not run against a live cluster. Document bytes remain in local private storage and are not transferred by the JSON collection migration.

## 8. Findings remediation update — 20 November 2026

The user authorized fixing findings before moving to the next phase. The following behavior was implemented against existing API contracts:

- Role-aware support navigation uses permissions returned by `/api/v1/me`. Requesters see ticket intake and their server-scoped ticket list; staff see the ticket list permitted by their role. Admins can see both support and Foundation views where their permissions allow it.
- Ticket intake uses authenticated `POST /api/v1/tickets`; requester and organisation identity remain server-derived.
- Ticket detail and public comments use existing ticket endpoints. The UI does not offer internal comments; the backend rejects internal comments from requesters.
- AI triage, similar/evidence retrieval and resolution recommendation are shown only with corresponding permissions. Results are displayed for human review and are not used to mutate ticket status, assignment or priority.
- Updated `frontend/README.md` coverage is still pending; the original Foundation endpoint documentation remains accurate for its earlier scope.

Checks for this update: `frontend npm run typecheck` passed; `frontend npm run lint` passed with no warnings; `git diff --check` passed. `frontend npm run build` was attempted twice and failed both times before compilation with Windows `spawn EPERM` while Next.js started its build worker. This is an environment/build-process blocker, so production build output for the new screens is unverified. No authenticated browser E2E run was performed.

Still open before a full Capstone acceptance claim: exact integrated OpenAPI coverage, API audit coverage beyond ticket history and the audit-log route, automated browser E2E coverage, category and priority administration contracts, rate limits/public-intake policy, independently deployable workers, production private storage/malware scanning/retention, actual tenant SLA targets/calendars, and the approved persistence/infrastructure target. No rate limits, SLA escalation thresholds, retention rules or infrastructure choices were invented. The support-lead Approval Queue has no local reports to populate; reviewer edits are not supported by the existing review API.

### Capstone role pages added — 20 November 2026

The frontend now includes the role-aware Capstone pages described above while preserving Foundation administration screens for users who have those permissions. Support ticket and queue access remains backend-scoped; the support lead receives team/unassigned tickets, an AI approval queue, and report/audit navigation when permitted. Organisation administrators retain Foundation management and can also enter support pages where permissions allow. Ticket detail includes attachment upload/display, structured analysis history, similar/knowledge results and resolution recommendations.

The dashboard and reports display backend/visible-ticket data, not fabricated SLA targets. Configuration reads supported policy/routing/workflow data; category and priority-scoring CRUD is absent. The audit page aggregates visible ticket history and permitted triage reviews only; it is not a global audit log. The resolution workspace edits a local draft and records final outcome/evidence through the existing approved workflow endpoint; it does not save AI-quality ratings. Escalations are manual except for internal P1 priority changes; automatic SLA thresholds and external notifications remain off while the candidate is draft.

Verification for this UI update: frontend TypeScript typecheck and ESLint passed; `git diff --check` passed; backend readiness and frontend root returned HTTP 200 after restarting the dev server. The production build failed before compilation with Windows `spawn EPERM`, and no browser E2E or authenticated interaction was run for the newly added pages. A successful root response only verifies the service is serving; it does not prove page-level workflows.

### Policy-backed escalation and resolution follow-up — 23 November 2026

The policy references require immediate P1 escalation, documented P2/authority handovers, lead follow-up, and resolution notes/outcomes. Added tenant-scoped escalation records and history events, P1 escalation on an internal P1 priority change, explicit staff escalation for other reasons, a lead/admin close action with notes, a permission-scoped open escalation queue, per-ticket workflow context, and a resolution form that edits the note before recording configured resolution evidence. Added focused API regressions; `ticket-api.test.ts` passed 19/19 including workflow-context coverage. The full backend suite passed 214/214; backend build/typecheck, frontend typecheck/lint, OpenAPI JSON parsing, and diff check passed.

The SLA source labels target values illustrative and subject to management approval. The normalized escalation threshold candidate is draft, so no percentage-based trigger, external alert, contractual tier, calendar or target was activated. API permission checks and persistence are covered by automated tests; authenticated browser E2E remains unverified for this latest change. Backend and frontend services were restarted to serve updated code.

## 9. Phase 2 architecture alignment update — 23 November 2026

This section supersedes stale architecture statements above where they conflict with the current code or approved decisions. The accessible Phase 2 master prompt describes architecture alignment and asks that existing choices be assessed rather than replaced automatically. A full Capstone DOCX was not available in the repository during this pass; the alignment below uses the master prompt, existing assessment, current architecture/deployment docs, and source inspection. It does not claim a line-by-line DOCX audit.

### Current architecture result

| Area | Phase 2 finding | Status |
|---|---|---|
| Application shape | Modular monolith with one Node HTTP listener; foundation routes use a dispatcher and domain routes use Express 5. | Aligned in principle; hybrid routing is a documented implementation detail. |
| Frontend stack | Next.js App Router, React, TypeScript. | Existing implementation; no frontend files were changed in this Phase 2 pass. |
| API | REST under `/api/v1`; integrated OpenAPI is generated and served at `/api/v1/openapi.json`. | Implemented contract; exhaustive route/schema conformance is still pending. |
| Persistence | Managed MongoDB Atlas selected by project owner for production; JSON remains local/test. | Decision recorded; live Atlas, migration, backup, restore, and scale behavior remain unverified. |
| Domain model | Identity, organisations, teams, tickets, documents, policies, SLA, AI, knowledge, reporting and audit-related behavior exist. | No performance scoring/coaching domain module was found; reference KPA/KPI documents do not establish executable behavior. |
| Authentication/authorization | Keycloak bearer verification plus active backend user and organisation membership; permissions are server-derived. | Implemented locally; production realm/user/tenant authorization requires target-environment verification. |
| AI and retrieval | Structured provider adapters and schema-validated workflows; lexical retrieval is active and an embedding adapter exists. | No vector index is active; provider/data-processing choices remain subject to acceptance. |
| Background work | AI and SLA workers run in-process; document extraction uses current queue composition. | Independently deployable worker and durable external queue are not implemented/selected. |
| Files | Private local file handling with scoped endpoints. | Production object storage, malware scanning, retention/deletion and recovery remain unselected/unverified. |
| Verification | Node built-in test runner and HTTP/API coverage. | No automated browser E2E suite established; Atlas integration test requires isolated `MONGODB_TEST_URI`. |

### Phase 2 architecture decisions and deviations

- Atlas is no longer an open database-selection question. Earlier “confirm MongoDB vs JSON” wording is superseded. JSON remains an adapter for local/test use; production uses MongoDB configuration.
- The implementation uses a hybrid Node HTTP/Express server and Node's test runner. The pasted prompt's testing and implementation stack examples are recommendations; they do not require replacing current choices.
- Inception/Groq and Mistral adapters are not being replaced without an explicit provider/data-handling decision. Current retrieval is lexical; semantic search/vector infrastructure is not assumed necessary.
- A standalone performance system, generalized approval service, audit ledger, external queue, object-storage vendor, malware scanner, hosting provider, monitoring vendor, rate-limit policy, retention schedule, recovery objectives, and tenant SLA values are not inferred from the architecture proposal.

### Documentation changes made in Phase 2

Updated `docs/architecture/Architecture.md`, `HLD.md`, `LLD.md`, `Component-Design.md`, `Data-Flow.md`, `Security-Architecture.md`, and `Database-Design.md` to distinguish current behavior from target/gap statements. These are documentation-only changes; no runtime or frontend code was changed. Database design now labels the old relational entity list as historical/conceptual and records the current Mongo collection/index approach without representing it as live Atlas verification.

### Remaining production blockers

1. Provision and verify an isolated Atlas target; run gated integration tests, index creation, migration rehearsal, backup/restore, and application smoke checks.
2. Finish bounded/query-oriented Mongo operations for remaining broad lists and free-text ticket search before production-sized use.
3. Select hosting/network configuration, production private file storage and malware scanning, and worker/queue topology.
4. Approve retention/deletion, observability and recovery requirements, and rate/public-intake rules where needed.
5. Verify real-user Keycloak membership/role authorization in the deployment realm.
6. Obtain tenant-approved SLA targets/calendars/escalation policy and any provider/data-processing approval.
7. Complete exhaustive integrated OpenAPI conformance and browser E2E verification.

### Verification scope for this documentation pass

No application tests were run because this pass changed documentation only. `git diff --check` is the applicable local check. The latest source verification recorded in [production readiness](../deployment/production-readiness.md) is 240/240 backend tests, with the Atlas integration suite skipped because `MONGODB_TEST_URI` was not configured; it also records backend typecheck/build and diff-check as passing. These results do not prove Atlas or production deployment readiness.

## 10. Phase 3 functional requirements audit — 23 November 2026

**Overall status: Partial.** The main ticket and AI flows exist in the backend and are connected to API calls in the support workspace. Focused backend tests exercise synthetic end-to-end HTTP workflows. Several requested capabilities are deliberately incomplete or lack an approved business rule; therefore Phase 3 is not a full acceptance pass. This section is a read-only audit: no application or frontend code was changed.

| Phase 3 requirement | Status | Observed behavior and evidence | Remaining gap |
|---|---|---|---|
| A. Ticket intake | Partial | `frontend/components/support-workspace.tsx` calls authenticated `POST /api/v1/tickets` through the Next API proxy. The form captures title, description, optional product, optional affected service, optional attachment, and shows the read-only signed-in requester identity. The backend derives requester and organisation from verified membership, assigns timestamps, validates and persists the record, and supports a separate scoped attachment upload. Tests cover creation, validation, tenant scope, attachment policy, and persistence (`ticket-api.test.ts`, `integrated-app.test.ts`). | Authenticated browser-to-database E2E and production file storage/scanning are unverified. Requester name/email are sourced from the linked backend user rather than copied into each ticket; requester ID is stored on the ticket. No external source ingestion route is implemented. |
| B. Configurable classification | Implemented (synthetic verification) | `TicketClassifier` receives tenant categories, rejects labels outside that set, supports multiple labels, validates exact source evidence spans, and preserves confidence/reason/uncertainty with human review. Organisation administrators can manage active categories through tenant-scoped, audited API endpoints. Environment categories remain a compatibility fallback until tenant categories are created. | Live-provider quality is not verified. Frontend rendering is outside this backend-only change. |
| C. Ticket summarisation | Implemented (synthetic verification) | Structured summary includes a concise issue summary, symptoms, attempted actions, a separate affected-functionality field, business impact, missing information, and warnings. The affected-functionality field is null when the ticket does not explicitly identify the function; strict schema validation rejects missing or malformed output. The analysis service persists analysis history without changing the original ticket; focused synthetic tests verify this. | Live-provider quality and presentation have not been verified in authenticated browser E2E or with representative tenant data. |
| D. Priority recommendation | Partial | `PriorityRecommender` assesses impact and urgency using exact ticket evidence; its instructions now explicitly consider affected scope, stated business criticality, and stated workaround availability. Deterministic matrix mapping returns no priority when evidence is insufficient and always requires human review. Authorized overrides require reason/business justification and are recorded in ticket history. | The matrix is still a checksum-verified development-only draft, not an active tenant-approved priority policy. No tenant priority-policy lifecycle or production scoring policy is active. |
| E. Similar-ticket and knowledge retrieval | Partial | `KnowledgeRetriever` filters tenant, approval, active status, effective dates, source permissions, and current-ticket exclusion before ranking; results include source/version/excerpt references. Verified resolved-ticket history and approved knowledge can be used. `retrieval-resolution.test.ts` covers cross-tenant, draft, unapproved, stale and permission-denied cases. | Retrieval is bounded lexical matching, not semantic retrieval; the Mistral embedding adapter is not connected to a persisted vector index. Relevance quality on real tenant data is unverified. |
| F. Resolution recommendation | Partial | `ResolutionRecommendationService` uses permitted evidence only, requires ordered steps with citations that exactly match retrieved passages, returns insufficient-evidence without calling the provider when no evidence exists, and leaves the ticket unchanged. Tests cover fabricated citations, evidence rejection, authorization, provider failure, and safe insufficient-evidence behavior. | There is no explicit numeric/ordinal confidence field; low support is represented by `insufficient_evidence`, missing information, and warnings. Reviewer edits are not persisted as model-review feedback; the UI can edit a local resolution draft and record the final ticket outcome through the existing status API. |
| G. Team routing | Partial | Routing uses an approved, effective category-to-team rule and a tenant-eligible team; ambiguous or absent rules return insufficient information. Recommendation is review-required and does not auto-assign. Review and assignment authorization are tested. | Product ownership, team expertise, and workload are not inputs. Routing currently has no standalone `/recommend-routing` endpoint; it is included in triage. Routing rule administration exists, but the full requested signal model is not implemented. |
| H. SLA monitoring | Partial | Versioned SLA policy lifecycle, shared or per-priority business calendars, evidence-based timestamps, risk states, pauses/exclusions, and persisted evaluation/reporting exist. Per-priority calendars are validated against configured priority targets and covered by deadline and API lifecycle tests. | Actual tenant target values, calendars, holidays, entitlements, and effective policy are not verified. Reference targets remain draft. SLA display is report/dashboard-oriented rather than verified for every authorized ticket detail. No configured update-frequency metric, time-threshold escalation action, or external notification is active. |
| I. Human approval and audit | Partial | Triage reviews support accepted, rejected, and needs-information with reviewer, reason and timestamp; workflow/SLA/reopen approvals are separate. Ticket changes (including priority overrides) retain before/after history. Admin-only `/api/v1/audit-logs` aggregates existing records. Tests cover authorization, tenant scope, immutable review decisions, ticket history and audit aggregation. | Recommendation editing is not a persisted review action; there is no universal approval manager. AI review records do not capture general before/after edits. Audit aggregation is not complete event coverage: identity/team mutations are not all written to a shared ledger. No unsupported external action/customer message is performed automatically. |

### Functional workflow traces

| Flow | Source path | Verification status |
|---|---|---|
| Requester ticket submission | `frontend/components/support-workspace.tsx` → `frontend/lib/api.ts` → Next proxy `frontend/app/api/backend/[...path]/route.ts` → `backend/src/integrated-app.ts` / `backend/src/modules/tickets/api.ts` → ticket store and attachment service | Backend synthetic HTTP creation/persistence is tested. UI-to-running-backend authenticated browser flow is not automated or verified in this pass. |
| AI analysis and triage | Support workspace actions → `/tickets/:id/analyze` or `/triage` → `TicketAiAnalysisService` / `TicketAiTriageService` → classifier, summarizer, priority, retrieval, resolution, routing and SLA capabilities → persisted analysis/triage history | Synthetic HTTP integration passes. Live provider quality and authenticated browser display are not established by these tests. |
| Human review | Lead review UI → `/triages/:triageId/reviews` → permission and snapshot checks → persisted immutable decision | Synthetic API authorization and persistence tests pass; browser E2E remains unverified. |
| SLA and reports | SLA policy/evidence APIs → evaluator and in-process worker → persisted evaluations → reports/dashboard API | Engine and synthetic integrated API tests pass; no active tenant-approved SLA configuration is verified. |

### Verification run for this audit

- The standard `npm test` command was attempted from `backend/`; Node's test runner failed to spawn per-file workers with Windows `spawn EPERM` (35 worker-launch failures, not assertion failures).
- To obtain relevant evidence without worker spawning, the affected test files were run directly with `node --import tsx`: `ticket-api.test.ts` (**20/20**), `ticket-ai-api-integration.test.ts` (**4/4**), `ticket-ai-phase1.test.ts` (**9/9**), `priority-recommendation.test.ts` (**16/16**), `retrieval-resolution.test.ts` (**11/11**), `sla-engine.test.ts` (**8/8**), and `integrated-app.test.ts` (**25/25**). Total: **93/93 passed** across seven files.
- Tests use isolated synthetic fixtures, local adapters and deterministic provider stubs. They do not verify MongoDB Atlas, real provider quality, live tenant data, or browser E2E.
- No frontend build/typecheck/lint or full suite was rerun for this functional audit. The prior documented full backend result is 240/240; it is historical evidence, not a rerun result for this pass.

### Phase 3 conclusion

Core ticket intake, validated AI assistance, evidence-scoped retrieval/resolution, draft priority recommendations, policy-based routing, SLA evaluation, and human review are present and have meaningful synthetic backend coverage. Classification behavior (configured multi-label assignment with evidence and tenant category administration) is now implemented with synthetic verification. Overall Phase 3 requirements remain **Partial** because approved scope/SLA-linked priority, semantic retrieval, routing workload/expertise/product signals, persisted recommendation edits, and complete audit coverage are absent or not approved. Authenticated browser E2E remains unverified. Do not fill business-policy gaps with invented defaults.

### Ticket intake follow-up — 23 November 2026

The requester form now includes optional product and affected-service inputs and submits non-empty values to the existing authenticated `POST /api/v1/tickets` operation. It displays the signed-in user's name/email as read-only requester context. The API remains authoritative: requester ID and organisation are derived from the validated principal/membership, and timestamps are assigned by the backend. The file picker now advertises the attachment extensions accepted by the existing server validation. No generic `/tickets/ingest` endpoint was added because the stated requirement is requester UI or secured API intake; the secured API already exists. API persistence regression now asserts requester ID, product, affected service, and server timestamps. Backend ticket API tests passed **20/20**; frontend TypeScript typecheck and ESLint passed. The authenticated browser-to-backend flow and production file storage/scanning remain unverified, so end-to-end/production intake acceptance is still Partial.
