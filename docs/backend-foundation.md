# Backend foundation integration guide

This guide documents the shared Thuto-owned contracts currently implemented in `backend/src`. The API uses `/api/v1`, Node's built-in HTTP server and TypeScript source. Runtime dependencies are intentionally empty.

For the current multi-module deployment status, local runbook, storage operations and handover gates, see `docs/operations/Deployment-and-Handover.md` and `docs/api/Integration-Verification.md`.

## Start and verify

Use Node.js 22 or newer.

```powershell
cd backend
npm ci
$env:DATA_DIRECTORY = ".\.local-data"
npm run dev
npm run typecheck
npm run build
npm test
```

There are no Node runtime dependencies. The current `package.json` and `package-lock.json` are out of sync, so `npm ci` fails until the lockfile is regenerated. The integrated TypeScript build also currently reports errors in document/policy modules; see `docs/operations/Deployment-and-Handover.md`. The development server can run with Node's built-in TypeScript stripping.

Copy `.env.example` to a local environment file as needed. For Keycloak, set `AUTH_MODE=keycloak`, `AUTH_ISSUER` to the realm issuer URL, and `AUTH_AUDIENCE` to the API client audience. Configure the Keycloak access token so its `aud` claim includes that API audience. The verifier uses the realm OIDC discovery document for JWKS unless `AUTH_JWKS_URI` is configured. The web client obtains tokens through the selected OIDC client flow and sends the access token as a bearer token; this API does not implement a password login endpoint. User invitations/profile updates additionally require `KEYCLOAK_ADMIN_CLIENT_ID` and `KEYCLOAK_ADMIN_CLIENT_SECRET` for a confidential service account with least-privilege realm user-management access. Do not commit runtime data or secrets. `GET /health/live` reports process liveness. `GET /health/ready` verifies that the configured JSON data directory is readable and writable, returning 503 on storage failure; it does not contact Keycloak or validate every collection. `GET /api/v1/health` reports API version only.

## Authentication and tenant context

`KeycloakAuthenticationProvider.authenticate(request)` verifies signed bearer access tokens against the configured realm signing keys. It validates signature algorithm, key ID, issuer, API audience, subject, token type, expiry and not-before. The provider caches JWKS briefly and refreshes the set if a token references an unknown key. For tests or another approved provider, supply an `AuthenticationProvider` through `createApp(environment, { authenticator })`. Never derive identity from arbitrary headers.

The identity service resolves `TenantContext` only when the user and `OrganisationMembership` are both active. Client-provided `organisationId` values select a requested tenant; they do not establish access. For tenant routes, pass the verified context through service/repository methods:

```ts
type TenantContext = {
  organisationId: string;
  userId: string;
  roles: string[];
};
```

All tenant-owned repository methods must take this context and filter by `tenant.organisationId`. A cross-tenant resource lookup should return not found or access denied without exposing the other tenant's data.

## Authorization

`RolePermissionPolicy` maps trusted membership roles to permission identifiers. The default application policy uses the role grants below; unmapped permission/role combinations are denied. Tests or deployments may inject another reviewed policy. Use `requirePermission(policy, tenant, permission)` before protected operations and at service boundaries where applicable.

### Canonical roles and granted capabilities

The role identifiers follow the supplied capstone responsibilities. “Administrator”, “Organisation Administrator”, and “System Administrator” are display labels for the single canonical `organisation_admin` role. Unknown role IDs receive no permissions.

| Canonical role | Granted capabilities |
|---|---|
| `organisation_admin` | Organisation read/update/create; manage users and memberships; manage teams; manage configuration; read all queues/tickets; review AI/resolution; manage priority/routing; approve actions; read audit and all reports. |
| `support_lead` | Read organisation/teams/team members; manage queues; read team tickets; review AI/resolution; manage priority/routing; approve actions; read ticket audit and team reports. |
| `support_agent` | Read organisation/teams; read assigned queues/tickets; review AI and resolution recommendations. |
| `requester` | Create own tickets and read own tickets/status. |

These grants derive from the role responsibilities in Capstone Project 05. The ticket/queue/configuration/report permissions are shared contracts for Fhulu and Faith; this foundation does not implement those modules.

Current permission identifiers used by routes:

| Permission | Operations |
|---|---|
| `organisation.update` | `PATCH /organisations/:organisationId` |
| `organisations.create` | `POST /organisations` |
| `users.manage` | `PATCH /users/:id`, `PUT /users/:id/memberships` |
| `teams.manage` | Department/team create/update and team membership assignment |

The application policy grants the permissions above only to the mapped canonical roles in the role table. Unknown roles or unmapped permissions are denied. Routes also require authentication and verified tenant scope.

## API endpoints

All listed endpoints require an authenticated identity. Tenant-scoped endpoints require active membership in the selected organisation. The standard success body is `{ "data": ..., "requestId": "..." }`; collection endpoints use `{ "data": [], "pagination": { "page": 1, "pageSize": 20, "total": 0 }, "requestId": "..." }`. Pagination defaults to page 1 and page size 20, with page size capped at 100.

