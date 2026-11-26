# AI Support Ticket Triage Agent

The TypeScript backend runs foundation identity, organisations and teams together
with tickets, documents, SLA policies/evaluation, operational reporting and ticket
AI analysis on one HTTP server. LangGraph orchestrates ticket classification,
summarisation and the full AI triage workflow.

## Run the backend

For an offline demonstration without Docker, Keycloak or provider credentials:

```powershell
cd backend
npm run demo
```

This starts the integrated API on `127.0.0.1:3000`, creates synthetic records in a
new ignored `.local-data/demo-*` directory and exercises ticket analysis,
document processing, explicit administrator SLA approval, evaluation and reporting.
It uses test-signed tokens with local signing-key responses and deterministic AI;
it does not log into real Keycloak or contact external providers. Normal startup
retains its real authentication requirements. Stop the demo with Ctrl+C.

In another PowerShell terminal, from `backend/`, inspect the results:

```powershell
./scripts/explore-demo.ps1
```

The ignored `.local-data/demo-session.json` supplies the local demo token (valid
for eight hours), API address, organisation and ticket ID. Do not share that file.
Set `DEMO_PORT` before launch if port 3000 is busy. The signed-in frontend lives in
`frontend/`; see its README for pages and Keycloak configuration.

Use Node.js 20+ and install the locked dependencies from `backend/`:

```powershell
cd backend
npm ci
npm run typecheck
npm run build
npm test
```

For normal application startup, MongoDB is required in development as well as
production. Copy `backend/.env.example` to `backend/.env` if it does not exist, then set
`MONGODB_URI` to the Atlas SRV connection string and keep `MONGODB_DATABASE=ai_support`
(or the database name selected for this deployment). The `dev` and `start` npm scripts
load `backend/.env`; direct calls to `loadEnvironment()` do not. Never commit or print the
populated file. The backend fails at startup when the MongoDB configuration is missing or
Atlas cannot be initialized; it does not switch to JSON. For Keycloak configuration and
realm setup, see [deploy/keycloak/README.md](deploy/keycloak/README.md).

The offline `npm run demo` command is an isolated synthetic demonstration and uses a
temporary JSON fixture store. It does not select or emulate the normal application's
persistence. Unit and integration tests also use isolated JSON fixtures; non-test server
startup rejects JSON persistence.

Set `AUTH_MODE=keycloak`, `AUTH_ISSUER` and `AUTH_AUDIENCE`, and optionally
`AUTH_JWKS_URI`. Configure `DATA_DIRECTORY` to your writable local data directory.
The identity subject must match an active stored user with an active organisation
membership; Keycloak token roles do not replace these records. Initial organisation,
user and administrator membership bootstrapping is still a deployment setup task;
empty seed files do not create an administrator automatically.

```powershell
npm run dev
# or run without watch mode
npm start
```

Both commands start `src/main.ts` -> `src/server.ts` -> the same integrated app.
Default address: `http://127.0.0.1:3000`. `/health/live` and `/health/ready` are public.
`AUTH_MODE=disabled` leaves protected routes unavailable; it does not grant access.
The old `TICKET_DEV_PRINCIPAL` is not accepted by the integrated server.

Send `Authorization: Bearer <access-token>` and `X-Organisation-ID: <organisation-id>`
for tenant APIs. `/api/v1/me` can discover the caller's memberships without a selected
organisation. Ticket intake is available through the authenticated
`POST /api/v1/tickets` endpoint; no external webhook intake is currently mounted.

## Ticket AI

Analysis endpoints are `POST /api/v1/tickets/:ticketId/analyze` with `{}` and
`GET /api/v1/tickets/:ticketId/analyses`. Select local demo or live provider mode
explicitly and configure server-owned categories. See the
[AI module guide](backend/src/modules/ai/README.md). Analyses persist in the data
directory; AI analysis does not modify the ticket.

## Integration status

See [integration verification](docs/api/Integration-Verification.md) for tested flows,
identity/storage boundaries and remaining limitations. Signed-token integration tests
use a mocked JWKS endpoint, and provider tests use mocked HTTP; they do not establish
that external Keycloak or LLM services are deployed and reachable.

The application database is MongoDB Atlas. The approved migration imported 80 validated
records from 18 local collections into the configured empty database; the source JSON files
remain unchanged. Production traffic cutover, backup/restore and deployment controls are not
yet verified. See the
[production readiness tracker](docs/deployment/production-readiness.md) before deployment.

## Business reference documents

Priority, SLA and performance source templates are organised under
[backend/data/reference](backend/data/reference/README.md). They have inactive,
source-linked draft transcriptions and an isolated tested priority matrix preview.
They are not automatically loaded as approved tenant policies. See the reference
README for review owners and decisions needed before SLA/performance implementation.

Draft priority preview is available at `POST /api/v1/tickets/:ticketId/recommend-priority`
with `{}` for authorised support reviewers. The offline demo enables it automatically
and honestly returns missing information. Normal startup requires explicit preview
configuration; see [the priority guide](backend/src/modules/ai/priority-recommendations.md).

The generated [integrated OpenAPI contract](docs/api/integrated-openapi.json) currently
contains 78 paths and 95 operations. Rebuild it from `backend/` with
`npm run openapi:build`; the running backend serves it at `/api/v1/openapi.json` and the
local Swagger UI at `/api/v1/ai/docs`. The separately maintained
[API specification](docs/api/API-Specification.md) includes endpoint behavior and examples;
the generated contract and integration log identify route coverage and verification limits.

## Architecture, tests and deployment

Current architecture and data-flow documents are in [docs/architecture](docs/architecture/),
including the [security architecture](docs/architecture/Security-Architecture.md). Source,
agent prompts/configuration, MongoDB models/indexes, and backend/frontend tests are maintained
in `backend/` and `frontend/`. The backend uses Node's built-in test runner; the frontend
currently has API integration checks, not Playwright browser E2E coverage. The local
Keycloak compose file is under `deploy/keycloak/`; backend and frontend Dockerfiles are
provided, but there is no selected application deployment topology or root compose stack.
Setup instructions are in [Deployment-and-Handover.md](docs/operations/Deployment-and-Handover.md)
and the frontend README. Public environment templates are `backend/.env.example`,
`frontend/.env.example`, and `deploy/keycloak/.env.example`; never copy secret values into
the templates. See [production readiness](docs/deployment/production-readiness.md) for
unverified deployment requirements and
[Integration-Verification.md](docs/api/Integration-Verification.md) for synthetic and
historical HTTP verification evidence. No new services were started for this documentation
review, so no new live response capture is claimed.
