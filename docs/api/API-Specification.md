# API Specification and examples

**Current generated contract:** [`integrated-openapi.json`](integrated-openapi.json),
rebuildable from `backend/` with `npm run openapi:build`. It describes the current
implemented HTTP surface; `/api/v1` serves the JSON contract and local Swagger UI at
`/api/v1/ai/docs`. The endpoint catalogue below includes current implemented behavior and
examples alongside clearly marked historical draft material. When a draft statement
conflicts with the generated contract or current implementation notes, use the generated
contract and the dated integration verification as the current references.

## Tenant-configured priority policy lifecycle

Tenant priority scoring is configured through the administrator-only version lifecycle:
`GET` and `POST /api/v1/configuration/priority-rules`, followed by
`POST /api/v1/configuration/priority-rules/{id}/approve` and
`POST /api/v1/configuration/priority-rules/{id}/activate`. Draft creation requires a complete
4x4 impact/urgency matrix including critical impact and immediate urgency, a processed same-organisation document/version, and a reason.
Approval and activation require separate reasons; activation rechecks the source checksum
and archives the prior active version. Only an active, source-verified tenant policy is used
for recommendations. The environment reference remains a development-only draft fallback.
The deployment must explicitly set `TICKET_PRIORITY_MIN_CONFIDENCE` between 0 and 1; no
default confidence cutoff is assumed. Recommendations remain human-review-only and do not
change a ticket.

### Priority recommendation endpoint

`POST /api/v1/tickets/:ticketId/recommend-priority`

- Auth: bearer access token, verified tenant membership selected by `X-Organisation-ID`.
- Permission: `tickets.ai.review`, plus existing ticket/team/ownership visibility. Requesters have no AI-review grant. Inaccessible/cross-tenant ticket IDs return 404.
- Body: `{}` only. Client-supplied impact, urgency, priority, policy, confidence settings, roles and other unknown fields return 400.
- Success: 200 `{ data: PriorityRecommendation, requestId }`; data includes active tenant policy provenance (or explicit development draft fallback), validated factor citations, execution metadata, warnings, missing information and mandatory human review. Priority is P1-P4 or null when information/confidence is insufficient.
- Errors: 401 unauthenticated; 403 permission/membership; 404 inaccessible ticket; 400 invalid body; 503 `PRIORITY_POLICY_NOT_ACTIVE` when no approved active policy exists; 502 `AI_ANALYSIS_FAILED` for provider timeout/failure/invalid evidence. Normal shared storage/identity errors also apply.
- Synchronous and recommendation-only: the response itself is not persisted by this endpoint and does not change tickets/assignment/closure. Full triage reports and human review decisions have their own persistence routes. Repeated requests may incur provider calls.
- Explicit development opt-in: `APP_ENV=development`, `TICKET_PRIORITY_PREVIEW_ENABLED=true`, `TICKET_PRIORITY_MIN_CONFIDENCE=<reviewed number 0..1>`, and either the existing demo or live runtime. No default confidence threshold is imposed.
- In production, the server resolves only the active tenant version and revalidates its processed source checksum. The request cannot select a policy/path; recommendations report `policyStatus: active`. When the explicit development fallback is enabled, the response reports `draft`.
- Live preview reuses the classification task provider/model with its existing timeout/fallback settings. Offline demo returns null factors/priority, `insufficient_information`, and a `DEMO_ONLY` warning.

### Immutable AI review and resolution edits

`POST /api/v1/tickets/{ticketId}/triages/{reportId}/reviews` accepts the required `decision`
(`accepted`, `rejected`, or `needs_information`) and reviewer `reason`. A reviewer may also
submit `editedResolution` with a summary, ordered steps, citations, missing information, and
warnings. The backend checks each citation against the same evidence passages in the report.
It stores an immutable `resolutionRevision.before` and `.after`, alongside reviewer identity,
timestamp, decision, and comment, and writes the before/after values to the audit ledger.
Invalid or fabricated citations are rejected. This records a recommendation review; it does
not change ticket priority, assignment, status, or send a customer message. Re-review changes
to the same report by the same reviewer are rejected as immutable.

Example response fields (abbreviated):

```json
{
  "data": {
    "policyStatus": "draft",
    "status": "insufficient_information",
    "priority": null,
    "requiresHumanReview": true,
    "missingInformation": ["Human-verified impact and urgency evidence"]
  },
  "requestId": "req_example"
}
```

## Integrated ticket priority update

Internal ticket priority uses the canonical values `P1` (Critical), `P2` (High),
`P3` (Medium), and `P4` (Low), with the impact/urgency matrix in ITSM-POL-001.
Existing internal `high`, `medium`, and `low` values normalize to `P2`, `P3`, and
`P4`; Legacy external source metadata remains read-only; ticket priority is set through the authenticated ticket workflow.

`PATCH /api/v1/tickets/:ticketId` accepts a priority update with
`priorityOverride.reason` and `priorityOverride.businessJustification`, both required
and non-empty whenever the internal priority changes. The caller needs ticket access
and `tickets.priority.manage`, currently granted to `support_lead` and
`organisation_admin`, not agents or requesters. The server records authenticated
`actorId`, timestamp, old/new priority, reason, and business justification in ticket
history; actor and timestamp are not client-controlled.

SLA resolution prefers an exact P1-P4 target. For compatibility only, P2/P3/P4 may
use legacy `high`/`medium`/`low` SLA target keys respectively; P1 requires an explicit
target. The adopted project contract does not activate a tenant policy: tenant approval
and effective dates are still required. This is a human operational update, not an AI
action.

> **Current integrated application (2026-11-19):** All default startup commands now serve foundation and domain routes together. Protected routes use verified foundation identity plus active server-side memberships, selected with `X-Organisation-ID` or `organisationId`. The static ticket development principal applies only to isolated legacy tests. AI history persists through the shared JSON store. See [Integration-Verification.md](Integration-Verification.md) and the root README; older standalone startup/auth examples below are historical.

## Historical draft conventions (superseded where inconsistent)

**Base path:** `/api/v1`  
**Status:** The original requirements draft is retained for traceability. Its proposed
authentication, role, idempotency, public-intake and response rules are not evidence of
implemented behavior. Consult the generated integrated contract and current implementation
notes above for supported routes and behavior.

## 1. API conventions

