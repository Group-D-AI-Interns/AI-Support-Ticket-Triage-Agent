# API Specification — Draft

**Base path:** `/api/v1`  
**Status:** Draft contract for review. Authentication provider, exact database and final role/permission codes remain subject to approval.

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
| GET/POST | `/organisations` | List/create organisations (platform admin only) |
| GET/PATCH | `/organisations/:organisationId` | Read/update permitted organisation |
| GET/POST | `/users` | List/invite or create users |
| PATCH | `/users/:id` | Update permitted user |
| GET/POST | `/departments` | List/create departments |
| GET/POST | `/teams` | List/create teams |
| POST | `/documents` | Upload document |
| GET | `/documents` | List permitted documents |
| GET | `/documents/:id` | Get document metadata/status |
| POST | `/documents/:id/process` | Queue extraction |
| GET | `/documents/:id/extractions` | View extracted candidate rules |
| POST | `/extracted-rules/:id/approve` | Approve candidate rule |
| POST | `/extracted-rules/:id/reject` | Reject candidate rule |
| GET/POST | `/policies` | List/create policies |
| GET | `/policies/:id/versions` | List policy versions |
| POST | `/policies/:id/activate` | Activate approved version |
| GET/POST | `/sla-policies` | List/create SLA policies |
| POST | `/sla-policies/:id/activate` | Activate approved SLA version |
| GET | `/sla/evaluations` | Query SLA evaluations |
| POST | `/tickets` | Create ticket |
| POST | `/tickets/ingest/jira/{webhookSecret}` | Ingest Jira Cloud issue-created/issue-updated webhooks |
| GET | `/tickets` | Search/filter/paginate tickets |
| GET | `/tickets/:id` | Ticket details |
| PATCH | `/tickets/:id` | Update permitted ticket fields |
| POST | `/tickets/:id/comments` | Add comment |
| GET | `/tickets/:id/comments` | Retrieve comments visible to the caller |
| POST | `/tickets/:id/analyze` | Start AI triage |
| GET | `/tickets/:id/analyses` | Retrieve analysis history |
| GET | `/tickets/:id/similar` | Retrieve similar permitted tickets |
| POST | `/tickets/:id/recommend-resolution` | Generate resolution recommendation |
| POST | `/tickets/:id/recommend-routing` | Generate team recommendation |
| POST | `/tickets/:id/approve` | Approve proposed action |
| POST | `/tickets/:id/reject` | Reject proposed action |
| GET | `/tickets/:id/audit` | Ticket audit history |
| GET | `/reports` | Available authorised reports |
| GET | `/audit-logs` | Search permitted audit records |
| GET | `/jobs/:jobId` | Check asynchronous job status |

## 3. Example ticket creation

### Request

```http
POST /api/v1/tickets
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "title": "Unable to access billing portal",
  "description": "The portal returns an access denied message.",
  "product": "Billing Portal",
  "affectedService": "Customer Billing"
}
```