| Method and path | Permission | Request / response | Main errors |
|---|---|---|---|
| `GET /api/v1/me` | Authenticated | Optional `organisationId` query. Returns safe user fields and active memberships/roles. | `401`, `403`, `503` |
| `GET /api/v1/organisations` | Authenticated | Lists active organisations for the current user. | `401`, `503` |
| `POST /api/v1/organisations` | `organisations.create` in selected tenant | `{ "name": "..." }`; returns created organisation. | `400`, `403`, `409` |
| `GET /api/v1/organisations/:organisationId` | `organisation.read` + active membership | Returns organisation. | `403`, `404` |
| `PATCH /api/v1/organisations/:organisationId` | `organisation.update` | Permitted fields: `name`, `settings`, `status` (`active`, `inactive`, `suspended`). An active organisation admin may restore an inactive/suspended organisation; other tenant APIs deny inactive tenants. | `400`, `403`, `404`, `409` |
| `GET /api/v1/users?organisationId=...` | `users.read` + active membership | Lists active users with active membership in tenant. | `400`, `403` |
| `POST /api/v1/users?organisationId=...` | `users.manage` | `{ "email": "...", "displayName": "...", "roles": ["support_agent"] }`; creates a Keycloak account, sends email verification/password actions, then records the local user and active organisation membership. | `400`, `403`, `409`, `503` |
| `GET /api/v1/users/:id?organisationId=...` | `users.read` + active membership | Returns a user only if active in selected tenant. | `403`, `404` |
| `PATCH /api/v1/users/:id?organisationId=...` | `users.manage` | `{ "displayName": "..." }`; account status is not changed through this global profile route. | `400`, `403`, `404` |
| `PUT /api/v1/users/:id/memberships?organisationId=...` | `users.manage` | `{ "status": "active\|inactive\|suspended", "roles": ["support_agent"] }`. | `400`, `403`, `404` |
| `GET/POST /api/v1/departments?organisationId=...` | Read: `teams.read`; create: `teams.manage` | POST body `{ "name": "..." }`. | `400`, `403`, `409` |
| `GET/POST /api/v1/teams?organisationId=...` | Read: `teams.read`; create: `teams.manage` | POST body `{ "name": "...", "departmentId": "..." }`; department may be null/omitted. | `400`, `403`, `409` |
| `PATCH /api/v1/teams/:id?organisationId=...` | `teams.manage` | Permitted fields: `name`, `departmentId`. | `400`, `403`, `404`, `409` |
| `GET /api/v1/teams/:id/members?organisationId=...` | `teams.members.read` + active membership | Lists active members of an owned team. | `403`, `404` |
| `PUT /api/v1/teams/:id/members?organisationId=...` | `teams.manage` | `{ "userId": "...", "role": "support_agent", "status": "active" }`. User must have active org membership. | `400`, `403`, `404` |

Every error uses `{ "error": { "code", "message", "requestId", "fields"? } }`. Unknown errors are logged with request ID and return a generic `500 INTERNAL_ERROR`; stack traces are not returned.

## JSON records and persistence

Runtime collection files live under `DATA_DIRECTORY` (default `./.local-data`, relative to the backend process working directory), separate from versioned synthetic seeds. Files use `{ "schemaVersion": 1, "records": [] }`. The shared store validates loaded envelopes, distinguishes missing files from malformed/unreadable files, writes through a same-directory temporary file and atomic rename, serializes updates in-process, and uses an exclusive lock file to prevent concurrent processes on a shared local filesystem from overwriting each other. `JSON_WRITE_LOCK_TIMEOUT_MS` controls how long a writer waits (default 5000 ms). A stale lock produces a typed storage error after the timeout; operators must inspect/remove it only after confirming no writer is active.

Current identity/organisation/team collections are `users.json`, `memberships.json`, `organisations.json`, `departments.json`, `teams.json`, and `team-memberships.json`. Stored IDs must be unique, timestamps are preserved on edits, and updates set `updatedAt`. Multi-file changes are not transactional. Keep the Node API on one host with persistent local storage; this adapter is not a shared multi-host datastore. Back up the whole data directory while the API is stopped or from a consistent filesystem snapshot. Inspect collection JSON before restoring service. Do not commit runtime data or secrets.

## Integration rules for module owners

- Import `TenantContext` from `shared/auth/authentication.ts` and require it in tenant-owned service/repository calls.
- Use `AppError` for expected failures and the common API envelope for responses.
- Use `RolePermissionPolicy` and explicit permission IDs; do not add module-local role checks.
- Keep route handlers limited to HTTP parsing and response mapping; put operations in application services.
- Background jobs and events must carry `organisationId`, actor/provenance where relevant, and a stable request/correlation ID. Define payloads as versioned shared DTOs before publishing them.
- Add cross-tenant negative tests to each module's repository/service tests.

## Operational caveats

The local Keycloak development stack is documented in `deploy/keycloak/README.md`. Its HTTP issuer at `http://localhost:8081/realms/ai-support` is for local development only. A hosted deployment requires a stable HTTPS issuer and platform secret management. Invitations require a least-privilege Keycloak service account and configured realm SMTP. Team membership stores one operational role per user/team; confirm whether multiple operational roles per team are needed before relying on it.