- JSON request and response bodies unless file upload is specified.
- Authenticate every endpoint except explicitly approved public intake routes.
- Derive tenant context from authenticated identity and verified membership.
- Validate request bodies, path parameters and query parameters.
- Use consistent pagination and error envelopes.
- Return `202 Accepted` for long-running asynchronous jobs and expose job status.
- Use idempotency keys for suitable retryable operations.
- Never expose internal stack traces, secrets or unrestricted cross-tenant data.

### Error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request is invalid.",
    "requestId": "req_example",
    "fields": [
      { "field": "title", "message": "Title is required." }
    ]
  }
}
```

## 2. Endpoint catalogue

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/login` | Authenticate, if local authentication is selected |
| POST | `/auth/refresh` | Refresh session/token, if supported |
| GET | `/me` | Current user and permitted organisation context |
| GET/POST | `/organisations` | List organisations; an active organisation administrator may create another organisation and becomes its administrator |
| GET/PATCH | `/organisations/:organisationId` | Read/update permitted organisation |
| GET/POST | `/users` | List/invite or create users |
| GET/PATCH | `/users/:id` | Read or update permitted user |
| PUT | `/users/:id/memberships` | Update a user's active-organisation roles and membership status |
| GET | `/roles` | List canonical roles and their effective permission capabilities |
| GET/POST | `/departments` | List/create departments |
| GET/POST | `/teams` | List/create teams |
| GET/PUT | `/teams/:teamId/members` | List or assign an active organisation member to a team |
| POST | `/documents` | Upload a tenant source document |
| GET | `/documents` | List tenant source documents and extraction results |
| GET | `/documents/:documentId` | Get tenant document, versions, and latest extraction |
| POST | `/documents/:documentId/process` | Process a UTF-8 text source for candidate SLA evidence |
| POST | `/documents/:documentId/download-token` | Create a short-lived source download token |
| GET | `/documents/download/:token` | Download a source using a tenant-scoped token |
| GET | `/extracted-rules` | List extracted candidates for administrator review |
| GET | `/extracted-rules/:id` | Read one extracted candidate |
| POST | `/extracted-rules/:id/approve` | Approve candidate rule |
| POST | `/extracted-rules/:id/reject` | Reject candidate rule |
| POST | `/extracted-rules/:id/request-changes` | Return a candidate for changes with a reason |
| GET/POST | `/policies` | List/create policies |
| GET | `/policies/:id/versions` | List policy versions |
| POST | `/policies/:id/activate` | Activate approved version |
| GET/POST | `/sla-policies` | List/create SLA policies |
| POST | `/sla-policies/:policyId/versions` | Add a tenant-configured SLA policy version |
| POST | `/sla-policies/:policyId/versions/:versionId/approve` | Approve a tenant-configured SLA version |
| POST | `/sla-policies/:policyId/versions/:versionId/activate` | Activate an approved SLA version |
| GET | `/sla/evaluations` | Query SLA evaluations |
| POST | `/sla/evaluations/run` | Evaluate current tenant tickets using active policies |
| GET/POST | `/ticket-workflows` | List tenant workflows / create a draft workflow configuration |
| GET | `/ticket-workflows/active` | Read the active tenant ticket workflow |
| POST | `/ticket-workflows/:workflowId/approve` | Approve and activate a draft ticket workflow |
| POST | `/tickets` | Create ticket |
| GET | `/tickets` | Search/filter/paginate tickets |
| GET | `/tickets/:id` | Ticket details |
| PATCH | `/tickets/:id` | Update permitted ticket fields |
| PATCH | `/tickets/:id/status` | Apply an approved tenant workflow transition |
| POST | `/tickets/:id/sla-events` | Record assessment or exclusion evidence |
| POST | `/tickets/:id/reopen-requests` | Request reopening of an eligible resolved ticket |
| POST | `/tickets/:id/reopen-requests/:requestId/approve` | Approve a pending reopen request |
| POST | `/tickets/:id/comments` | Add comment |
| GET | `/tickets/:id/comments` | Retrieve comments visible to the caller |
| POST | `/tickets/:id/analyze` | Run local synchronous AI demo (development only) |
| GET | `/tickets/:id/analyses` | Retrieve in-memory demo analysis history |
| GET | `/tickets/:id/similar` | Retrieve similar permitted tickets |
| POST | `/tickets/:id/recommend-resolution` | Generate resolution recommendation |
| POST | `/tickets/:id/recommend-routing` | Generate team recommendation |
| POST | `/tickets/:id/approve` | Approve proposed action |
| POST | `/tickets/:id/reject` | Reject proposed action |
| GET | `/tickets/:id/audit` | Ticket audit history |
| GET | `/reports` | Read authorised organisation-wide or active-team-scoped operational aggregates |
| GET | `/audit-logs` | Search permitted audit records |
| GET | `/jobs/:jobId` | Check asynchronous job status |

Ticket, document, SLA, reporting and workflow endpoints use the shared Keycloak access-token verifier. Send the selected tenant as `X-Organisation-ID`; this header selects the organisation to check and does not grant access. The API verifies the caller's active user record, organisation status and active membership, then loads roles and active team memberships from server-side records.

## 2.1 User roles and capabilities

`GET /api/v1/roles` requires an authenticated user with `users.manage` and an active `X-Organisation-ID` membership. It returns the four canonical role templates (`organisation_admin`, `support_lead`, `support_agent`, `requester`), their display names and the effective permission identifiers/descriptions from the shared backend policy. The administrator aliases â€œSystem Administratorâ€ and â€œOrganisation Administratorâ€ both refer to `organisation_admin`.

`POST /api/v1/users` requires `users.manage`. Its body accepts `email`, `displayName`, and a non-empty array of canonical role IDs. The API creates the identity through the configured Keycloak service account, then creates an active organisation membership with those roles. Passwords are never accepted or stored by this API. The response includes the membership and its effective permission IDs. `GET /api/v1/users` and `GET /api/v1/users/:id` include the target user's tenant membership roles and effective permissions. `PUT /api/v1/users/:id/memberships` updates that tenant membership and returns the resulting permission IDs.

Permission IDs in responses describe the shared policy for clients; they do not replace server-side authorization. Unknown roles receive no permissions, client-supplied permissions are rejected, and all access remains subject to active membership and resource/team scope.

Document routes use `documents.read` or `documents.manage`; SLA policy routes use `policies.read`, `policies.manage`, `policies.approve`, or `policies.activate`. These grants currently belong only to `organisation_admin`. The extracted-candidate list, detail, approve, reject and request-changes routes are mounted on the integrated API and are restricted to active organisation administrators.

