# Repository Assessment

**Project:** AI Support Ticket Triage Agent
**Assessment date:** 2026-11-17
**Scope:** Repository baseline and backend foundation (Thuto)

## 1. Repository findings

### Existing stack and application

- No frontend application or backend runtime was present at assessment time.
- The backend consisted of `backend/src/` placeholder directories and six JSON seed files. There was no package manifest, lockfile, TypeScript configuration, entry point, route, middleware or service implementation.
- The seed files (`organisations`, `users`, `teams`, `tickets`, `sla-policies`, `knowledge-articles`) each use `{ "schemaVersion": 1, "records": [] }`; all collections were empty.
- There was no authentication provider/session implementation, user or membership model, role catalogue, tenant resolver, persistence adapter, environment configuration, logger, error handler, health check, or test/build/lint setup.
- Architecture documents recommend TypeScript and a modular monolith, define `/api/v1`, tenant isolation, JSON as the initial application store, a `TenantContext` shape and a standard error envelope. These conventions are reusable design inputs, not pre-existing code.

### Commands and baseline results

- Runtime present: Node.js `v22.19.0`, npm `10.9.3`.
- No existing build, lint, or test command could be run because no package manifest or scripts existed. No baseline tests were present.
- The npm package metadata lookup did not return usable output; no external dependencies were added.

## 2. Gaps and reusable conventions

The API bootstrap, shared middleware, identity, tenant context enforcement, RBAC, organisation/team modules, JSON repositories and tests all required implementation. Existing module placeholders, seed file names/envelope, API base path and documented contracts provide extension points. The repository's previous initial assessment stated the source repository was unavailable; this document replaces that stale finding with the observed baseline.

## 3. Decisions and implementation boundary

The source documents require JSON files for the initial phase and leave the framework, identity provider/session model, final permission mapping, and JSON concurrency strategy open. The tenant boundary is mandated, but membership and active-tenant selection behavior needs an agreed contract. These decisions block secure authentication, membership-based tenant resolution, protected business endpoints and concurrent JSON persistence. No identity provider, permissions or business operations are invented here.

The initial foundation uses Node's built-in HTTP server to avoid making an unapproved framework choice. Authentication and tenant resolution are represented by provider interfaces; no request header is treated as authenticated identity. Until a verifier and membership provider are configured, authenticated endpoints are not exposed.

## 4. Baseline implementation status

Implemented since the baseline: a Node HTTP/TypeScript bootstrap; Keycloak OIDC bearer-token verification; Keycloak user invitations through the Admin REST API; request IDs, structured logs, health endpoints and shared errors; active membership-based tenant resolution; a mapped RBAC policy that denies unknown roles/permissions; organisation, identity and team services; tenant-filtered JSON repositories; and setup/API integration notes in `docs/backend-foundation.md`.

The JSON adapter validates envelopes and IDs, uses atomic replacement, serializes read-modify-write operations and uses a lock file to prevent overlapping process writes. Tests use Node's built-in test runner without external packages.

`npm test` passes 22 tests. `npm run typecheck` and `npm run build` both pass after installing the locked TypeScript and Node type dependencies. The compiled server starts and both liveness and readiness endpoints return success on Node 22.

## 5. Remaining decisions and follow-up

The local Keycloak development stack is configured at `http://localhost:8081` (port 8080 remains occupied by the KnowledgeOps instance). The `ai-support` realm publishes the expected issuer and `support-api` audience. The backend's ignored local `.env` enables Keycloak verification and has a confidential service-account client; its service account can obtain a token and query users. SMTP is not configured, so invitation emails have not been verified or sent. The backend also passed a live readiness check and returned `401` for `/api/v1/me` without a bearer token.

1. Verify a real user's Keycloak access token against `/api/v1/me` end to end.
2. Review role-to-permission grants and role-assignment constraints with the team; unmapped roles and permissions remain denied.
3. Agree on active-organisation selection and whether organisation creation is tenant-admin scoped or platform scoped. Status transitions are implemented: only a member with the `organisation.update` permission can change status, and tenant routes reject inactive organisations while the management path allows an authorised member to reactivate them.
4. The JSON lock prevents overlapping writers, but stale-lock recovery and multi-host writes need an operational decision. Keep this JSON adapter single-instance/single-host.
5. Configure SMTP only if the team wants to test invitation email delivery.
