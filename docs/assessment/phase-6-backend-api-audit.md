# Phase 6 — Backend API audit

**Audit date:** 24 November 2026  
**API base:** `/api/v1`  
**Scope:** Compare the Phase 6 master-prompt endpoint table with the integrated server, request validation, authorization, persistence, responses, OpenAPI, and automated tests. This is a source-and-test audit; it is not a live-provider or production-tenant verification.

## Endpoint mapping

| Master-prompt contract | Implemented route | Finding |
|---|---|---|
| `POST /tickets` | `POST /api/v1/tickets` | **Exact.** Authenticated requester identity supplies the requester ID. Strict body-field allowlist and required title/description validation; returns 201 and persists through the configured ticket store. |
| `POST /tickets/ingest` | No external-ingestion route. Authenticated `POST /api/v1/tickets` remains available. | **Missing as a distinct external-source operation.** The Jira webhook was removed at the owner's request. Generic external intake is not specified well enough to add a replacement contract. |
| `GET /tickets` | `GET /api/v1/tickets` | **Exact.** Validated filters, pagination, tenant and role/team scope. |
| `GET /tickets/:id` | `GET /api/v1/tickets/{ticketId}` | **Exact.** Caller-scoped retrieval; inaccessible tickets fail as not found. |
| `POST /tickets/:id/analyze` | `POST /api/v1/tickets/{ticketId}/analyze` | **Exact.** Runs classification and structured summarisation; authenticated, permission-checked, strict empty body, safe unavailable/provider errors. |
| `POST /tickets/:id/classify` | Included in `/analyze` and `/triage` | **Combined operation.** Classification is available as a typed result, but there is no separate classify-only route. |
| `POST /tickets/:id/summarize` | Included in `/analyze` and `/triage` | **Combined operation.** Summary is available as a typed result, but there is no separate summarize-only route. |
| `POST /tickets/:id/priority` | `POST /api/v1/tickets/{ticketId}/recommend-priority` | **Equivalent.** Evidence-backed recommendation only; requires AI-review permission and an active source-verified tenant policy in production (or explicit development draft configuration). Does not mutate the ticket. |
| `GET /tickets/:id/similar` | `GET /api/v1/tickets/{ticketId}/similar` | **Exact.** Permission-filtered historical resolution evidence. Retrieval is lexical; no vector index is claimed. |
| `POST /tickets/:id/recommend-resolution` | `POST /api/v1/tickets/{ticketId}/recommend-resolution` | **Exact.** Ordered recommendations require citations to authorized evidence; insufficient evidence is returned safely. |
| `POST /tickets/:id/recommend-routing` | Routing result in persisted `POST /api/v1/tickets/{ticketId}/triage` | **Composed operation.** Full triage includes the routing recommendation; no focused routing-only endpoint exists. |
| `POST /tickets/:id/approve` and `/reject` | `POST /api/v1/tickets/{ticketId}/triages/{reportId}/reviews` | **Decision contract differs.** One immutable review endpoint accepts `accepted`, `rejected`, and `needs_information`, records reviewer/reason/time, and may save a citation-validated resolution revision. It does not change ticket state. |
| `GET /tickets/:id/audit` | `GET /api/v1/tickets/{ticketId}/audit` | **Exact.** Ticket-scoped history with backend access checks. Organisation-wide audit is a separate administrator-only `GET /api/v1/audit-logs`. |
| `GET /teams` | `GET /api/v1/teams` | **Exact.** Authenticated tenant/team permission and pagination. |
| `POST /configuration/categories` | `POST /api/v1/configuration/categories` | **Exact.** Tenant configuration permission, strict schema, tenant persistence, and audit. |
| `POST /configuration/routing-rules` | `POST /api/v1/ai/routing-rules` | **Equivalent path differs.** Creates a draft; separate approve/disable routes govern use. Rules are recommendations and do not assign tickets. |
| `POST /configuration/priority-rules` | `POST /api/v1/configuration/priority-rules` | **Exact.** Versioned draft references a processed tenant document/version; separate reasoned approval and activation; source checksum rechecked; prior active version archived; lifecycle audited. |
| `POST /configuration/sla-policies` | `POST /api/v1/sla-policies` plus version `/approve` and `/activate` routes | **Equivalent path and lifecycle differ.** Draft policy/version creation is separate from approval and activation; the SLA evaluator uses active versions only. |

No compatibility aliases were added for operations already available through a combined route. This follows the master prompt's direction to check for equivalent functionality before creating duplicate endpoints.

## Cross-cutting API checks

- **Server composition:** Foundation and ticket/AI modules share one HTTP server. The main module dispatches `/api/v1` ticket, document, AI, SLA, report, and configuration routes to the Express ticket application. Production persistence is selected by server configuration; MongoDB mode injects Mongo-backed ticket and shared-record stores, while local/test mode can use JSON stores.
- **Authentication and authorization:** Integrated requests use verified Keycloak identity, active tenant membership, server-derived roles, and route-specific permissions. There are no source-specific authentication bypasses. Frontend visibility is not the authorization boundary.
- **Validation and errors:** Ticket routes reject unknown body fields and validate route/query/body inputs; AI operation contracts use strict Zod schemas. Shared API errors use an error code/message/request ID envelope. JSON success responses use `data` and `requestId`, with pagination where applicable. Asynchronous triage offers queued jobs and status routes.
- **Persistence and side effects:** Ticket creation, audit/history, triage reports/reviews, configuration versions, and SLA lifecycle data persist through their repositories. Recommendation endpoints do not apply ticket changes. Review decisions do not execute ticket actions.
- **OpenAPI:** `docs/api/integrated-openapi.json` uses server `/api/v1`, contains 78 paths and 95 operations after removal of the Jira webhook, and assigns unique operation IDs. The integration regression checks literal ticket/AI routes and the Phase 6 contract routes, including dynamically constructed lifecycle routes; it also verifies the removed Jira path is absent.
- **Automated tests:** Coverage includes authenticated ticket creation/list/detail/pagination/permissions, removed-webhook route authentication/absence, analysis/triage, priority/recommendation failure handling, lexical retrieval and resolution evidence, routing/category lifecycle, review immutability, SLA approval/activation, ticket audit, and integrated OpenAPI coverage. These are synthetic tests; they do not establish live Keycloak user membership or production Atlas availability.

## Findings and limits

The endpoint table's capabilities are present, with route-name or composition differences called out above. Generic external ingestion and focused classify-only, summarize-only, or routing-only routes are not separately specified beyond the table. If those distinctions are required by a consumer, define their request/authentication contracts before adding routes. Semantic retrieval remains lexical, as documented elsewhere. No rate-limit, SLA target, or external-ingestion behavior was inferred during this audit.

**Phase 6 result:** API base path, authentication/authorization, validation, persistence, response/error envelope, OpenAPI coverage, and automated integration coverage are implemented and tested in the repository. Route-name differences are documented. Production-provider, production-Atlas, and real-user authorization remain environment-dependent and were not exercised by this audit.