## 3. Example ticket creation

### Request

```http
POST /api/v1/tickets
Authorization: Bearer <access-token>
X-Organisation-ID: org_123
Content-Type: application/json
```

```json
{
  "title": "Unable to access billing portal",
  "description": "The portal returns an access denied message.",
  "product": "Billing Portal",
  "affectedService": "Customer Billing",
  "affectedUsers": { "scope": "multiple_departments", "count": 150 },
  "businessImpact": "critical",
  "urgency": "immediate"
}
```

### Response â€” 201 Created

```json
{
  "data": {
    "id": "ticket_123",
    "organisationId": "org_123",
    "requesterId": "user_123",
    "title": "Unable to access billing portal",
    "description": "The portal returns an access denied message.",
    "product": "Billing Portal",
    "affectedService": "Customer Billing",
    "affectedUsers": { "scope": "multiple_departments", "count": 150 },
    "businessImpact": "critical",
    "urgency": "immediate",
    "status": "new",
    "createdAt": "2026-11-12T08:30:00.000Z",
    "updatedAt": "2026-11-12T08:30:00.000Z"
  },
  "requestId": "req_example"
}
```

`affectedUsers.scope` is one of `one_user`, `small_group`, `multiple_users_one_department`, `multiple_departments`, or `organisation_wide`; `count` is optional and, when supplied, must be a positive integer. `businessImpact` is one of `critical`, `high`, `medium`, or `low`; `urgency` is one of `immediate`, `high`, `medium`, or `low`. These requester-provided values remain explicit for human review. New tickets require these fields; older ticket records without them remain readable. Priority recommendations use the active tenant policy matrix and return insufficient information if its version does not define an input combination; the system does not silently downgrade immediate urgency. The server derives both organisation and requester from authenticated context; client-supplied tenant/requester identifiers are rejected.

## 5. Ticket API authentication and permissions

The unified backend uses the shared Keycloak bearer-token verifier and resolves the caller's active local user and organisation membership. Set `AUTH_MODE=keycloak`, `AUTH_ISSUER`, and `AUTH_AUDIENCE` in `backend/.env`; the checked-in local realm uses `support-api` as its audience. `npm run dev` and `npm start` load this file. No password login endpoint is provided by the API.

Every ticket, document, SLA, reporting, and workflow request must include `Authorization: Bearer <access-token>` and `X-Organisation-ID: <organisation-id>`. The organisation header only selects a tenant; backend membership records supply the roles and active team memberships. A user without active membership is denied.

Use `tickets.create.own` to create tickets. Ticket reads apply tenant, requester, and team scope. `tickets.audit.read` controls audit access; `tickets.approve` is required for reopen approvals. Reports require `reports.read.all` for organisation-wide aggregates or `reports.read.team` for aggregates limited to the caller's active teams. Ticket workflow administration requires `configuration.manage`. Team assignment requires `tickets.routing.manage`; organisation administrators may assign to any existing team in their tenant, while other callers must belong to the target team.

The shared permission catalogue does not yet define permissions for ticket status changes, reopen requests, general ticket edits, comments, or attachments. Those routes retain workflow/ownership checks and need team approval of their write capabilities before their RBAC contract is considered complete.

See `docs/architecture/Role-Capability-Matrix.md` for the complete role grants, enforced endpoint mappings, and capability gaps.

The development principal helper remains for isolated tests that instantiate `createTicketApp` directly. The application server disables it; do not enable it for requests handled by the shared backend.

### Create a ticket

```http
POST http://localhost:3000/api/v1/tickets
Authorization: Bearer {{accessToken}}
X-Organisation-ID: {{organisationId}}
Content-Type: application/json
```

```json
{
  "title": "Unable to sign in",
  "description": "The sign-in page returns an error.",
  "product": "Customer Portal",
  "affectedService": "Authentication",
  "affectedUsers": { "scope": "one_user" },
  "businessImpact": "medium",
  "urgency": "medium"
}
```

Expected response â€” `201 Created`:

```json
{
  "data": {
    "id": "ticket_<generated-id>",
    "organisationId": "org_support",
    "requesterId": "user_123",
    "title": "Unable to sign in",
    "description": "The sign-in page returns an error.",
    "product": "Customer Portal",
    "affectedService": "Authentication",
    "affectedUsers": { "scope": "one_user" },
    "businessImpact": "medium",
    "urgency": "medium",
    "status": "new",
    "createdAt": "<UTC timestamp>",
    "updatedAt": "<UTC timestamp>"
  },
  "requestId": "req_<generated-id>"
}
```

The API assigns tenant and requester from the configured principal. Without an active tenant workflow, the existing draft behavior starts tickets at `new`; after workflow approval, new tickets start at the configured initial status.

### Search and paginate

```http
GET http://localhost:3000/api/v1/tickets?q=sign%20in&status=new&limit=20&offset=0
Authorization: Bearer {{accessToken}}
X-Organisation-ID: {{organisationId}}
```

The response uses `data` for the page and `pagination` for `limit`, `offset`, and `total`. Supported filters are `q`, `status`, `priority`, `teamId`, and `requesterId`; the server applies tenant and role scope before filters. Requesters see only their own tickets; support agents see tickets assigned to their configured teams; support leads see unassigned tickets and tickets assigned to their configured teams.

### Update a ticket

```http
PATCH http://localhost:3000/api/v1/tickets/{{ticketId}}
Authorization: Bearer {{accessToken}}
X-Organisation-ID: {{organisationId}}
Content-Type: application/json
```

```json
{
  "title": "Sign-in error after password reset",
  "teamId": "team_support",
  "priority": "P2",
  "priorityOverride": {
    "reason": "Incident manager reviewed the impact.",
    "businessJustification": "The service is unavailable to multiple users."
  }
}
```

Support agents/leads may update title, description, product, or affected service for tickets in their scope. Only support leads may set `teamId`, and it must be in their configured team scope. Priority changes require `tickets.priority.manage` and the override evidence above. Status changes use the tenant's approved ticket workflow.

### Configure and approve a tenant ticket workflow

The workflow values are sourced from the tenant's workflow document. During this Phase 3 implementation, an organisation administrator submits the document-derived configuration as structured JSON; automatic parsing of uploaded policy documents is not included. The submitted configuration remains a draft until an organisation administrator approves it. A draft does not affect ticket creation or status updates.

