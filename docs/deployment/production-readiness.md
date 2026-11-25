# Production readiness status

**Status: not ready for production traffic.** MongoDB Atlas was selected by the project owner on 23 November 2026. This document tracks verified implementation separately from required deployment and business decisions.

## Implemented in the application

- Normal development and production configuration default to MongoDB and reject JSON persistence outside the test environment. The configured Atlas URI passed a read-only ping and Mongo application index initialization. The approved local-data import is complete; authenticated application acceptance, backup/restore and production access controls remain open. Startup requires an Atlas SRV URI, database name and Keycloak authentication settings.
- A shared MongoDB client is connected once, reused, checked by readiness, and closed on server shutdown. Driver pool/timeouts remain at driver defaults until deployment traffic and connection metrics justify tuning.
- Multi-record MongoDB operations run through the Node driver's `withTransaction` retry helper; nested persistence calls reuse the active session.
- Graceful server close waits for in-flight AI triage and SLA worker runs before closing MongoDB, avoiding background writes against deleted or closed storage.
- The HTTP server applies `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a strict-origin cross-origin referrer policy, and a restrictive camera/microphone/geolocation permissions policy to both foundation and Express responses. Express `X-Powered-By` disclosure is disabled. HSTS remains the TLS-terminating platform's responsibility because no TLS/proxy termination configuration is selected in the application.
- MongoDB stores application records individually with string IDs and a separate `app_` collection namespace. Tenant, membership, version, SLA-history, ticket-source and active-workflow indexes are provisioned by the application adapter.
- Identity reads now use a structured query port implemented by both JSON and MongoDB adapters; MongoDB resolves IDs through `_id` and applies indexed tenant/user membership filters rather than loading all users and memberships for each authorization lookup.
- Organisation, team and document repositories use structured tenant-scoped query filters for common lookups and membership/status checks. Document create/status/version mutations now load and write only the active tenant's records through the Mongo adapter; JSON fallback behavior preserves other tenants and rejects ownership changes. Document version, extraction job/history, policy approval, extraction result, ticket source document, and approved-knowledge queries are tenant and document/version scoped, with matching MongoDB indexes; the JSON adapter retains legacy-array migration behavior.
- SLA evaluation history queries filter in the persistence adapter by tenant and, when requested, ticket ID.
- Common policy, policy-version and extracted-rule lookups are filtered by tenant in persistence queries; extracted-rule listing has a matching tenant/version index.
- Policy, version, extracted-rule, approval, and policy-audit mutations now use tenant-scoped MongoDB reads and record-level writes. Multi-record review and activation paths retain their existing transaction boundaries.
- Extraction job enqueue/claim/update, extraction history, SLA evaluation history, and knowledge-publication audit appends now use tenant-scoped mutations. Extraction-job updates preserve the stored job ID and tenant identity.
- AI analysis, workflow-run and operation history lookups filter by organisation plus ticket or operation kind, with compound indexes for those access patterns.
- The admin-only `/api/v1/audit-logs` feed reads tenant-filtered existing audit records and has an organisation/creation-time compound index; it does not yet create identity or team audit events.
- AI worker polling queries queued/running jobs only before applying its existing due-time checks; job polling has a MongoDB compound index.
- The ticket list endpoint uses tenant/role-scoped MongoDB filters, field projection, count, sort and limit/offset for status, priority, team and requester filters. Free-text `q` keeps the existing application-side matching path and still loads its authorized candidates before paging.
- The support escalation queue queries open escalations in MongoDB with tenant and server-derived requester/team/unassigned scope, backed by an escalation queue index. The API rechecks ticket access before returning records.
- MongoDB-backed tenant mutations now load and write only the selected tenant for team, membership, AI operation/history, document, policy, extraction, and SLA history records. User and organisation creation now use direct inserts, and their updates/deletes use `_id` point operations rather than collection snapshots. Compatibility snapshot writes still exist for legacy/global records and apply deltas rather than clearing collections.
- MongoDB now enforces case-insensitive unique indexes on user email and organisation name, matching existing duplicate checks. Duplicate-key races map to the existing 409 API errors, and failed organisation creation rolls back its provisional membership. User and organisation create/update/delete no longer need whole-collection mutation paths; the organisation administration list remains unbounded.
- `backend/scripts/migrate-json-to-mongodb.ts` inventories supported JSON collections by default and validates record IDs, selected domain schemas, and tenant ownership before opening a database connection. AI workflow runs use `runId` as their Mongo storage `id` while retaining the JSON/API shape. `--apply` refuses application collections containing records, tolerates only empty pre-indexed collections, creates indexes before import, verifies per-collection counts inside the import transaction, and leaves source JSON unchanged.
- Backend and frontend container build definitions run as non-root users and exclude local environment files from build contexts. Frontend Keycloak values are public build arguments; secrets belong in the deployment secret store.
- The backend image must be built with repository root as context (`docker build -f backend/Dockerfile .`) so it can copy both `backend/` and `docs/`; the runtime image includes the OpenAPI documents read by Swagger. A root `.dockerignore` excludes frontend sources, local data, dependencies, build output, and environment files. Docker image build could not be run here because access to the Docker Desktop Linux engine pipe is denied.

## Required before production

1. **Finish query-oriented repository migration.** Several tenant workflows now use scoped mutations and structured queries. Some tenant and administrative lists still load all matching records, and free-text ticket search still scans authorized candidates in application code. Replace broad read paths with indexed operations and review bounded pagination before production-sized data; no scale testing has been done.
2. **Harden production Atlas access.** The isolated Atlas persistence suite passed **20/20**, including transaction/rollback, selected index inspection, tenant-scoped ticket/workflow writes, and a synthetic migration import. The main URI passed a read-only ping. Before production, verify restricted network access and least-privilege database permissions; no writes or migration were made to the main database.
3. **Validate imported data and plan traffic cutover.** The configured Atlas database now contains 80 records imported transactionally from 18 validated local collections; per-collection counts matched and the JSON source remains unchanged. Review the imported data through authorized application access, take a protected restorable backup, and plan a controlled traffic cutover. The migration does not move local document or ticket-attachment bytes.
4. **Choose production file storage and scanning.** Document content and ticket attachments still use local private storage. Select a production storage service and malware-scanning process before accepting customer files. No provider has been chosen.
5. **Separate durable workers.** Triage/SLA/extraction workers currently run with the API or use local process composition. Select and implement a deployable worker/queue topology, retry ownership and shutdown behavior.
6. **Complete audit and operational policies.** `/api/v1/audit-logs` is admin-only and aggregates existing organisation-scoped policy/knowledge, AI governance and ticket-history records. Identity/team mutations and other events do not yet write to a common audit ledger. Rate limits and public-intake rules, data-retention periods, recovery targets and observability/alerting thresholds have not been specified; do not invent them.
7. **Approve tenant business configuration.** Real SLA targets/calendars, escalation thresholds, routing mappings, approved knowledge and performance formulas require tenant owners. Reference templates remain inactive.
8. **Configure identity and providers.** Supply production Keycloak issuer/client redirect configuration and provider secrets through a secret manager. Validate a real user's active backend membership and each role in the target environment without exposing credentials.
9. **Verify release artifacts and deployment.** Docker was unavailable in this workspace because the Docker Desktop Linux engine pipe did not respond. Container images, production frontend build, authenticated browser E2E, backup/restore and rollout/rollback have not been verified.

## Historical MongoDB verification records

- MongoDB Node.js driver `7.9.1` installed; package audit reported zero vulnerabilities at installation time.
- Latest verification: backend suite **240/240 passed** across 14 suites; the gated Atlas/replica-set integration suite remains skipped because `MONGODB_TEST_URI` is not configured. Focused audit, Swagger and route-parity regression tests passed **3/3**. Backend typecheck, production build, and `git diff --check` passed. Tests exercise local stores and mocked MongoDB interfaces; no Atlas transaction, server-side index, migration, backup or restore was exercised.
- The latest migration dry run validated one supported local collection and reported its count only. It did not connect to MongoDB or modify source data; the current local directory contains no workflow-run records, so the workflow-run migration path is covered by the focused regression test rather than this dry run.
- Backend TypeScript typecheck and production build passed. The build includes the migration CLI.
- Frontend production build passed with an isolated `.next-production-check` directory; its standalone artifact served `/` and the backend readiness proxy with HTTP 200. The isolated build output was removed after smoke verification.
- After implementation checks, local backend readiness and frontend root both returned HTTP 200 in development JSON mode; this did not connect to Atlas.
- Migration dry run read five supported collections and reported counts only; it did not connect to MongoDB or change source files.
- No Atlas credentials or test URI were supplied to the process, so no network connection or production-data migration was attempted.

### Atlas verification update — 24 November 2026

An isolated Atlas test URI was configured after the earlier checks. The current MongoDB
persistence test source passed **20/20** when transpiled with the local TypeScript API and run
directly (the normal Node test runner is blocked by sandbox `spawn EPERM`). Separate disposable
Atlas databases verified transactional rollback, tenant isolation, selected physical indexes,
and transactional import/count verification. The main connection was checked with a read-only
ping only. Atlas backups/restore, production cutover, and production access restrictions remain
unverified. All temporary test databases were dropped; no main-database data was changed.

### User-approved main Atlas import (24 November 2026)

The main target was rechecked immediately before migration: 21 `app_` collections existed
with zero records. The dry-run importer validated 80 records from 18 supported local JSON
collections. After the user approved the import, the same importer committed the records in
one MongoDB transaction and verified each collection count. A separate read-only count pass
confirmed 80 records across those 18 collections. Source JSON files were left unchanged.
Document and attachment bytes were not copied. The current Atlas database therefore contains
imported application records, but backup/restore, authenticated API acceptance, and traffic
cutover are still required before production use.