### Response — 201 Created

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
    "status": "new",
    "createdAt": "2026-11-12T08:30:00.000Z",
    "updatedAt": "2026-11-12T08:30:00.000Z"
  },
  "requestId": "req_example"
}
```

The server derives both organisation and requester from the authenticated context; client-supplied tenant/requester identifiers are rejected.

## 4. Jira Cloud webhook ingestion

The Jira Cloud webhook endpoint is `POST /api/v1/tickets/ingest/jira/{webhookSecret}`. For this initial implementation, configure a Jira issue-created and issue-updated webhook and use a high-entropy per-organisation secret in the HTTPS URL path. Jira's standard admin webhook does not send a configurable custom header. Redact the secret path from gateway and application access logs and rotate it if exposed.

The endpoint resolves the organisation using the configured Jira project-key mapping, then verifies the URL secret and resolves the reporter using the configured Jira `accountId` mapping. It ignores any organisation ID supplied in the webhook body. Until admin configuration APIs are available, configure these mappings through `JIRA_TENANT_CONFIG`. The mapped requester ID is trusted configuration.

```json
{
  "projectMappings": {
    "SUP": "org_support"
  },
  "organisations": {
    "org_support": {
      "webhookSecret": "replace-with-a-random-secret-at-least-32-characters",
      "reporterMappings": {
        "jira-account-abc": "user_123"
      }
    }
  }
}
```

For a local Postman run from PowerShell, set the configuration and start the TypeScript ticket API from the repository root. Install backend npm dependencies first if needed:

```powershell
npm --prefix backend ci
$env:JIRA_TENANT_CONFIG = '{"projectMappings":{"SUP":"org_support"},"organisations":{"org_support":{"webhookSecret":"replace-with-a-random-secret-at-least-32-characters","reporterMappings":{"jira-account-abc":"user_123"}}}}'
$env:DATA_DIRECTORY = ".local-data"
npm --prefix backend run dev:tickets
```

Replace the example secret and reporter account mapping with values from the Jira tenant. Keep the secret out of source control and redact it from all request-path logs.

### Postman request

```http
POST http://localhost:8000/api/v1/tickets/ingest/jira/<webhookSecret>
Content-Type: application/json
```

```json
{
  "webhookEvent": "jira:issue_created",
  "issue": {
    "id": "10042",
    "key": "SUP-42",
    "fields": {
      "project": {
        "key": "SUP"
      },
      "summary": "Unable to access billing portal",
      "description": {
        "type": "doc",
        "content": [
          {
            "type": "paragraph",
            "content": [
              {
                "type": "text",
                "text": "The portal returns an access denied message."
              }
            ]
          }
        ]
      },
      "reporter": {
        "accountId": "jira-account-abc"
      },
      "status": {
        "name": "Open"
      },
      "priority": {
        "name": "High"
      }
    }
  }
}
```

### Expected response — 201 Created

```json
{
  "data": {
    "id": "ticket_<generated-id>",
    "sourceIssueKey": "SUP-42",
    "outcome": "created",
    "createdAt": "2026-11-17T08:30:00.000Z",
    "updatedAt": "2026-11-17T08:30:00.000Z"
  },
  "requestId": "req_<generated-id>"
}
```

Jira status and priority are retained verbatim in source metadata; they are not converted to internal workflow values. The reporter must have a configured mapping. Repeated delivery of an already stored issue is idempotent (`200 OK`, outcome `duplicate`); a later issue-updated event updates that same ticket (`200 OK`, outcome `updated`). Unsupported Jira event types, unknown projects, invalid secrets, or unmapped reporters are rejected. Jira Cloud requires a publicly reachable HTTPS URL with a valid certificate; the HTTP URL above is for local Postman testing only.

## 5. Ticket API: local development authentication

The approved identity and tenant middleware is not yet in this repository. Ticket create/read/update, comments, and audit endpoints are therefore enabled only with a **development-only configured principal**. Never configure this adapter outside local development; startup fails if `TICKET_DEV_PRINCIPAL` is set while `APP_ENV` is not `development`. The Jira webhook continues to use its per-organisation URL secret.

Keep the existing `JIRA_TENANT_CONFIG` set in the API process. In the same PowerShell window that will start the TypeScript ticket API, generate a separate development bearer token and configure the local principal:

```powershell
$devToken = python -c "import secrets; print(secrets.token_urlsafe(32))"
$devConfig = @{
  bearerToken = $devToken
  organisationId = "org_support"
  userId = "user_123"
  roles = @("requester", "support_lead")
  teamIds = @("team_support")
} | ConvertTo-Json -Depth 5 -Compress

