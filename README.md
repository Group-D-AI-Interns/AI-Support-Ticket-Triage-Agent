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
Set `DEMO_PORT` before launch if port 3000 is busy. This repository currently has
an API backend, with no frontend application.

Use Node.js 20+ and install the locked dependencies from `backend/`:

```powershell
cd backend
npm ci
npm run typecheck
npm run build
npm test
```

Configure environment variables in your shell or IDE using `backend/.env.example`
as the variable reference. Startup does not automatically load `.env`. Never commit
populated environment files. For Keycloak configuration and realm setup, see
[deploy/keycloak/README.md](deploy/keycloak/README.md).

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
organisation. Jira ingestion is optional; configure `JIRA_TENANT_CONFIG` to enable
its independently authenticated webhook route.

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

The ticket, workflow, and ticket/SLA-evidence routes have a machine-readable
[OpenAPI contract](docs/api/ticket-openapi.json). It does not yet cover every integrated
identity, document, policy, AI, SLA administration, or reporting endpoint.
