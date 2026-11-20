# Deployment and operational handover

**Reviewed snapshot:** `FhuluBranch`, 20 November 2026. Working-tree changes are not yet committed.

## Deployment status

The backend is integrated into one Node.js/TypeScript server. `backend/src/main.ts`
starts the shared Keycloak-authenticated application, including tickets, policies,
documents, AI, SLA evaluation and reporting. The ticket API is not a separate
FastAPI service.

**Do not publish this snapshot as a production system.** The current ticket attachment
flow is a local-development prototype without malware scanning, the complete
machine-readable API contract is not yet available for every module, and live
Keycloak/hosting verification remains outstanding. The production persistence/storage
decision is intentionally deferred and is not part of this handover update.

## Local development topology

- Keycloak and PostgreSQL run through `deploy/keycloak/docker-compose.yml`.
- Keycloak is available at `http://localhost:8081` in the `ai-support` realm. Port 8080 is reserved by the local KnowledgeOps Keycloak on Thuto's machine.
- The integrated Node API listens on `127.0.0.1:3000` by default and reads `backend/.env`.
- The Node API writes runtime records under `backend/.local-data` by default when started from `backend`.
- Each developer has a separate Keycloak database, users and JSON data. Local account changes do not sync between teammates.
- The ticket API, policy/SLA APIs, reporting and foundation identity APIs use the same server and authentication middleware.

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

Run the backend checks and server from `backend/`:

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run dev
```

## Health and smoke checks

The shared Node API exposes:

| Endpoint | Meaning | Expected response |
|---|---|---|
| `GET /health/live` | HTTP process is running | `200` |
| `GET /health/ready` | Configured JSON data directory can be listed and written | `200`; `503` with shared error envelope if storage is unavailable |
| `GET /api/v1/health` | Versioned API responds | `200`, version `v1` |

Readiness uses a uniquely named temporary probe file and removes it; it does not
contact Keycloak or validate every collection. A successful health response is not an
end-to-end authentication check. Verify a real Keycloak access token with
`GET /api/v1/me`, confirm its `iss` and `aud`, and check that the user has active
server-side membership. Automated integration tests use a mocked JWKS endpoint; they
do not establish that a developer's real realm is configured correctly.

Keycloak's Compose health check verifies only that its local HTTP port accepts
connections; it is not a realm-import, login, SMTP or user-management check.

## JSON data operations

`DATA_DIRECTORY` defaults to `./.local-data`, relative to the Node process working directory. The identity/organisation/team store uses schema-versioned JSON envelopes. Missing collection files read as empty collections; malformed JSON/schema and unreadable files return typed storage errors instead of silently resetting data. Writes use same-directory temporary files, atomic rename, a process queue and an exclusive lock file. `JSON_WRITE_LOCK_TIMEOUT_MS` defaults to 5000 ms.

Production persistence/storage selection, migration, and operational backup/restore
approval are explicitly deferred. For local development only, treat this store as
single-host data. Before a local backup, stop the Node API or take a consistent
filesystem snapshot of the whole `DATA_DIRECTORY`. Back up the Keycloak PostgreSQL
volume separately when local realm/user data matters. Restore the complete JSON
directory, then call `/health/ready` and exercise tenant-scoped reads before reopening
the API.

If a write reports a stale lock timeout, inspect the named `*.json.lock` file and confirm no writer remains before removing it. Do not delete lock files while an API process may be writing. Preserve original files before manual repair of invalid JSON; never replace a malformed collection with an empty envelope without an approved recovery decision.

## Logging and secrets

The Node API logs JSON records with request ID, method, path, status and duration. Investigate incidents using request IDs; do not log bearer tokens, client secrets, passwords or uploaded content. Local `.env` files are ignored. Hosted secrets belong in the hosting platform's secret manager. The checked-in realm is a seed template, not a production realm export.

## Remaining work before a hosted deployment

1. **API contract:** The ticket and SLA-evidence paths now have a machine-readable
   contract in [ticket-openapi.json](../api/ticket-openapi.json). Extend and validate
   OpenAPI coverage for the remaining integrated identity, documents, policies, AI,
   SLA administration and reporting routes.
2. **Attachments:** Keep ticket uploads development-only. Malware scanning and the
   approved production attachment-storage path are intentionally deferred until the
   production file stack is selected. Current upload validation is not malware scanning.
3. **Live auth verification:** Run the end-to-end checks with each developer's local
   Keycloak realm: login/token audience, active tenant membership, role restrictions,
   user-management service account and SMTP invitations as applicable.
4. **Deployment operations:** After hosting/security decisions, assemble the deployment
   definition and verify TLS/CORS, secrets handling, monitoring/alerts, clean startup,
   rollback, and documented operational recovery.
5. **SLA activation:** Keep the reference candidate draft until client entitlement,
   contractual targets, calendars, holidays and effective dates are verified by the
   relevant owners.
6. **Deferred by decision:** Production persistence/storage selection and migration are
   out of scope for the current continuation.

The latest recorded integration review is [Integration-Verification.md](../api/Integration-Verification.md).

## Latest verification results

| Check | Result |
|---|---|
| `npm test` | Passed: 158 tests, 0 failures (20 November 2026 working-tree verification). |
| `npm run typecheck` | Passed (20 November 2026 working-tree verification). |
| `npm run build` | Passed (20 November 2026 working-tree verification). |
| `git diff --check` | Passed (20 November 2026 working-tree verification). |
| Ticket/workflow/SLA OpenAPI JSON | Passed: parses as OpenAPI 3.1 JSON; all 132 internal references and templated path parameters resolve across 14 paths. |
| Local Keycloak discovery and service-account token | Passed; the exact three direct user-management role mappings were verified. A human user's login and tenant authorization remain unverified. The effective `view-users` composite includes `query-groups`. |
| SMTP and hosted deployment | Not verified/configured here. Production attachment scanning is intentionally deferred. |
