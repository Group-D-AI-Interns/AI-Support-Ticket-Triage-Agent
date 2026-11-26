# Phase 11 — Non-functional requirements audit

**Assessment date:** 24 November 2026  
**Evidence level:** Source review and synthetic tests; no production load, penetration, Atlas, or deployment test was performed.

## Summary

The codebase has useful application-level controls for security, provider failure handling, typed contracts, pagination, database indexes, and basic operational logs/health checks. It is not yet demonstrated as a production-scale or fully observable service. Several runtime components remain process-local, there is no aggregate metrics endpoint or load-test evidence, and data retention/deletion policy has not been selected. No numerical performance, availability, or retention targets were invented for this audit.

## Requirement matrix

| Area | Assessment | Evidence | Remaining gap |
|---|---|---|---|
| JWT/session security | **Implemented in code; deployment unverified** | Keycloak JWT signature, issuer, audience, bearer type, subject, expiry and not-before validation; JWKS discovery/cache. Browser uses authorization code with PKCE and refreshes tokens in memory. | No live browser/session or production Keycloak deployment verification in this pass; revocation latency is not measured. |
| RBAC and least privilege | **Implemented in code; operational verification partial** | Backend derives permissions from active application users and memberships. Ticket ownership, team scope, tenant boundaries and protected actions have regression tests. | The live role-by-role matrix and production database credential grants are unverified. Frontend visibility is not the authorization boundary. |
| Input and file validation | **Implemented in code** | Strict request schemas, body size limits, multipart file-count/size limits, extension/MIME and file-signature checks, tenant-scoped private local storage and download authorization. | File scanning and production storage controls are absent/unselected. Signature validation does not replace malware scanning or full parser hardening. |
| Secrets management | **Partial** | Tracked examples use blank secret values; backend-only keys are not exposed in frontend code. Production startup requires Keycloak and Mongo configuration. | A deployment secret manager, rotation evidence and least-privilege Atlas user configuration are not demonstrated. Local `.env` use is not a production secret-management system. |
| Timeouts and bounded retries | **Implemented with configuration caveat** | Provider adapters accept abort signals/timeouts; Inception fallback and AI jobs use bounded retry counts; errors are normalized; failed provider work does not commit a recommendation. | Retry/time limits are configurable, but there is no maximum cap on all provider retry/backoff environment values. No dependency-wide timeout or production latency test was run. |
| Idempotency | **Partial** | Automatic triage jobs use deterministic keys from tenant, actor, ticket snapshot and taxonomy; extraction candidate rules derive stable IDs; workflow writes have duplicate/conflict guards. | Ticket creation has no request idempotency key, so a client retry after an ambiguous network failure can create a duplicate. Idempotency expectations are not specified for every write. |
| Graceful failure and error states | **Implemented in code** | Safe task errors, retryable/permanent classifications, failed job state, HTTP request IDs and typed validation/error responses. | No fault-injection or outage test against deployed providers/Atlas was run in this pass. |
| Pagination | **Implemented, depth varies by repository** | Ticket lists accept bounded limit/offset. Mongo ticket reads filter, count, sort and paginate in the database. Other JSON-backed list APIs generally load scoped records before slicing. | Atlas query plans and large-tenant response times are not measured; some Mongo compatibility reads still materialize broader collection snapshots. |
| Database indexes | **Defined and unit-tested; live unverified** | Mongo adapters declare tenant, queue, identity, membership, policy, audit and AI history indexes. Mock adapter tests inspect the index definitions. | No Atlas query-plan or production-index verification was performed in this Phase 11 run. |
| Asynchronous processing and execution limits | **Partial** | AI triage has persisted jobs, leases, attempt limits and an opt-in daily budget. SLA evaluation has a configurable interval. Provider token, timeout and retry settings are configurable. | Document extraction uses an in-memory queue. SLA and AI workers run inside the API process. SLA polling scans tickets by organisation; no scale/load evidence exists. |
| Statelessness and scalability | **Partial** | HTTP request handling is modular and the Mongo adapters support tenant filters. Provider implementations are behind typed interfaces. | Process-local rate-limit state, local file storage, JSON adapter locks, in-process workers and an in-memory extraction queue prevent safe horizontal scaling without additional shared services. |
| Maintainability and contracts | **Strong code-level evidence** | Modular TypeScript modules, Zod/domain validation, API schemas/OpenAPI, ESLint, type-checking, unit and integration tests. | Some compatibility paths still use collection snapshots; no maintainability or change-failure trend metrics are collected. |
| Structured logs and execution tracing | **Partial** | HTTP logs include timestamp, request ID, method/path, status and duration. AI execution records include execution ID, provider/model, attempt count, duration and provider-reported token counts when available. Worker failures are logged without raw exception content. | There is no distributed trace context, central log pipeline, retention policy for logs, or aggregate latency/error/usage metrics endpoint. Log formats are not fully unified. |
| Health checks | **Implemented at basic level** | `/health/live`, `/health/ready` and `/api/v1/health` exist. Readiness checks the configured persistence adapter (JSON access or Mongo ping). | Readiness does not establish Keycloak, LLM, worker, file-storage or malware-scanner readiness; no deployment probe behavior was exercised. |
| Data minimisation and ownership | **Implemented in key paths** | Ticket read projections and scoped repositories limit returned data; the backend resolves tenant and role scope; attachment storage keys are not returned; old AI evidence is redacted when source access changes. | Not every route/data store has been independently audited with a production dataset. AI history and source documents still require a defined lifecycle. |
| Retention and deletion | **Not complete; policy-dependent** | Attachment cleanup exists for failed operations and some source withdrawal/redaction behavior exists. | No approved retention schedule, general ticket/document/account deletion contract, or cross-store deletion verification exists. These require owner/legal policy decisions; this audit does not invent them. |

## Targeted verification

Focused synthetic suites passed **78/78 tests across 11 suites** covering health/readiness and environment checks, JWT validation, role and tenant authorization, rate limits, ticket pagination and attachment policy, provider timeouts/retries, Mongo index/query adapter behavior, and SLA worker scheduling. The MongoDB live integration suite was skipped because `MONGODB_TEST_URI` was not provided; no live Atlas access was attempted.

Backend source type-check, production build, full test-project type-check, and `git diff --check` passed. These checks establish code behavior in the test adapters, not production capacity or uptime.

## Actions and decision boundaries

1. Define acceptable latency, throughput, availability and worker recovery targets before performance/load testing; none are specified in the current Phase 11 checklist.
2. Keep the API single-process until a shared rate limiter, durable extraction queue, independently deployable workers and shared private object storage are selected and verified.
3. Agree idempotency behavior for ticket intake and other retryable writes before exposing automatic client retries.
4. Select and document secret management, Atlas least-privilege roles, log retention, private file scanning, backup and restore operations for deployment.
5. Approve retention/deletion requirements before adding purge jobs or deletion endpoints. Verify deletion across ticket records, attachments, AI history, audit records and provider-held data according to that policy.
6. Add deployment-backed load/fault tests and aggregate telemetry only after targets and deployment boundaries are approved.

Phase 11 is **partially verified**. Code-level controls and targeted regression tests pass; production reliability, scale, observability, and privacy lifecycle requirements remain open or depend on owner-selected policy and infrastructure.
