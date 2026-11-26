# High-Level Design

**Status:** Current implementation view with production gaps identified; reviewed 23 November 2026.

## Runtime components

| Component | Current responsibility | Current boundary / limitation |
|---|---|---|
| Node HTTP server | Starts the integrated application, applies shared request context and dispatches requests | One process; not an independently scalable API and worker topology. |
| Foundation route dispatcher | Health, identity, organisation, department, team, and related foundation endpoints | Manual dispatcher in `backend/src/app.ts`; some foundation routes are outside the integrated Express OpenAPI route inventory. |
| Express domain application | Ticket, AI, document, policy, SLA, knowledge, reporting, audit, and OpenAPI endpoints | Composed into the same listener; most ticket routes are concentrated in `backend/src/modules/tickets/api.ts`. |
| Authentication and tenant context | Verifies Keycloak JWT, resolves active backend user and membership, derives role permissions | API is authoritative; role-based UI visibility does not replace server checks. |
| Domain/application modules | Apply use cases, workflow checks, AI orchestration, policy lifecycle, SLA evaluation | Modular monolith; layering is not uniform in every module. |
| Persistence ports and adapters | MongoDB persistence for normal application startup; JSON fixtures only in tests and the offline demo | Configured Atlas ping, index initialization and record import passed. Backup/restore, traffic cutover and production-scale query behavior remain open. Some compatibility reads remain broad. |
| Provider adapters | Structured generation and embedding interfaces | Live providers are configured through adapters; semantic/vector retrieval is not active. |
| In-process workers and extraction jobs | AI triage and SLA polling; extraction job processing | Not independently deployable. The extraction queue composition is not a durable external broker. |
| Local file storage | Stores document and ticket attachment bytes with scoped API access | Production private object storage, malware scanning, retention, and restore are not configured. |

## Main request flows

1. The client sends a bearer-authenticated request through its configured same-origin API path.
2. The integrated server routes foundation paths to the foundation dispatcher and domain paths to Express.
3. Authentication resolves the principal; active backend membership and permission policy establish tenant scope before protected use cases proceed.
4. Domain services validate input, apply workflow rules, and use repository/persistence ports. MongoDB is mandatory for normal development and production startup; JSON is test/demo-fixture-only.
5. AI operations call a structured provider adapter, validate results, attach execution/provenance information, and return recommendations for review. They must not bypass governed ticket or policy transitions.
6. Background processing is currently hosted in the backend process. SLA and AI jobs persist state where implemented, while extraction queue delivery is not an independently durable deployment boundary.

## Data ownership

MongoDB stores application records in `app_` collections. Ticket/workflow stores and compatibility persistence adapters map existing domain IDs to string `_id` values. Ticket comments, attachments metadata, escalation history, and related ticket state may be nested in ticket records; document bytes and ticket-attachment bytes remain in local file storage. The [database design](Database-Design.md) records collection/index details and migration limits.

## Production readiness boundaries

Atlas is the selected application database; connectivity, index initialization and the approved record import have passed. Authenticated application acceptance, backup/restore, production traffic cutover and production query sizing remain unverified. The following are not present as configured production services: independent workers, external durable queue, private object-storage service, malware scanner, vector index, and production telemetry/alerting. Exact hosting, retention, recovery targets, and rate/public-intake behavior are unresolved where the requirements do not specify them. See [production readiness](../deployment/production-readiness.md).