$env:APP_ENV = "development"
$env:TICKET_DEV_PRINCIPAL = $devConfig
Write-Host $devToken
```

Use the printed value as the Postman `devToken` variable, then start/restart the API from this same PowerShell process. The organisation and user IDs must match the configured Jira mapping when accessing imported tickets. `teamIds` are trusted development fixtures, not a substitute for the Phase 1/2 team-membership service. Do not send sensitive data through a publicly exposed development tunnel.

### Create a ticket

```http
POST http://localhost:8000/api/v1/tickets
Authorization: Bearer {{devToken}}
Content-Type: application/json
```

```json
{
  "title": "Unable to sign in",
  "description": "The sign-in page returns an error.",
  "product": "Customer Portal",
  "affectedService": "Authentication"
}
```

Expected response — `201 Created`:

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
    "status": "new",
    "createdAt": "<UTC timestamp>",
    "updatedAt": "<UTC timestamp>"
  },
  "requestId": "req_<generated-id>"
}
```

The API assigns tenant and requester from the configured principal and sets initial status to `new` (as in the API draft).

### Search and paginate

```http
GET http://localhost:8000/api/v1/tickets?q=sign%20in&status=new&limit=20&offset=0
Authorization: Bearer {{devToken}}
```

The response uses `data` for the page and `pagination` for `limit`, `offset`, and `total`. Supported filters are `q`, `status`, `priority`, `teamId`, and `requesterId`; the server applies tenant and role scope before filters. Requesters see only their own tickets; support agents see tickets assigned to their configured teams; support leads see unassigned tickets and tickets assigned to their configured teams.

### Update a ticket

```http
PATCH http://localhost:8000/api/v1/tickets/{{ticketId}}
Authorization: Bearer {{devToken}}
Content-Type: application/json
```

```json
{
  "title": "Sign-in error after password reset",
  "teamId": "team_support"
}
```

Support agents/leads may update title, description, product, or affected service for tickets in their scope. Only support leads may set `teamId`, and it must be in their configured development `teamIds`. Status and priority changes are not accepted: approved internal values/transitions are not defined. Jira status/priority remain source metadata.

### Add and read comments

```http
POST http://localhost:8000/api/v1/tickets/{{ticketId}}/comments
Authorization: Bearer {{devToken}}
Content-Type: application/json
```

```json
{
  "body": "We are investigating the sign-in issue.",
  "visibility": "public"
}
```

`visibility` must be `public` or `internal`. Requesters may add public comments only to their own tickets. Support staff may add either visibility to tickets in their scope. `GET /api/v1/tickets/{{ticketId}}/comments` returns public comments to requesters and both kinds to support staff. `GET /api/v1/tickets/{{ticketId}}/audit` is support-staff-only.

Comments and history are currently stored in each ticket JSON record so a ticket update and its audit event are written atomically. Ticket attachment upload/download is deferred until the shared private file-storage contract is available; no attachment endpoint is exposed yet.

## 6. Example asynchronous triage

### Request

```http
POST /api/v1/tickets/ticket_123/analyze
Authorization: Bearer <access-token>
```

### Response — 202 Accepted

```json
{
  "data": {
    "executionId": "exec_123",
    "status": "queued",
    "statusUrl": "/api/v1/jobs/exec_123"
  }
}
```

### Example completed result

```json
{
  "data": {
    "executionId": "exec_123",
    "status": "completed",
    "classification": {
      "categories": ["account_access"],
      "confidence": 0.91
    },
    "summary": {
      "issue": "Requester cannot access the billing portal.",
      "impact": "Billing work may be delayed.",
      "missingInformation": ["Browser and time of failure"]
    },
    "priorityRecommendation": {
      "value": "medium",
      "factors": ["Configured impact and urgency rules"],
      "requiresHumanReview": true
    },
    "routingRecommendation": {
      "teamId": "team_billing_support",
      "requiresApproval": true
    },
    "evidence": []
  }
}
```

The values above are illustrative contract examples, not real model outputs or configured business rules.

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

### Response — 202 Accepted

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

```yaml
openapi: 3.0.3
info:
  title: Universal Support Management API
  version: 1.0.0-draft
servers:
  - url: /api/v1
paths:
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
        "400":
          description: Validation error
        "401":
          description: Unauthenticated
        "403":
          description: Forbidden
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
```

This excerpt is intentionally a draft; expand every endpoint, schema, response, permission and error case before implementation.
