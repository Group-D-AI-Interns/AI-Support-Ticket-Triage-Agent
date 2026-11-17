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
| POST | `/tickets/ingest` | Ingest from authorised external system |
| GET | `/tickets` | Search/filter/paginate tickets |
| GET | `/tickets/:id` | Ticket details |
| PATCH | `/tickets/:id` | Update permitted ticket fields |
| POST | `/tickets/:id/comments` | Add comment |
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
  "requesterId": "user_123",
  "product": "Billing Portal",
  "affectedService": "Customer Billing"
}
```

### Response — 201 Created

```json
{
  "data": {
    "id": "ticket_123",
    "status": "new",
    "createdAt": "2026-11-12T08:30:00.000Z"
  },
  "requestId": "req_example"
}
```

The server derives organisation scope from the authenticated context and validates that the requester is permitted.

## 4. Example asynchronous triage

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

## 5. Example policy approval

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

## 7. Validation and authorisation rules

- Reject unknown or malformed fields according to the API's validation policy.
- Verify organisation membership and resource ownership on every request.
- Enforce role/permission checks at endpoint and service level.
- Prevent users from approving their own changes if organisational policy prohibits it.
- Restrict employee performance details to authorised subjects, leaders and administrators.
- Validate upload type, size and content; scan files where supported.
- Rate-limit authentication, public intake and expensive AI operations.
- Validate status transitions and use concurrency/version checks for approvals and activation.

## 8. OpenAPI draft excerpt

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
                requesterId:
                  type: string
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
```

This excerpt is intentionally a draft; expand every endpoint, schema, response, permission and error case before implementation.
