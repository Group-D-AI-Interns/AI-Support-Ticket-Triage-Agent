# Deployment and operational handover

**Reviewed snapshot:** 24 November 2026. This repository is a changing working tree; verify the current revision and environment before using this handover.

## Deployment status

The backend is integrated into one Node.js/TypeScript server. `backend/src/main.ts`
starts the shared Keycloak-authenticated application, including tickets, policies,
documents, AI, SLA evaluation and reporting. The ticket API is not a separate
FastAPI service.

**Not ready for production traffic.** MongoDB Atlas is the selected production database;
the application adapter and migration tooling exist, but deployment cutover, production
access controls and backup/restore remain to be verified. The generated integrated
OpenAPI contract covers implemented routes but is not exhaustively proven against every
runtime route. File bytes remain on local private storage without configured malware
scanning or production object storage. Keycloak/user checks in the integration log are
local evidence only. The authoritative current blocker list is
[`production-readiness.md`](../deployment/production-readiness.md).

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

Confirm the local `AUTH_MODE`, `AUTH_ISSUER` and `AUTH_AUDIENCE` match the realm above. Set `DATABASE_PROVIDER=mongodb`, provide the Atlas SRV URI in `MONGODB_URI`, and keep the intended database in `MONGODB_DATABASE`. The URI belongs only in the ignored `backend/.env` or a deployment secret store, never in `.env.example` or logs. `KEYCLOAK_ADMIN_CLIENT_SECRET` is optional unless enabling invitations/profile updates. Never commit either `.env` file.

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
| `GET /health/ready` | Configured MongoDB adapter can connect and answer a ping | `200`; `503` with shared error envelope if storage is unavailable |
| `GET /api/v1/health` | Versioned API responds | `200`, version `v1` |

Readiness runs a MongoDB ping; it does not contact Keycloak or validate every collection. A successful health response is not an
end-to-end authentication check. Verify a real Keycloak access token with
`GET /api/v1/me`, confirm its `iss` and `aud`, and check that the user has active
server-side membership. Automated integration tests use a mocked JWKS endpoint; they
do not establish that a developer's real realm is configured correctly.

Keycloak's Compose health check verifies only that its local HTTP port accepts
connections; it is not a realm-import, login, SMTP or user-management check.

## MongoDB data operations

Normal API startup requires MongoDB in development and production. The server connects
once, creates the application indexes and reports startup failure if MongoDB cannot be
initialized. It never silently uses the JSON fixture adapter. The configured database
stores application records in the `app_` collection namespace. `DATA_DIRECTORY` is still
used for private document and attachment bytes; those files are separate from database
records and do not move with the JSON-to-Mongo collection migration.

JSON collection import is explicitly opt-in. First run the migration command without
`--apply` to validate and inventory source records. Applying migration requires an empty
MongoDB target and a protected source; the utility imports allowlisted records in a
transaction and verifies per-collection counts. Do not point `--apply` at the main Atlas
database until the source, target and backup are reviewed. Backup/restore operation still
needs deployment verification. Unit tests and the offline synthetic demo may use isolated
JSON fixture files, but they are not application runtime storage.

## Logging and secrets

The Node API logs JSON records with request ID, method, path, status and duration. Investigate incidents using request IDs; do not log bearer tokens, client secrets, passwords or uploaded content. Local `.env` files are ignored. Hosted secrets belong in the hosting platform's secret manager. The checked-in realm is a seed template, not a production realm export.

## Remaining work before a hosted deployment

1. **API contract:** The integrated generated contract is in
   [integrated-openapi.json](../api/integrated-openapi.json). Exhaustive route/schema
   conformance and browser-level acceptance remain unverified.
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
6. **MongoDB operations:** Atlas is the selected application database and is mandatory
   for normal startup. Complete environment-specific connectivity, migration/cutover,
   backup and restore verification before production use.

The latest recorded integration review is [Integration-Verification.md](../api/Integration-Verification.md).

## Earlier verification snapshot (20 November 2026)

| Check | Result |
|---|---|
| `npm test` | Passed: 158 tests, 0 failures (20 November 2026 working-tree verification). |
| `npm run typecheck` | Passed (20 November 2026 working-tree verification). |
| `npm run build` | Passed (20 November 2026 working-tree verification). |
| `git diff --check` | Passed (20 November 2026 working-tree verification). |
| Ticket/workflow/SLA OpenAPI JSON | Passed: parses as OpenAPI 3.1 JSON; all 132 internal references and templated path parameters resolve across 14 paths. |
| Local Keycloak discovery and service-account token | Passed; the exact three direct user-management role mappings were verified. A human user's login and tenant authorization remain unverified. The effective `view-users` composite includes `query-groups`. |
| SMTP and hosted deployment | Not verified/configured here. Production attachment scanning is intentionally deferred. |

## MongoDB runtime switch verification (24 November 2026)

Normal startup now selects MongoDB in development and production; JSON persistence is
accepted only in tests and the isolated offline demo. Environment configuration checks,
backend source type-check, full source/test TypeScript check, and production build passed.
An in-process configuration smoke check confirmed MongoDB selection and that missing
configuration or explicit JSON in development fails closed. The focused Node test runner
could not start because the sandbox returned `spawn EPERM`. The current Atlas URI passed a
read-only ping, and Mongo file-store initialization/index setup plus readiness passed. The
approved import then loaded 80 records across 18 collections transactionally; per-collection
counts matched and source JSON remains unchanged. Document/attachment bytes were not moved,
and no API server/workers were started. See [the current integration verification](../api/Integration-Verification.md)
for the latest status.