The document role names map to the API's development roles as follows: Customer -> `requester`, Agent -> `support_agent`, Supervisor -> `support_lead`, Administrator -> `organisation_admin`. `organisation_admin` is available only through the development principal in this implementation.

```http
POST http://localhost:3000/api/v1/ticket-workflows
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "config": {
    "sourceReference": "Tenant Ticket Workflow Policy v1",
    "initialStatus": "NEW",
    "reopenStatus": "REOPENED",
    "statuses": [
      "NEW",
      "OPEN",
      "IN_PROGRESS",
      "PENDING",
      "RESOLVED",
      "CLOSED",
      "REOPENED"
    ],
    "transitions": {
      "NEW": ["OPEN"],
      "OPEN": ["IN_PROGRESS", "PENDING", "RESOLVED"],
      "IN_PROGRESS": ["PENDING", "RESOLVED", "OPEN"],
      "PENDING": ["IN_PROGRESS", "OPEN"],
      "RESOLVED": ["CLOSED", "REOPENED"],
      "CLOSED": ["REOPENED"],
      "REOPENED": ["OPEN", "IN_PROGRESS"]
    },
    "requestableReopenFrom": ["RESOLVED"],
    "restrictedReopenFrom": ["CLOSED"],
    "permissions": {
      "directStatusChangeRoles": ["support_agent", "support_lead"],
      "closedReopenRoles": ["support_lead", "organisation_admin"],
      "reopenRequestRoles": ["requester"],
      "reopenApprovalRoles": ["support_lead", "organisation_admin"],
      "administratorOverrideRoles": ["organisation_admin"]
    }
  }
}
```

Expected response â€” `201 Created` (the draft is not active):

```json
{
  "data": {
    "id": "workflow_<generated-id>",
    "organisationId": "org_support",
    "sourceReference": "Tenant Ticket Workflow Policy v1",
    "initialStatus": "NEW",
    "reopenStatus": "REOPENED",
    "statuses": ["NEW", "OPEN", "IN_PROGRESS", "PENDING", "RESOLVED", "CLOSED", "REOPENED"],
    "transitions": {
      "NEW": ["OPEN"],
      "OPEN": ["IN_PROGRESS", "PENDING", "RESOLVED"],
      "IN_PROGRESS": ["PENDING", "RESOLVED", "OPEN"],
      "PENDING": ["IN_PROGRESS", "OPEN"],
      "RESOLVED": ["CLOSED", "REOPENED"],
      "CLOSED": ["REOPENED"],
      "REOPENED": ["OPEN", "IN_PROGRESS"]
    },
    "requestableReopenFrom": ["RESOLVED"],
    "restrictedReopenFrom": ["CLOSED"],
    "permissions": {
      "directStatusChangeRoles": ["support_agent", "support_lead"],
      "closedReopenRoles": ["support_lead", "organisation_admin"],
      "reopenRequestRoles": ["requester"],
      "reopenApprovalRoles": ["support_lead", "organisation_admin"],
      "administratorOverrideRoles": ["organisation_admin"]
    },
    "status": "draft",
    "createdBy": "user_admin",
    "createdAt": "<UTC timestamp>",
    "updatedAt": "<UTC timestamp>"
  },
  "requestId": "req_<generated-id>"
}
```

Approve the draft using the organisation-admin principal:

```http
POST http://localhost:3000/api/v1/ticket-workflows/{{workflowId}}/approve
Authorization: Bearer {{adminToken}}
```

Expected response â€” `200 OK`, with `"status": "active"`, `approvedBy`, and `approvedAt`. Reapproval of a non-draft workflow returns `409 WORKFLOW_CONFLICT`. Only one workflow is active per tenant; activating a replacement archives the previous version. `GET /api/v1/ticket-workflows/active` returns the active tenant workflow to authenticated tenant users.

Tickets created after activation start at the configured initial status. Existing `new` tickets can use the active workflow if their current value matches a configured status case-insensitively. Status is changed separately from the general ticket `PATCH` route.

### Change status and handle reopen requests

Use the configured status code exactly. For example, an assigned support agent can move `NEW` to `OPEN`:

```http
PATCH http://localhost:3000/api/v1/tickets/{{ticketId}}/status
Authorization: Bearer {{agentToken}}
Content-Type: application/json
```

```json
{
  "status": "OPEN"
}
```

Expected response â€” `200 OK`:

```json
{
  "data": {
    "id": "ticket_<generated-id>",
    "organisationId": "org_support",
    "requesterId": "user_requester",
    "title": "Unable to access the billing portal",
    "description": "The portal returns an access denied message.",
    "status": "OPEN",
    "createdAt": "<UTC timestamp>",
    "updatedAt": "<UTC timestamp>"
  },
  "requestId": "req_<generated-id>"
}
```

An unlisted transition returns `409 INVALID_STATUS_TRANSITION`; a role restriction returns `403 FORBIDDEN`. A requester cannot directly change status. Customers may request reopening from `RESOLVED`, with a reason:

When an active SLA policy configures the destination as paused, the status request must
include evidence and a contract reference, and only a support lead or organisation
administrator may enter or leave that pause:

```json
{
  "status": "PENDING",
  "pauseEvidence": {
    "reasonCode": "waiting_for_requester_information",
    "evidence": "Requested the missing diagnostic logs.",
    "contractReference": "CONTRACT-123"
  }
}
```

Entering a configured resolved status likewise requires support staff to provide a
`resolutionEvidence` object with `outcome` (`service_restored` or `agreed_solution`),
`note`, `customerConfirmation` (`received` or `not_applicable`) and
`customerConfirmationEvidence`. Customer confirmation is recorded but is not a gate.
The resolution event is written atomically with the status transition.

The server starts both clocks at ticket `createdAt`. A first-response timestamp is
recorded only after acknowledgement, completed assessment and first team assignment;
it is the latest of those three event timestamps. A public comment alone is not enough.
Resolution time excludes evidenced resolved intervals; reopening resumes the same clock
without resetting it. Status names alone never pause an SLA.

Support staff can record one-time assessment evidence:

```http
POST /api/v1/tickets/{{ticketId}}/sla-events
Authorization: Bearer {{agentToken}}
Content-Type: application/json

{
  "type": "assessment_completed",
  "evidence": "Impact and affected service assessed."
}
```

