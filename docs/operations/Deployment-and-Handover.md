# Deployment and operational handover

**Reviewed snapshot:** `f764c51`, 19 November 2026.

## Deployment status

The local development pieces are available, but the application is **not ready for a unified hosted deployment**. The shared API is Node.js/TypeScript; the ticket API is a separate Python/FastAPI app with development-principal authentication. They are not mounted behind one service or using one Keycloak request path. The TypeScript build currently fails in document/policy modules, and `npm ci` fails because the lockfile is out of sync with `package.json`.

Do not publish this snapshot as a production system. Use the local setup below for team development while the blockers listed at the end are assigned and resolved.

## Local development topology

- Keycloak and PostgreSQL run through `deploy/keycloak/docker-compose.yml`.
- Keycloak is available at `http://localhost:8081` in the `ai-support` realm. Port 8080 is reserved by the local KnowledgeOps Keycloak on Thuto's machine.
- The Node shared API listens on `127.0.0.1:3000` by default and reads `backend/.env`.
- The Node API writes runtime records under `backend/.local-data` by default when started from `backend`.
- Each developer has a separate Keycloak database, users and JSON data. Local account changes do not sync between teammates.
- The FastAPI ticket app has a separate Python environment/configuration and is not part of the Node API's startup, shared health checks or deployment.

## Start local Keycloak (PowerShell)

From the repository root:

```powershell
Set-Location .\deploy\keycloak
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d
docker compose ps
```

Set distinct strong local bootstrap and database passwords in the ignored `deploy/keycloak/.env`. The imported realm is `ai-support`, and the expected API audience is `support-api`. Verify the realm discovery document:

```powershell
Invoke-RestMethod http://localhost:8081/realms/ai-support/.well-known/openid-configuration
```

Its `issuer` must be exactly `http://localhost:8081/realms/ai-support` for this local configuration. In Keycloak, the `support-web` redirect URI is a placeholder and must be replaced with the actual local frontend URL. Invitation mail requires SMTP; user management also requires the service-account roles and its generated secret configured in the backend's ignored `.env`.

## Start the shared Node API

For a new checkout, copy the environment template without overwriting existing secrets:

```powershell
Set-Location ..\..\backend
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Confirm the local `AUTH_MODE`, `AUTH_ISSUER` and `AUTH_AUDIENCE` match the realm above. `KEYCLOAK_ADMIN_CLIENT_SECRET` is optional unless enabling invitations/profile updates. Never commit either `.env` file.

**Dependency/build gate:** before running the clean install, reconcile `package.json` and `package-lock.json`; `npm ci` currently fails. Typecheck/build also currently fail on document/policy TypeScript errors. Once these are fixed, the intended commands are:

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run dev
```

Node 22 can run the TypeScript server without watch mode for local diagnosis:

```powershell
node --env-file=.env --experimental-strip-types src/server.ts
```

## Health and smoke checks

The shared Node API exposes:

| Endpoint | Meaning | Expected response |
|---|---|---|
| `GET /health/live` | HTTP process is running | `200` |
| `GET /health/ready` | Configured JSON data directory can be listed and written | `200`; `503` with shared error envelope if storage is unavailable |
| `GET /api/v1/health` | Versioned API responds | `200`, version `v1` |

Readiness uses a uniquely named temporary probe file and removes it; it does not contact Keycloak or validate all collection files. A successful health response is not an end-to-end authentication check. Verify a real Keycloak access token with `GET /api/v1/me`, confirm its `iss` and `aud`, and check that the user has active server-side membership before treating auth as integrated.

Keycloak's Compose health check currently verifies that its local HTTP port accepts connections; it is not a realm-import, login, SMTP or user-management check. The FastAPI ticket app currently has no shared readiness endpoint.

## JSON data operations

`DATA_DIRECTORY` defaults to `./.local-data`, relative to the Node process working directory. The identity/organisation/team store uses schema-versioned JSON envelopes. Missing collection files read as empty collections; malformed JSON/schema and unreadable files return typed storage errors instead of silently resetting data. Writes use same-directory temporary files, atomic rename, a process queue and an exclusive lock file. `JSON_WRITE_LOCK_TIMEOUT_MS` defaults to 5000 ms.

Treat this store as a single-host development datastore. There are no transactions across files and no multi-host shared-storage guarantee. Before backup, stop the Node API or take a consistent filesystem snapshot of the whole `DATA_DIRECTORY`. Back up the Keycloak PostgreSQL volume separately when local realm/user data matters. Restore the complete JSON directory, then call `/health/ready` and exercise tenant-scoped reads before reopening the API.

If a write reports a stale lock timeout, inspect the named `*.json.lock` file and confirm no writer remains before removing it. Do not delete lock files while an API process may be writing. Preserve original files before manual repair of invalid JSON; never replace a malformed collection with an empty envelope without an approved recovery decision.

## Logging and secrets

The Node API logs JSON records with request ID, method, path, status and duration. Investigate incidents using request IDs; do not log bearer tokens, client secrets, passwords or uploaded content. Local `.env` files are ignored. Hosted secrets belong in the hosting platform's secret manager. The checked-in realm is a seed template, not a production realm export.

## Release blockers and handover actions

1. Agree whether the ticket module will be ported into Node/TypeScript or deployed as an approved separate Python service. Define one externally documented API topology.
2. Replace the ticket development principal in the integrated path with Keycloak authentication, membership-derived tenant context and shared permission checks.
3. Reconcile `JsonTenantStore` with the shared JSON adapter guarantees, or agree on a compatible repository adapter; resolve the TypeScript errors in document/policy modules.
4. Regenerate and commit the npm lockfile; scope `npm test` to source tests so generated `dist` tests are not rediscovered.
5. Merge Wandile's AI module and provide Faith's SLA/reporting implementation before claiming whole-system verification.
6. Resolve the API contract difference on organisation creation and confirm team/permission contract use across modules.
7. Add one assembled deployment definition only after the runtime and auth decisions are settled; then test clean install, build, health, Keycloak-protected API calls, cross-tenant denial and backup/restore.

The latest recorded integration review is [Integration-Verification.md](../api/Integration-Verification.md).

## Latest verification results

| Check | Result |
|---|---|
| Shared foundation tests using Node 22 native TypeScript support | 23 passed |
| Ticket Python tests | 15 passed, 1 upstream deprecation warning |
| Keycloak local Docker Compose configuration | Valid |
| `npm ci` | Blocked by package/lockfile mismatch |
| `npm run typecheck` / `npm run build` | Blocked by document/policy TypeScript errors |
| Unified API deployment and cross-module Keycloak requests | Not available until integration blockers above are resolved |