Only support leads and organisation administrators can start/end SLA exclusions. Starts
require an allowed `reasonCode` (`approved_maintenance_window`, `outside_agreed_scope`,
`force_majeure`, `requester_requested_postponement` or `approved_waiting_period`), evidence,
and contract reference. The start response contains the generated `intervalId`; submit it
to end that interval. Exclusions subtract only their recorded interval and the ticket
remains in reports. Both pause and exclusion timestamps and actors come from the server.

```http
POST http://localhost:3000/api/v1/tickets/{{ticketId}}/reopen-requests
Authorization: Bearer {{requesterToken}}
Content-Type: application/json
```

```json
{
  "reason": "The issue is still occurring."
}
```

Expected response â€” `201 Created`, with a pending request and generated `id`. The ticket remains `RESOLVED` until a supervisor or administrator approves it:

```http
POST http://localhost:3000/api/v1/tickets/{{ticketId}}/reopen-requests/{{requestId}}/approve
Authorization: Bearer {{supervisorToken}}
```

Approval returns `200 OK`, updates the ticket to `REOPENED`, and atomically records the decision and reason in ticket history. Reopening from `CLOSED` is restricted to supervisors and administrators and always requires a reason. Administrators may override role restrictions, but never perform a transition absent from the approved transition map.

This workflow API accepts structured configuration; it does not extract workflow rules from uploaded files. The separate document API can store tenant documents and process UTF-8 TXT, Markdown, PDF, and DOCX files for candidate evidence. That document flow is not required for SLA configuration and does not create or activate SLA policies.

#### Upload and process a tenant document

Document upload, processing, inspection, and download-token routes require an organisation administrator and are scoped to that administrator's tenant. The upload is multipart form data with a `title` field and one `file` field. This feature is independent of the tenant-specific SLA configuration API below.

```http
POST /api/v1/documents
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

After upload, process supported source formats with:

```http
POST /api/v1/documents/{documentId}/process
Authorization: Bearer <token>
Content-Type: application/json

{}
```

The response contains the document's completed processing status and a version-bound extraction record. A missing or ambiguous target remains marked for human review; extracted values are not automatically used as SLA configuration. Unsupported document formats return `422` and are not marked processed. `GET /api/v1/documents/{documentId}` returns the document metadata, tenant-scoped versions, and latest extraction. To retrieve the source file, first call `POST /api/v1/documents/{documentId}/download-token`, then use its short-lived path with `GET /api/v1/documents/download/{token}`.

### Configure tenant-specific SLA policies

Only an organisation administrator may manage SLA policies, evaluations, or reports. An administrator submits that tenant's targets, calendar(s), statuses, and optional team scope through the API; no policy document upload is required. A policy may provide one shared `calendar` for all priorities or `calendarByPriority` with exactly one calendar for every key in `targetsByPriority`. Each priority-specific calendar controls both its response and resolution clock. Existing policies with a shared calendar remain valid. When an SLA is derived from a processed document, the request may also include both `sourceDocumentId` and `sourceDocumentVersionId`. The server verifies that the document and version belong to the authenticated tenant and retains that provenance on the policy version; the fields must be provided together. The server derives tenant ownership from the authenticated principal, validates the configuration, and does not apply default targets. New policy versions are pending approval and are not used in calculations until explicitly activated.

The reference SLA candidate remains draft: this event contract does not verify client
entitlement, contractual targets, or calendars, and is not approval to activate those
candidate values.

The following values are illustrative test data only, not defaults or recommendations. Replace them with values chosen by the tenant administrator. Missing priority targets do not fall back to another tenant or an invented value.

```http
POST /api/v1/sla-policies
Authorization: Bearer <organisation-admin-token>
Content-Type: application/json
```

```json
{
  "description": "Tenant-configured support SLA",
  "effectiveFrom": "2026-01-01T00:00:00.000Z",
  "effectiveTo": null,
  "payload": {
    "calendar": {
      "timeZone": "Africa/Johannesburg",
      "weeklySchedule": {
        "monday": [{ "startMinute": 540, "endMinute": 1020 }],
        "tuesday": [{ "startMinute": 540, "endMinute": 1020 }],
        "wednesday": [{ "startMinute": 540, "endMinute": 1020 }],
        "thursday": [{ "startMinute": 540, "endMinute": 1020 }],
        "friday": [{ "startMinute": 540, "endMinute": 1020 }]
      },
      "holidays": ["2026-12-25"]
    },
    "targetsByPriority": {
      "high": {
        "firstResponseMinutes": 60,
        "resolutionMinutes": 240
      },
      "normal": {
        "firstResponseMinutes": 240,
        "resolutionMinutes": 1440
      }
    },
    "pausedStatuses": ["PENDING"],
    "resolvedStatuses": ["RESOLVED", "CLOSED"],
    "riskAtPercent": 75,
    "teamIds": ["team_support"]
  }
}
```

`startMinute` and `endMinute` are minutes after midnight in the configured IANA timezone. `teamIds` is optional: when omitted, the policy applies organisation-wide; when present, it applies only to those teams and takes precedence over a matching organisation-wide policy. A policy version is activated only after an administrator approves it and the API records that approval. Activating a later version archives the prior active version for that policy.

Policy changes create a new pending version without changing historical ticket evaluations:

```http
POST /api/v1/sla-policies/{policyId}/versions
Authorization: Bearer <organisation-admin-token>
Content-Type: application/json
```

The request contains `effectiveFrom`, optional `effectiveTo`, and a full `payload` in the same schema as above. `sourceDocumentId` and `sourceDocumentVersionId` may also be supplied together to retain source provenance for the new version. Versions must be activated in increasing effective-date order. The prior version remains available for tickets whose creation time falls within its effective period.

```http
POST /api/v1/sla-policies/{policyId}/versions/{versionId}/approve
Authorization: Bearer <organisation-admin-token>
Content-Type: application/json

{"reason": "Reviewed the tenant-configured SLA targets."}
```

```http
POST /api/v1/sla-policies/{policyId}/versions/{versionId}/activate
Authorization: Bearer <organisation-admin-token>
Content-Type: application/json

{}
```

`GET /api/v1/sla-policies` lists the authenticated tenant's SLA policies and versions. `GET /api/v1/sla/evaluations` returns that tenant's persisted evaluation inputs and results; it accepts an optional `ticketId`. `POST /api/v1/sla/evaluations/run` reevaluates that tenant's tickets against active, effective policy versions. `GET /api/v1/reports?from=<ISO timestamp>&to=<ISO timestamp>` returns a tenant-scoped ticket-volume, current-status, priority, and SLA-state summary for the requested period. Evaluations retain their input and policy version so results can be explained later.

### Add and read comments

```http
POST http://localhost:3000/api/v1/tickets/{{ticketId}}/comments
Authorization: Bearer {{accessToken}}
X-Organisation-ID: {{organisationId}}
Content-Type: application/json
```

```json
{
  "body": "We are investigating the sign-in issue.",
  "visibility": "public"
}
```

`visibility` must be `public` or `internal`. Requesters may add public comments only to their own tickets. Support staff may add either visibility to tickets in their scope. `GET /api/v1/tickets/{{ticketId}}/comments` returns public comments to requesters and both kinds to support staff. `GET /api/v1/tickets/{{ticketId}}/audit` requires the shared `tickets.audit.read` permission, currently granted to organisation administrators and support leads.

Comments, attachment metadata and history are currently stored in each ticket JSON record so a ticket change and its audit event are written atomically. Attachment bytes use the shared private-storage adapter under tenant-specific directories; storage keys are never returned by the API.

### Upload and download ticket attachments

These routes require a valid Keycloak access token, active organisation membership, and access to the ticket. They accept PDF, TXT, DOC, DOCX, PNG, JPEG (`.jpg`/`.jpeg`) and WebP files up to 25 MB. Image uploads must have a matching extension, MIME type and file signature. PDF files must begin with the PDF signature. This prototype does **not** scan uploads for malware and is not approved for production or sensitive files.

```http
POST http://localhost:3000/api/v1/tickets/{{ticketId}}/attachments
Authorization: Bearer {{accessToken}}
X-Organisation-ID: {{organisationId}}
Content-Type: multipart/form-data
```

In Postman, choose **Body â†’ form-data**, add a key named `file`, change its type to **File**, and select the attachment. Postman supplies the multipart boundary.

Expected response â€” `201 Created`:

```json
{
  "data": {
    "id": "attachment_<generated-id>",
    "fileName": "screenshot.png",
    "mimeType": "image/png",
    "checksumSha256": "<sha256>",
    "fileSizeBytes": 1234,
    "uploadedBy": "user_123",
    "createdAt": "<UTC timestamp>"
  },
  "requestId": "req_<generated-id>"
}
```

The private storage key is intentionally omitted. To download, send an authenticated `GET http://localhost:3000/api/v1/tickets/{{ticketId}}/attachments/{{attachmentId}}`. The caller must still have access to the ticket; the response is the file bytes with `Content-Disposition: attachment`. Requesters can access their own ticket attachments, and support staff can access attachments only for tickets in their configured team scope (support leads may also access unassigned tickets).

## 6. Local ticket AI demo

The current Express ticket API implements synchronous classification and
summarization in either opt-in local demo mode or opt-in live-provider mode.
Both require `APP_ENV=development` and configured `TICKET_AI_CATEGORIES`. The
local deterministic heuristic is not an LLM; its results require human review
and are stored in memory only until the API process restarts. Live mode uses
the configured per-task provider, retries transient Inception failures, and
falls back to Groq. Both modes are read-only and use in-memory analysis history;
there is no asynchronous job or durable persistence.

### Request

```http
POST /api/v1/tickets/ticket_123/analyze
Authorization: Bearer <development-bearer-token>
Content-Type: application/json
```

```json
{}
```

### Response â€” 200 OK

```json
{
  "data": {
    "id": "analysis_<uuid>",
    "ticketId": "ticket_123",
    "organisationId": "org_123",
    "status": "completed",
    "classification": {
      "category": "ACCOUNT_ACCESS",
      "reason": "The local demo heuristic matched these configured terms: account, access.",
      "confidence": null,
      "requiresHumanReview": true,
      "warnings": ["DEMO_ONLY: deterministic keyword heuristic; not an LLM or calibrated classification."]
    },
    "summary": {
      "summary": "The requester cannot access the account.",
      "symptoms": ["Unable to access my account"],
      "attemptedActions": [],
      "businessImpact": null,
      "missingInformation": [],
      "warnings": ["DEMO_ONLY: extractive summary; not an LLM-generated or completeness-checked summary."]
    },
    "executions": [
      {
        "executionId": "exec_<uuid>",
        "task": "ticket_classification",
        "status": "completed",
        "provider": "local-demo-heuristic",
        "model": "local-heuristic-v1",
        "attempts": 1,
        "durationMs": 1,
        "startedAt": "<timestamp>",
        "completedAt": "<timestamp>"
      },
      {
        "executionId": "exec_<uuid>",
        "task": "ticket_summarization",
        "status": "completed",
        "provider": "local-demo-heuristic",
        "model": "local-heuristic-v1",
        "attempts": 1,
        "durationMs": 1,
        "startedAt": "<timestamp>",
        "completedAt": "<timestamp>"
      }
    ],
    "createdAt": "<timestamp>"
  }
}
```

`GET /api/v1/tickets/ticket_123/analyses` returns the analyses still held in
memory for the caller's accessible ticket. Both routes enforce the ticket
module's tenant and requester/team/administrator access checks. The demo
provider receives only the ticket ID, title, description, and configured
categories; it does not call an external service.

Similar-ticket retrieval, priority/routing/resolution recommendations, async
jobs, and persistent AI history remain future integrations. The values above
show the response shape; timestamps and execution values are generated at
runtime.

## 7. Example policy approval

### Request

```http
POST /api/v1/extracted-rules/rule_123/approve
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "decisionReason": "Verified against the source policy and approved for the stated effective period.",
  "effectiveFrom": "2026-12-01T00:00:00.000Z"
}
```

The service must verify reviewer permission, source document/version, conflicts, effective-date validity and approval state. It must create an immutable decision record.


### Request

```http
POST /api/v1/performance/assessments/calculate
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "subjectUserId": "user_123",
  "assessmentPeriodId": "period_2026_q4",
  "frameworkVersionId": "framework_v3"
}
```

### Response â€” 202 Accepted

```json
{
  "data": {
    "jobId": "job_assessment_123",
    "status": "queued"
  }
}
```

The calculation must use approved formula and weighting versions and verified measurements. AI must not arbitrarily determine the numeric score.

## 8. Validation and authorisation rules

- Reject unknown or malformed fields according to the API's validation policy.
- Verify organisation membership and resource ownership on every request.
- Enforce role/permission checks at endpoint and service level.
- Prevent users from approving their own changes if organisational policy prohibits it.
- Restrict employee performance details to authorised subjects, leaders and administrators.
- Validate upload type, size and content; scan files where supported.
- Rate-limit authentication, public intake and expensive AI operations.
- Validate status transitions and use concurrency/version checks for approvals and activation.

## 9. OpenAPI draft excerpt

The ticket and ticket/SLA-evidence paths have a machine-readable OpenAPI contract at
[ticket-openapi.json](./ticket-openapi.json). It covers ticket CRUD/search, workflow
configuration and status changes, comments, audit, attachments, reopen requests, SLA
evidence. It is a ticket-domain contract, not yet a complete OpenAPI
description of identity, documents, policies, AI, SLA administration or reporting.

```yaml
openapi: 3.0.3
info:
  title: Universal Support Management API
  version: 1.0.0-draft
servers:
  - url: /api/v1
paths:
  /ticket-workflows:
    get:
      summary: List tenant ticket workflow versions
      security:
        - bearerAuth: []
      responses:
        "200":
          description: Workflows belonging to the authenticated tenant (organisation administrator only)
    post:
      summary: Create a draft ticket workflow configuration
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [config]
              properties:
                config:
                  type: object
                  required:
                    - sourceReference
                    - initialStatus
                    - reopenStatus
                    - statuses
                    - transitions
                    - requestableReopenFrom
                    - restrictedReopenFrom
                    - permissions
                  properties:
                    sourceReference:
                      type: string
                    initialStatus:
                      type: string
                    reopenStatus:
                      type: string
                    statuses:
                      type: array
                      items:
                        type: string
                    transitions:
                      type: object
                      additionalProperties:
                        type: array
                        items:
                          type: string
                    requestableReopenFrom:
                      type: array
                      items:
                        type: string
                    restrictedReopenFrom:
                      type: array
                      items:
                        type: string
                    permissions:
                      type: object
      responses:
        "201":
          description: Draft created; it does not affect tickets until approved
        "400":
          description: Invalid workflow configuration
        "403":
          description: Organisation administrator only
  /ticket-workflows/active:
    get:
      summary: Retrieve the active ticket workflow for the authenticated tenant
      security:
        - bearerAuth: []
      responses:
        "200":
          description: Active workflow configuration
        "404":
          description: No active workflow
  /ticket-workflows/{workflowId}/approve:
    post:
      summary: Approve and activate a draft ticket workflow
      security:
        - bearerAuth: []
      parameters:
        - in: path
          name: workflowId
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Workflow activated; a prior active version is archived
        "403":
          description: Organisation administrator only
        "404":
          description: Workflow not found
        "409":
          description: Workflow is not a draft
  /tickets:
    post:
      summary: Create a support ticket
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title, description]
              properties:
                title:
                  type: string
                  minLength: 1
                description:
                  type: string
                  minLength: 1
                product:
                  type: string
                affectedService:
                  type: string
      responses:
        "201":
          description: Ticket created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/TicketResponse"
        "400":
          description: Validation error
        "401":
          description: Unauthenticated
        "403":
          description: Forbidden
    get:
      summary: Search, filter and paginate accessible tickets
      security:
        - bearerAuth: []
      parameters:
        - in: query
          name: q
          schema:
            type: string
        - in: query
          name: status
          schema:
            type: string
        - in: query
          name: priority
          schema:
            type: string
        - in: query
          name: teamId
          schema:
            type: string
        - in: query
          name: requesterId
          schema:
            type: string
        - in: query
          name: limit
          schema:
            type: integer
            minimum: 1
            maximum: 100
            default: 20
        - in: query
          name: offset
          schema:
            type: integer
            minimum: 0
            default: 0
      responses:
        "200":
          description: A tenant- and role-scoped page of tickets
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/TicketListResponse"
        "401":
          description: Unauthenticated
  /tickets/{ticketId}:
    parameters:
      - in: path
        name: ticketId
        required: true
        schema:
          type: string
    get:
      summary: Retrieve an accessible ticket
      security:
        - bearerAuth: []
      responses:
        "200":
          description: Ticket details, permitted comments and attachment metadata
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/TicketResponse"
        "401":
          description: Unauthenticated
        "404":
          description: Ticket not found or not accessible
    patch:
      summary: Update permitted ticket fields
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              minProperties: 1
              additionalProperties: false
              properties:
                title:
                  type: string
                  minLength: 1
                description:
                  type: string
                  minLength: 1
                  nullable: true
                product:
                  type: string
                  nullable: true
                affectedService:
                  type: string
                  nullable: true
                teamId:
                  type: string
                  nullable: true
                priority:
                  type: string
                  enum: [P1, P2, P3, P4, high, medium, low]
                  description: Required with priorityOverride when changing priority. Legacy high/medium/low inputs normalize to P2/P3/P4.
                priorityOverride:
                  type: object
                  additionalProperties: false
                  required: [reason, businessJustification]
                  properties:
                    reason:
                      type: string
                      minLength: 1
                    businessJustification:
                      type: string
                      minLength: 1
                  description: Required for a priority change; actor and time are captured by the server.
      responses:
        "200":
          description: Ticket updated
        "400":
          description: Validation error
        "401":
          description: Unauthenticated
        "403":
          description: Forbidden or requested team outside scope
        "404":
          description: Ticket not found or not accessible
  /tickets/{ticketId}/status:
    patch:
      summary: Apply an approved tenant workflow transition
      security:
        - bearerAuth: []
      parameters:
        - in: path
          name: ticketId
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [status]
              additionalProperties: false
              properties:
                status:
                  type: string
                reason:
                  type: string
      responses:
        "200":
          description: Ticket updated and status change recorded in audit history
        "400":
          description: Validation error
        "403":
          description: Role is not permitted to change status
        "404":
          description: Ticket not found or not accessible
        "409":
          description: Workflow is inactive or transition is not permitted
  /tickets/{ticketId}/reopen-requests:
    post:
      summary: Request reopening of an eligible ticket
      security:
        - bearerAuth: []
      parameters:
        - in: path
          name: ticketId
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [reason]
              additionalProperties: false
              properties:
                reason:
                  type: string
      responses:
        "201":
          description: Reopen request created in pending state
        "403":
          description: Requester role required
        "404":
          description: Ticket not found or not accessible
        "409":
          description: Ticket status does not allow reopening
  /tickets/{ticketId}/reopen-requests/{requestId}/approve:
    post:
      summary: Approve a pending ticket reopen request
      security:
        - bearerAuth: []
      parameters:
        - in: path
          name: ticketId
          required: true
          schema:
            type: string
        - in: path
          name: requestId
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Reopen request approved and ticket status changed
        "403":
          description: Supervisor or administrator role required
        "404":
          description: Ticket or request not found
        "409":
          description: Reopen is not valid for the current ticket status
  /tickets/{ticketId}/comments:
    parameters:
      - in: path
        name: ticketId
        required: true
        schema:
          type: string
    post:
      summary: Add a ticket comment
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [body, visibility]
              additionalProperties: false
              properties:
                body:
                  type: string
                  minLength: 1
                visibility:
                  type: string
                  enum: [internal, public]
      responses:
        "201":
          description: Comment added
        "400":
          description: Validation error
        "401":
          description: Unauthenticated
        "403":
          description: Forbidden
        "404":
          description: Ticket not found or not accessible
    get:
      summary: List comments visible to the caller
      security:
        - bearerAuth: []
      responses:
        "200":
          description: Visible ticket comments
        "401":
          description: Unauthenticated
        "404":
          description: Ticket not found or not accessible
  /tickets/{ticketId}/audit:
    get:
      summary: Retrieve ticket audit history
      security:
        - bearerAuth: []
      parameters:
        - in: path
          name: ticketId
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Ticket audit events
        "401":
          description: Unauthenticated
        "403":
          description: Support staff only
        "404":
          description: Ticket not found or not accessible
  /tickets/{ticketId}/attachments:
    post:
      summary: Upload a private ticket attachment
      security:
        - bearerAuth: []
      parameters:
        - in: path
          name: ticketId
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [file]
              properties:
                file:
                  type: string
                  format: binary
      responses:
        "201":
          description: Attachment uploaded
        "400":
          description: Unsupported type or invalid file content
        "401":
          description: Unauthenticated
        "404":
          description: Ticket not found or not accessible
        "413":
          description: File exceeds 25 MB
  /tickets/{ticketId}/attachments/{attachmentId}:
    get:
      summary: Download a private ticket attachment
      security:
        - bearerAuth: []
      parameters:
        - in: path
          name: ticketId
          required: true
          schema:
            type: string
        - in: path
          name: attachmentId
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Attachment file bytes
          content:
            application/octet-stream:
              schema:
                type: string
                format: binary
        "401":
          description: Unauthenticated
        "404":
          description: Ticket or attachment not found or not accessible
  /tickets/{ticketId}/analyze:
    post:
      summary: Start ticket triage workflow
      security:
        - bearerAuth: []
      parameters:
        - in: path
          name: ticketId
          required: true
          schema:
            type: string
      responses:
        "202":
          description: Analysis queued
        "401":
          description: Unauthenticated
        "403":
          description: Forbidden
        "404":
          description: Ticket not found
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: >-
        Production JWT authentication remains subject to identity-provider approval.
        The local development ticket principal uses an opaque bearer token and is not
        suitable for deployment.
  schemas:
    Ticket:
      type: object
      required: [id, organisationId, requesterId, title, createdAt, updatedAt]
      properties:
        id:
          type: string
        organisationId:
          type: string
        requesterId:
          type: string
        teamId:
          type: string
          nullable: true
        title:
          type: string
        description:
          description: A manually entered string or structured JSON description.
        product:
          type: string
          nullable: true
        affectedService:
          type: string
          nullable: true
        status:
          type: string
        priority:
          type: string
        source:
          type: object
          additionalProperties: true
        createdAt:
          type: string
          format: date-time
        updatedAt:
          type: string
          format: date-time
        comments:
          type: array
          items:
            $ref: "#/components/schemas/TicketComment"
        attachments:
          type: array
          items:
            $ref: "#/components/schemas/TicketAttachmentMetadata"
    TicketComment:
      type: object
      required: [id, authorId, body, visibility, createdAt]
      properties:
        id:
          type: string
        authorId:
          type: string
        body:
          type: string
        visibility:
          type: string
          enum: [internal, public]
        createdAt:
          type: string
          format: date-time
    TicketAttachmentMetadata:
      type: object
      required: [id, fileName, mimeType, checksumSha256, fileSizeBytes, uploadedBy, createdAt]
      properties:
        id:
          type: string
        fileName:
          type: string
        mimeType:
          type: string
        checksumSha256:
          type: string
        fileSizeBytes:
          type: integer
        uploadedBy:
          type: string
        createdAt:
          type: string
          format: date-time
    TicketResponse:
      type: object
      required: [data, requestId]
      properties:
        data:
          $ref: "#/components/schemas/Ticket"
        requestId:
          type: string
    TicketListResponse:
      type: object
      required: [data, pagination, requestId]
      properties:
        data:
          type: array
          items:
            $ref: "#/components/schemas/Ticket"
        pagination:
          type: object
          required: [limit, offset, total]
          properties:
            limit:
              type: integer
            offset:
              type: integer
            total:
              type: integer
        requestId:
          type: string
```

This excerpt is intentionally a draft; expand every endpoint, schema, response, permission and error case before implementation.
# Evidence and resolution increment

Authenticated ticket reviewers can call `GET /api/v1/tickets/:ticketId/evidence`,
`GET /api/v1/tickets/:ticketId/similar` and
`POST /api/v1/tickets/:ticketId/recommend-resolution` with `{}` to reuse a valid saved
recommendation or generate one when necessary. Explicit regeneration uses
`{"regenerate":true,"reason":"..."}`; the reason is optional and each version remains in
the tenant-scoped `ai-operations` ledger. Concurrent generation returns HTTP 409
`AI_EXECUTION_IN_PROGRESS`. Recommendations are invalidated by ticket projection changes,
authorized evidence changes, prompt version changes, or provider/model identity changes.
Resolution guidance requires human review and never changes tickets. The default evidence
source exposes effective, approved, active policy payloads only to organisation administrators;
historical sources are not connected yet. See
[the resolution contract](../../backend/src/modules/ai/resolution-recommendations.md)
for response fields, unavailable/evidence-empty behavior and integration requirements.
