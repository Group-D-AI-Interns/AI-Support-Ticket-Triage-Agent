# BACKEND_IMPLEMENTATION.md
# Backend Implementation Guide
## Universal AI-Powered Support Management & Performance Platform

**Document purpose:** Official implementation roadmap and working contract for the five backend developers and their AI coding agents.  
**Status:** Derived from the supplied project documentation; proposed architecture and API contracts remain subject to repository inspection and approval where marked.  
**Team:** Thuto, Olerato, Fhulu, Faith, Wandile  
**API base path:** `/api/v1`  
**Document owner:** Backend development team

---

## 1. Project Overview

### 1.1 Purpose

The platform is a configurable, multi-tenant support operations and performance management system. It supports:

- Organisation, user, role, department and team administration.
- Secure document storage and document analysis.
- Policy extraction, versioning, approval and activation.
- Configurable SLA policies, working calendars, deadline evaluation and escalation.
- Support ticket intake, assignment, comments, attachments and lifecycle management.
- AI-assisted ticket classification, summarisation, priority recommendation, similarity retrieval, resolution guidance and team routing.
- Knowledge retrieval from approved, permission-accessible sources.
- Performance measurements, assessments, coaching and reporting.
- Approval workflows, audit history and operational observability.

AI is an assistant to the operational workflow, not an unrestricted decision-maker. It proposes and explains. Authorised people approve governed policy changes and consequential actions. Performance scores are calculated by deterministic, versioned business rules using verified data.

### 1.2 Users and roles

The supplied designs identify these role templates:

| Role | Intended access |
|---|---|
| System Administrator | Platform-level tenant and system administration. This does not imply unrestricted access to tenant business data. |
| Organisation Administrator | Permitted organisation configuration, users, teams, documents, policies and operational information. |
| Support Leader / Team Leader | Assigned team operations, team reports, coaching and own leadership performance. |
| Support Agent | Assigned tickets, applicable knowledge and own performance. |
| Requester / Customer | Own permitted ticket submission and status access. |

The Security and Permissions document explicitly lists System Administrator, Support Leader, Support Agent and Requester. Organisation Administrator and Team Leader are also used in the architecture/UI materials. The final role catalogue and permission codes must be confirmed and mapped to actual organisational custom roles before implementation.

### 1.3 Architectural principles

1. Enforce tenant isolation on every tenant-owned data and processing path.
2. Treat organisation-specific policies, SLAs and workflows as configuration, not hardcoded rules.
3. Keep AI tasks bounded, typed, validated and traceable.
4. Use deterministic, versioned rules for performance scoring.
5. Preserve existing repository functionality and conventions unless an approved change is justified.
6. Begin with a modular monolith. Extract services only when scale or operational constraints justify it.
7. Record material decisions, approvals, overrides and AI executions.
8. Keep provider SDKs and infrastructure details outside domain modules.
9. Do not activate AI-extracted policy candidates without authorised human approval.
10. Do not invent business targets, scoring formulas, retention periods or permissions.

### 1.4 Scope boundaries

Implement the functionality supported by the supplied project documents. Do not add unrelated capabilities, external integrations, automated decision-making or additional product features without an approved requirement.

The supplied documents do not fully define every business rule. Missing decisions are listed in [Section 5](#5-decisions-required-before-dependent-implementation).

---

## 2. Repository Baseline and Initial Gate

**No developer or coding agent should begin broad implementation before completing this gate.**

### 2.1 Repository inspection

The team must inspect the actual repository because the supplied HLD and architecture documents state that repository-specific details have not yet been verified.

Record:

- Existing frontend and backend frameworks and versions.
- Existing application entry points and module boundaries.
- Existing database, schema, migrations and seed data.
- Existing authentication and authorisation implementation.
- Existing API routes and frontend API clients.
- Existing file storage, queue and worker implementation.
- Existing AI/provider integrations and prompt/configuration management.
- Existing tests, linting, formatting, build and deployment scripts.
- Existing environment variable names and configuration conventions.
- Existing reusable components and dependencies.
- Known incomplete, duplicated or conflicting implementations.

Run the current build and tests before changing code. Capture failures as baseline failures rather than attributing them to new work.

### 2.2 Baseline deliverable

Create or update a repository assessment containing:

```text
Repository baseline
- Current stack and versions
- Existing module map
- Existing database and migration status
- Existing authentication and tenant model
- Existing API inventory
- Existing worker/integration inventory
- Build and test commands/results
- Reusable code and dependencies
- Conflicts or gaps against this guide
- Recommended changes requiring approval
```

**Gate 0 completion:** The team can explain the existing project structure, identify reusable code and agree on the implementation boundaries. No unnecessary rewrite is proposed.

---

## 3. Backend Architecture

### 3.1 Recommended architecture

Use a **modular monolith** with independently runnable API and worker processes:

```text
React Web Application
        |
        | HTTPS / JSON / multipart upload
        v
Versioned REST API (/api/v1)
        |
        +-- Authentication and tenant context
        +-- Organisations, identity and teams
        +-- Documents and policies
        +-- Tickets
        +-- SLA engine
        +-- Performance and coaching
        +-- AI orchestration and knowledge retrieval
        +-- Approvals and audit
        +-- Reporting
        |
        +--------------------+
        |                    |
        v                    v
Primary database       Private object storage
        |
        +--------------------+
        |
        v
Background job queue
        |
        v
Worker process
        |
        +-- Document extraction
        +-- Policy candidate extraction
        +-- AI ticket workflows
        +-- SLA scheduled evaluation
        +-- Performance calculations
        +-- Other approved asynchronous tasks
        |
        +--> LLM provider adapter
        +--> Tenant-scoped retrieval/index
        +--> Logs, metrics and traces
```

The API and worker may be deployed as separate processes while sharing the same modular-monolith codebase and domain contracts.

### 3.2 Layer responsibilities

| Layer | Responsibility | Must not do |
|---|---|---|
| Presentation | React screens, forms, dashboards and role-aware navigation | Connect directly to the database or LLM provider |
| API | HTTP routing, authentication middleware, validation, permission checks and response mapping | Contain complex domain rules |
| Application | Use-case orchestration, transactions and workflow coordination | Depend on UI components |
| Domain | Entities, value objects, policy/SLA/ticket/performance rules and state transitions | Depend on HTTP or provider SDKs |
| Infrastructure | Database, object storage, queues, embeddings, LLM adapters and external integrations | Leak provider-specific details into domain code |
| Observability | Correlation IDs, structured logs, metrics, traces and health checks | Log secrets or unnecessary sensitive data |

### 3.3 Domain modules and ownership boundaries

| Module | Responsibility | Primary data |
|---|---|---|
| Organisations | Tenant configuration and lifecycle | Organisations |
| Identity and access | Users, memberships, roles and permissions | Users, memberships, roles, permissions |
| Teams | Departments, teams and team membership | Departments, teams, team memberships |
| Documents | Secure upload, metadata, versions and extraction status | Documents, document versions, attachments |
| Policies | Policy lifecycle, extracted rules, approval and effective versions | Policies, policy versions, extracted rules |
| Tickets | Ticket lifecycle, comments, attachments and assignment | Tickets, comments, ticket attachments |
| SLA | SLA configuration, calendars, evaluation and escalation | SLA policies, calendars, evaluations |
| AI orchestration | Task-specific AI workflows and execution tracking | Agent executions, AI analyses |
| Knowledge/retrieval | Approved knowledge and permission-filtered retrieval | Knowledge articles, versions, index metadata |
| Approvals and audit | Governed decisions and audit history | Approvals, policy approvals, audit logs |
| Performance/coaching | Verified measurements, deterministic assessments and coaching | Assignments, measurements, assessments, results, coaching records |
| Reporting | Authorised dashboards, aggregations and exports | Report definitions/snapshots where configured |

A module owns its domain rules and persistence interface. Other modules call its application-service interface rather than writing directly to its tables or collections.

### 3.4 Recommended technology direction

The source documents support the following direction, but do not identify a fully approved backend framework or infrastructure vendor.

| Concern | Recommendation / source position | Status |
|---|---|---|
| Backend language | TypeScript, strict mode | Recommended in LLD |
| Runtime | Node.js if TypeScript backend is used | Confirm against repository |
| HTTP framework | Retain existing framework; if none exists, choose and approve one framework (for example Express or Fastify) before implementation | Decision required |
| Request validation | Zod is recommended in the capstone specification; use existing equivalent if established | Recommended |
| API style | Versioned REST API, JSON; multipart for file upload | Defined |
| Frontend | React web UI is shown in Component Design; verify repository | Documented direction |
| Primary database | MongoDB is proposed in one source; relational design is explicitly requested in another | **Unresolved approval decision** |
| Object storage | Private object storage | Technology not selected |
| Queue | Background job queue | Technology not selected |
| Vector search | Tenant-scoped vector index | Technology not selected |
| AI providers | Claude/OpenAI or other approved providers behind an adapter | Provider decision required |
| API documentation | OpenAPI 3.x draft | Defined direction |
| Tests | Unit, integration, API contract, security, AI evaluation and E2E | Defined |
| Deployment | Web frontend, API and worker; managed services where appropriate | Cloud/vendor decision required |

Do not install both relational and document databases as competing primary stores unless a separately approved architecture requires it. Do not select a framework, database, queue, storage vendor or LLM provider by assumption.

---

## 4. Database Design

### 4.1 Database decision

There is a material conflict in the supplied documents:

- The architecture/capstone direction recommends MongoDB.
- The Database Design document presents a relational logical model because the project brief explicitly asks for a relational model and ERD.

The team must assess the current repository, relationship complexity, transaction needs, reporting requirements, operational skills and migration cost. The coach/product owner must approve one primary database and its migration strategy before schema-dependent implementation.

The logical entities below describe the required domain information. They are not permission to implement two primary databases.

### 4.2 Logical entities

| Domain | Entity | Important fields / relationships |
|---|---|---|
| Tenant | `organisations` | id, name, status, settings |
| Identity | `users` | id, email, display_name, status |
| Identity | `organisation_memberships` | id, organisation_id, user_id, status; unique organisation/user pair |
| Access | `roles` | id, organisation_id, name |
| Access | `permissions` | id, code, description |
| Access | `role_permissions` | role_id, permission_id |
| Teams | `departments` | id, organisation_id, name |
| Teams | `teams` | id, organisation_id, department_id, name |
| Teams | `team_memberships` | team_id, user_id, role_in_team |
| Documents | `documents` | id, organisation_id, storage_key, type, status |
| Documents | `document_versions` | id, document_id, version, checksum, effective dates |
| Policy | `policies` | id, organisation_id, policy_type, owner_id, status |
| Policy | `policy_versions` | id, policy_id, version, status, effective_from, effective_to |
| Policy | `extracted_rules` | id, policy_version_id, rule_type, payload, evidence |
| Policy | `policy_approvals` | id, extracted_rule_id, reviewer_id, decision, reason |
| SLA | `sla_policies` | id, organisation_id, name, version, status |
| SLA | `sla_calendars` | id, organisation_id, timezone, business_hours |
| SLA | `sla_evaluations` | id, ticket_id, policy_version, due_at, risk, evaluated_at |
| Tickets | `tickets` | id, organisation_id, requester_id, team_id, status, priority |
| Tickets | `ticket_comments` | id, ticket_id, author_id, body, visibility |
| Tickets | `ticket_attachments` | id, ticket_id, storage_key, filename, content_type |
| AI | `ticket_ai_analyses` | id, ticket_id, execution_id, output, model_version |
| Knowledge | `knowledge_articles` | id, organisation_id, status, approved_version_id |
| Knowledge | `knowledge_versions` | id, article_id, version, content, status |
| Performance | `role_performance_assignments` | id, organisation_id, role_id, kpa_id, effective dates |
| Performance | `performance_measurements` | id, organisation_id, kpi_id, subject_user_id, period, value, provenance |
| Performance | `performance_assessments` | id, organisation_id, subject_user_id, period, config_version, score |
| Performance | `performance_results` | id, assessment_id, kpi_id, measured_value, score, weight |
| Coaching | `coaching_records` | id, organisation_id, employee_id, leader_id, action, due_at |
| Governance | `approvals` | id, organisation_id, target_type, target_id, status |
| Audit | `audit_logs` | id, organisation_id, actor_id, action, before, after, created_at |
| AI/jobs | `agent_executions` | id, organisation_id, workflow, status, model, duration |

The table is a logical starting point. Confirm field types, nullability, deletion behavior, uniqueness, indexing and relationships during schema design.

### 4.3 Database conventions

- Every tenant-owned record must carry an `organisation_id` or an equivalent enforceable tenant relationship.
- Store timestamps in UTC. Apply the organisation's configured timezone only for calendar and business-time calculations.
- Use primary keys, foreign keys, unique constraints and indexes where supported by the chosen database.
- Preserve provenance for measurements, AI recommendations and extracted policy rules.
- Store file bytes in private object storage; persist metadata and storage keys in the database.
- Enforce child/parent tenant consistency using composite constraints or service-level invariant checks.
- Use immutable version records for policy and knowledge versions where required.
- Persist enough evaluation input and policy-version metadata to explain historical SLA results.
- Restrict access to employee performance records and sensitive ticket content.
- Define retention, legal hold, deletion and pseudonymisation behavior only after approval.

### 4.4 Recommended indexes and constraints

For a relational implementation, assess at least these indexes:

```sql
-- Illustrative logical index definitions; adapt syntax to the approved engine.
UNIQUE (organisation_id, user_id)             -- organisation_memberships
(organisation_id, status, priority, created_at) -- ticket queue
(organisation_id, requester_id, created_at)   -- requester ticket history
(organisation_id, team_id, status, priority)  -- team queue
(organisation_id, policy_type, status, effective_from)
UNIQUE (parent_id, version)                   -- versioned records
(organisation_id, target_type, target_id, created_at) -- audit lookup
UNIQUE (organisation_id, execution_id)        -- AI execution lookup
```

For MongoDB, translate these requirements into appropriate compound/unique indexes and schema validation. The exact index implementation depends on the approved database.

### 4.5 Tenant-scoped repository contract

Every repository method that accesses tenant-owned data must receive a trusted tenant context explicitly.

```ts
export type TenantContext = {
  organisationId: string;
  userId: string;
  roles: string[];
};

export interface TicketRepository {
  findById(
    tenant: TenantContext,
    ticketId: string
  ): Promise<Ticket | null>;

  list(
    tenant: TenantContext,
    filters: TicketFilters
  ): Promise<PaginatedResult<Ticket>>;
}
```

Never treat an `organisationId` in a request body or query string as proof of access. Resolve tenant membership from the authenticated principal and verify it before invoking a domain use case.

---

## 5. Decisions Required Before Dependent Implementation

The documents deliberately leave several decisions open. Track each as a decision record with owner, options, impact, approver and date.

| Decision | Why it matters | Required before |
|---|---|---|
| Primary database: MongoDB or relational | Determines schema, transactions, migrations, repository implementation and reporting | Database-dependent work |
| Existing repository stack/framework | Avoids unnecessary rewrite and incompatible dependencies | Foundation changes |
| Tenant isolation model | Determines membership, repository and storage enforcement | Tenant data implementation |
| Identity provider and session model | Determines login, refresh, token validation and user provisioning | Auth implementation |
| Final role and permission catalogue | Determines endpoint/service access rules | Protected endpoints |
| Object storage and file retention | Determines upload/download implementation and privacy controls | Document/attachment upload |
| Malware scanning and file limits | Required for secure file intake | File upload |
| Queue/worker technology | Determines asynchronous job contracts and retries | Worker implementation |
| LLM providers and data-processing constraints | Determines adapter configuration, privacy and supported models | AI provider integration |
| Embedding model and vector search | Determines knowledge indexing and retrieval | Semantic retrieval |
| Notification integrations | Required only if configured escalation/notification delivery is in scope | Notification implementation |
| Performance KPI/KPA catalogue and formulas | Source defines deterministic scoring but not formulas or thresholds | Performance calculations |
| SLA targets, pause conditions and escalation thresholds | Must come from approved organisation configuration | SLA evaluation |
| Retention periods, legal holds and deletion rules | Source says configurable but gives no periods | Production data lifecycle |
| Cloud provider, deployment topology and secrets manager | Determines production infrastructure | Deployment |
| Public ticket intake rules and rate limits | API draft mentions authorised public intake but does not define its policy | Public intake route |

**Rule:** If a decision blocks a module, the owner may build isolated domain interfaces, schemas with explicitly provisional status, mocks and tests. They must not silently choose a production behavior.

---

## 6. API Architecture and Shared Contracts

### 6.1 API conventions

- Base path: `/api/v1`.
- Use HTTPS in deployed environments.
- Use JSON request/response bodies except multipart file upload.
- Authenticate every endpoint unless a specific public intake route is explicitly approved.
- Derive tenant context from authenticated identity and verified membership.
- Validate request bodies, path parameters and query parameters at the API boundary.
- Use consistent pagination and error envelopes.
- Return `202 Accepted` for long-running asynchronous work and expose job status.
- Use idempotency keys for suitable retryable operations.
- Do not expose stack traces, secrets or unrestricted cross-tenant data.
- Use stable endpoint naming and explicit DTOs.
- Do not return persistence entities directly.

### 6.2 Endpoint catalogue

This catalogue follows the supplied API Specification draft. It is a starting contract, not a complete implementation specification. Every endpoint still needs full request/response schemas, permission codes, status codes and error cases in OpenAPI.

| Method | Endpoint | Owning module | Purpose |
|---|---|---|---|
| POST | `/auth/login` | Identity | Authenticate if local authentication is selected |
| POST | `/auth/refresh` | Identity | Refresh session/token if supported |
| GET | `/me` | Identity | Current user and permitted organisation context |
| GET/POST | `/organisations` | Organisations | List/create organisations; platform admin only |
| GET/PATCH | `/organisations/:organisationId` | Organisations | Read/update permitted organisation |
| GET/POST | `/users` | Identity | List/invite or create users |
| PATCH | `/users/:id` | Identity | Update permitted user |
| GET/POST | `/departments` | Teams | List/create departments |
| GET/POST | `/teams` | Teams | List/create teams |
| POST | `/documents` | Documents | Upload document |
| GET | `/documents` | Documents | List permitted documents |
| GET | `/documents/:id` | Documents | Get metadata/status |
| POST | `/documents/:id/process` | Documents | Queue extraction |
| GET | `/documents/:id/extractions` | Documents/Policies | View candidate extracted rules |
| POST | `/extracted-rules/:id/approve` | Policies/Approvals | Approve candidate rule |
| POST | `/extracted-rules/:id/reject` | Policies/Approvals | Reject candidate rule |
| GET/POST | `/policies` | Policies | List/create policies |
| GET | `/policies/:id/versions` | Policies | List policy versions |
| POST | `/policies/:id/activate` | Policies | Activate approved version |
| GET/POST | `/sla-policies` | SLA | List/create SLA policies |
| POST | `/sla-policies/:id/activate` | SLA | Activate approved SLA version |
| GET | `/sla/evaluations` | SLA | Query evaluations |
| POST | `/tickets` | Tickets | Create ticket |
| POST | `/tickets/ingest` | Tickets | Ingest from authorised external system |
| GET | `/tickets` | Tickets | Search/filter/paginate |
| GET | `/tickets/:id` | Tickets | Ticket details |
| PATCH | `/tickets/:id` | Tickets | Update permitted fields |
| POST | `/tickets/:id/comments` | Tickets | Add comment |
| POST | `/tickets/:id/analyze` | AI/Tickets | Start AI triage |
| GET | `/tickets/:id/analyses` | AI/Tickets | Retrieve analysis history |
| GET | `/tickets/:id/similar` | Knowledge/AI | Retrieve similar permitted tickets |
| POST | `/tickets/:id/recommend-resolution` | AI | Generate resolution recommendation |
| POST | `/tickets/:id/recommend-routing` | AI | Generate team recommendation |
| POST | `/tickets/:id/approve` | Approvals/Tickets | Approve proposed action |
| POST | `/tickets/:id/reject` | Approvals/Tickets | Reject proposed action |
| GET | `/tickets/:id/audit` | Audit | Ticket audit history |
| GET | `/reports` | Reporting | List authorised reports |
| GET | `/audit-logs` | Audit | Search permitted audit records |
| GET | `/jobs/:jobId` | Jobs | Check asynchronous job status |
| POST | `/performance/assessments/calculate` | Performance | Queue assessment calculation |

The performance endpoint is present in the API source example even though it is absent from the endpoint catalogue table in that source. Include it in the implementation contract after confirming the full performance API scope.

### 6.3 Standard success response

Use a consistent envelope. The following is illustrative and aligned with the supplied ticket example:

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

For a paginated collection, standardise the agreed pagination metadata before modules are implemented. A proposed shape is:

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 0
  },
  "requestId": "req_example"
}
```

The exact pagination mechanism (page/offset or cursor) is an implementation decision to confirm once existing frontend conventions are inspected.

### 6.4 Standard error response

Use the source-defined error envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request is invalid.",
    "requestId": "req_example",
    "fields": [
      {
        "field": "title",
        "message": "Title is required."
      }
    ]
  }
}
```

Use stable error codes. Suggested categories include validation, unauthenticated, forbidden, not found, conflict/state transition, rate limited, dependency unavailable and internal error. Agree exact codes centrally; do not create incompatible module-specific envelopes.

### 6.5 Asynchronous job contract

For document processing, AI triage and assessment calculation:

1. Authenticate and authorise the request.
2. Validate resource and tenant scope.
3. Create a job/execution record.
4. Enqueue a message containing identifiers and minimal required context, not unbounded sensitive payloads.
5. Return `202 Accepted` with an execution/job ID and status URL.
6. Worker claims and processes the job safely.
7. Update job status and result/error metadata.
8. Client polls `GET /jobs/:jobId` or uses an approved future notification mechanism.

Illustrative response:

```json
{
  "data": {
    "executionId": "exec_123",
    "status": "queued",
    "statusUrl": "/api/v1/jobs/exec_123"
  }
}
```

Jobs must be tenant-scoped, observable, retry-safe and protected against duplicate processing where relevant.

### 6.6 API ownership and change control

- Each module owner maintains its route, DTO, schema and OpenAPI definitions.
- Shared response envelopes, auth middleware, pagination and error mapping are owned by the foundation owner.
- A module owner must propose contract changes before changing a shared DTO.
- Breaking changes require team review and an API versioning decision.
- Frontend developers consume only documented contracts; they must not depend on database field names.

---

## 7. Authentication, Authorisation and Tenant Isolation

### 7.1 Authentication

Implement the identity provider and session model only after approval. The API draft includes bearer-token examples and a JWT OpenAPI scheme, but the final identity provider and token lifecycle are unresolved.

If bearer tokens are approved:

- Validate signature, issuer, audience, expiry and relevant claims.
- Resolve the authenticated user and organisation membership server-side.
- Do not accept client-supplied roles or tenant IDs as authoritative.
- Define refresh, logout/revocation and token storage behavior according to the selected identity provider.
- Rate-limit login and token-related endpoints.
- Never store credentials or signing secrets in source control or frontend bundles.

### 7.2 Authorisation

Use deny-by-default RBAC with resource-level checks. For every protected request verify:

1. Authenticated identity.
2. Active organisation membership.
3. Resource organisation matches the resolved tenant.
4. Ownership/team scope permits access.
5. The action permission is granted.
6. Any required approval has been obtained.

UI hiding is not a security control. Enforce checks in API middleware and application services.

### 7.3 Tenant isolation

Apply tenant scope to:

- Database reads and writes.
- Document and attachment storage keys.
- Background jobs and worker execution.
- Vector/semantic retrieval.
- Caches and search indexes.
- Analytics, reports and exports.
- Audit access and operational views.

Repositories must require tenant context explicitly. Add automated negative tests proving that a user from tenant A cannot access tenant B's tickets, documents, policies, knowledge, jobs or performance records.

### 7.4 File and AI security

- Validate upload size, extension, MIME type and actual content where possible.
- Store uploads privately; use authorised, short-lived download access.
- Scan uploaded files for malware where supported by the selected infrastructure.
- Treat uploaded text, ticket descriptions, retrieved passages and external content as untrusted data, never as system instructions.
- Filter retrieval by tenant and permissions before semantic ranking.
- Minimise or redact sensitive content sent to AI providers.
- Validate every structured model response before use.
- Never allow AI to directly activate policy configuration or execute consequential actions.
- Require human approval where the workflow is governed.

### 7.5 Audit and privacy

Record material actions with:

- Organisation/tenant.
- Actor.
- Action and target.
- Timestamp.
- Reason where applicable.
- Before/after values where appropriate.
- Request/correlation ID.
- Related execution or approval ID where applicable.

Restrict audit visibility and employee performance data. Define retention and deletion periods through approval; the source documents do not specify exact periods.

---

## 8. Backend Folder Structure

Adapt this structure to the existing repository. Do not force a rewrite merely to match the example.

```text
src/
  app.ts
  server.ts

  config/
    env.ts
    logger.ts

  shared/
    errors/
    middleware/
    validation/
    logging/
    auth/
    tenancy/
    pagination/
    contracts/

  modules/
    organisations/
      routes/
      controllers/
      schemas/
      services/
      domain/
      repositories/
      mappers/
      tests/

    identity/
    teams/
    documents/
    policies/
    sla/
    tickets/
    ai/
    knowledge/
    performance/
    coaching/
    approvals/
    reporting/
    audit/
    jobs/

  infrastructure/
    database/
    object-storage/
    queue/
    llm/
    embeddings/
    observability/

  workers/
    document-ingestion/
    ticket-ai/
    sla-evaluation/
    performance-assessment/

  tests/
    integration/
    contract/
    security/
    e2e/

openapi/
  openapi.yaml

scripts/
```

### 8.1 Module internals

| Folder | Responsibility |
|---|---|
| `routes/` | Register HTTP routes and middleware |
| `controllers/` | Translate HTTP requests to application calls and map responses |
| `schemas/` | Validate request/response DTOs |
| `services/` | Application use cases and orchestration |
| `domain/` | Entities, value objects, invariants and business rules |
| `repositories/` | Persistence interfaces and tenant-scoped implementations |
| `mappers/` | Convert persistence models to domain objects and API DTOs |
| `tests/` | Module unit and integration tests |

Keep controllers thin. Keep domain rules independent of UI, HTTP and provider SDKs. Use explicit DTOs and versioned contracts.

### 8.2 Dependency direction

Preferred dependency direction:

```text
Routes/Controllers
       |
       v
Application Services
       |
       v
Domain Model
       ^
       |
Repository Interfaces
       ^
       |
Infrastructure Repository Implementations
```

Domain modules must not import another module's database implementation. Use exported application-service interfaces or shared contracts for cross-module calls. Avoid circular dependencies.

---

## 9. Shared Contracts and Coding Conventions

These contracts must be agreed before parallel implementation.

### 9.1 Tenant context

```ts
export type TenantContext = {
  organisationId: string;
  userId: string;
  roles: string[];
};
```

The authenticated request middleware creates this context after verifying membership. It is passed to application services and tenant-scoped repositories. Do not construct it from untrusted request-body values.

### 9.2 AI recommendation contract

```ts
export type EvidenceReference = {
  sourceType:
    | "approved_policy"
    | "knowledge_article"
    | "historical_ticket";
  sourceId: string;
  version?: string;
  excerpt?: string;
};

export type Recommendation<T> = {
  result: T;
  confidence?: number;
  evidence: EvidenceReference[];
  warnings: string[];
  executionId: string;
  requiresHumanReview: boolean;
};
```

All AI component outputs must be typed, validated and traceable. Add model/configuration version metadata to execution records. Do not represent a recommendation as an approved decision.

### 9.3 Naming and code standards

- TypeScript strict mode where TypeScript is used.
- Use consistent naming already established by the repository.
- Prefer `camelCase` for variables/functions, `PascalCase` for types/classes and the repository's established file naming convention.
- Use explicit request and response DTOs.
- Use UTC timestamps in persistence and API values.
- Use stable, documented status enums and error codes.
- Avoid `any`; validate unknown external data.
- Keep functions and modules cohesive and narrowly scoped.
- Do not duplicate shared auth, tenant, logging or error-handling code.
- Do not add dependencies without explaining the need and checking existing equivalents.

### 9.4 Cross-module communication

- Synchronous use cases: call another module through its exported application-service interface.
- Asynchronous workflows: publish a versioned job/event contract containing identifiers, tenant scope and minimal necessary data.
- Persistence: only the owning module writes its data.
- Failures: use shared typed errors and consistent logging.
- No direct cross-module table/collection writes.
- No provider SDK imports outside the relevant infrastructure adapter.

### 9.5 Shared files

The foundation owner maintains shared contracts, app bootstrap, middleware, environment parsing and global error handling. Other owners should request changes through a small pull request or documented proposal rather than independently editing the same shared files.

---

## 10. Development Phases

Phases are ordered by dependency. Within a phase, the five owners can work in parallel once shared interfaces and decisions are approved.

### Phase 0 — Repository baseline and architecture approval

**Objective:** Understand the existing repository and settle blocking technical decisions.

**Components:**
- Repository assessment.
- Existing frontend/backend integration inventory.
- Technology and database decision records.
- Tenant, identity and permission design.
- Shared contracts and module boundaries.

**Implementation steps:**
1. Inspect the complete repository and current project documentation.
2. Run current build, lint and test commands; capture baseline results.
3. Map existing routes, models, services, dependencies and integrations.
4. Identify reusable code and avoid unnecessary rewrites.
5. Confirm primary database and migration approach.
6. Confirm backend framework/runtime based on repository evidence.
7. Confirm identity provider, token/session model and role catalogue.
8. Decide tenant isolation enforcement approach.
9. Record object storage, queue, LLM and vector search decisions or explicitly mark them blocked.
10. Agree shared DTOs, error envelope, pagination, tenant context, job contract and module ownership.
11. Review and approve the architecture before schema-dependent work.

**Expected files/deliverables:**
- Repository assessment.
- Architecture decision records.
- Approved module map.
- Shared contract definitions.
- Environment variable inventory.
- Baseline test/build evidence.

**Dependencies:** None.

**Completion criteria:**
- Existing codebase and build state are documented.
- Blocking decisions are approved or have explicit owners/deadlines.
- Module boundaries and shared interfaces are agreed.
- No implementation has silently introduced a second primary database or new product scope.

**Testing:** Baseline build, lint and test commands recorded.

### Phase 1 — Backend foundation, identity and tenant context

**Objective:** Provide a secure, testable foundation for all domain modules.

**Components:**
- API bootstrap and versioning.
- Environment configuration.
- Database connection and migration/schema setup.
- Authentication integration.
- Tenant context and RBAC.
- Validation and error handling.
- Structured logging, request IDs and health checks.

**Implementation steps:**
1. Adapt the repository's existing application entry point.
2. Implement validated environment configuration; fail startup when required configuration is missing.
3. Configure database connection using the approved database.
4. Implement migration/schema lifecycle according to the chosen engine.
5. Implement authentication middleware using the approved identity model.
6. Resolve user and organisation membership from trusted identity.
7. Attach `TenantContext` to the request/application execution context.
8. Implement reusable permission checks and deny-by-default behavior.
9. Implement shared validation middleware and error mapping.
10. Add request/correlation IDs and structured logs.
11. Add health/readiness checks without exposing secrets.
12. Publish shared contracts for module owners.

**Expected files/deliverables:**
- `src/app.ts`, `src/server.ts` or existing equivalents.
- `src/config/`.
- `src/shared/auth/`, `tenancy/`, `errors/`, `middleware/`, `validation/`, `logging/`.
- Database infrastructure and initial migrations/schema.
- `.env.example`.
- Foundation unit/integration tests.

**Dependencies:** Phase 0 decisions.

**Completion criteria:**
- API starts using documented configuration.
- Protected route receives trusted user and tenant context.
- Unauthenticated and unauthorised requests are rejected consistently.
- Tenant-scoped repository pattern is demonstrable.
- Shared errors and request IDs are consistent.

**Testing:**
- Authenticated/unauthenticated route tests.
- Membership and permission tests.
- Cross-tenant negative tests.
- Invalid environment configuration tests.
- Error-envelope tests.
- Database connectivity tests.

### Phase 2 — Organisation, teams, documents and policy lifecycle

**Objective:** Implement tenant administration and governed document/policy management.

**Components:**
- Organisations, users, departments and teams.
- Document metadata and private upload.
- Document versions and extraction job tracking.
- Policy versions and extracted rule candidates.
- Human review, approval and activation.
- Audit records for governed changes.

**Implementation steps:**
1. Implement organisation/user membership and permitted organisation administration.
2. Implement department/team CRUD and team membership rules.
3. Implement private document upload with validation and metadata persistence.
4. Store file bytes in approved object storage; do not store raw file bytes in ordinary database fields unless explicitly approved.
5. Create document/version records with checksum and processing status.
6. Implement document process endpoint and enqueue extraction job.
7. Implement extraction worker interface; preserve page/section provenance.
8. Structure candidate policy rules with source document/version, evidence, confidence and ambiguity flags.
9. Implement policy lifecycle: Draft → Pending Approval → Approved → Active → Expired/Archived.
10. Implement reviewer decision, reason, actor and timestamp records.
11. Prevent activation until an authorised approval exists and effective-date checks pass.
12. Record audit events for changes and decisions.
13. Expose metadata, extraction status and candidate review APIs.

**Expected files/deliverables:**
- `modules/organisations/`
- `modules/identity/` (organisation membership and administration additions)
- `modules/teams/`
- `modules/documents/`
- `modules/policies/`
- `modules/approvals/` (policy approval integration)
- `workers/document-ingestion/`
- Object-storage adapter and queue adapter.
- Migrations/schema and module tests.
- OpenAPI updates.

**Dependencies:** Phase 1; approved object storage and queue choices. AI-assisted rule extraction can initially use a stubbed extraction adapter until Phase 4 is integrated.

**Completion criteria:**
- Tenant-authorised users can manage permitted organisation/team records.
- Uploads are private and metadata/version status is persisted.
- Extraction produces candidates with source provenance.
- Candidate rules cannot become active without authorised approval.
- Policy versions and decisions are auditable.

**Testing:**
- Tenant isolation for all records and files.
- Upload type/size/content validation.
- Extraction job success/failure/retry.
- Policy state-machine transition tests.
- Approval permission and concurrency tests.
- Effective-date and immutable-version tests.

### Phase 3 — Ticket management

**Objective:** Implement the core support ticket lifecycle and stable interfaces for AI and SLA consumers.

**Components:**
- Ticket intake and authorised external ingestion.
- Ticket search, filtering and pagination.
- Ticket details and permitted updates.
- Comments and visibility.
- Private attachments.
- Assignment/team scope and ticket history/audit integration.

**Implementation steps:**
1. Define ticket DTOs and take internal status values, allowed transitions and role restrictions from tenant workflow configuration; require organisation-admin approval before activation and never infer transitions.
2. Implement ticket creation with title, description and supported requester/product/service fields.
3. Derive organisation from authenticated tenant context.
4. Verify requester permission and team/resource scope.
5. Implement list/search/filter/pagination with tenant scope applied before returning results.
6. Implement ticket detail and permitted field updates.
7. Implement comments with author and visibility checks.
8. Implement private attachment upload and authorised access using the shared file-storage contract.
9. Implement authorised external ingestion only where its integration/authentication contract is approved.
10. Publish ticket-created/updated application events or interfaces for SLA and AI workflows.
11. Record material changes and ensure ticket audit can be queried.
12. Expose stable ticket read interfaces to AI, SLA and reporting modules.

**Expected files/deliverables:**
- `modules/tickets/`
- Ticket migrations/schema and indexes.
- Ticket attachment integration.
- Ticket event/job contracts.
- OpenAPI updates and tests.

**Dependencies:** Phase 1; Phase 2 team and storage interfaces. AI and SLA may develop against the agreed ticket DTO/interface using fixtures while ticket persistence is completed.

**Completion criteria:**
- Permitted users can create, view, search and update tickets within scope.
- Comments and attachments enforce tenant, ownership/team and visibility permissions.
- Ticket creation does not trust a client-supplied tenant ID.
- Ticket changes are auditable.
- Ticket interfaces are stable for AI and SLA consumers.

**Testing:**
- CRUD and query validation.
- Role/team/ownership permission tests.
- Cross-tenant access tests.
- Attachment privacy tests.
- Pagination/filter tests.
- Concurrent update and invalid transition tests.

### Phase 4 — SLA engine

**Objective:** Calculate explainable response/resolution deadlines and persist SLA risk/evaluation history.

**Components:**
- SLA policy configuration and versions.
- Business calendars, timezone and working hours.
- First response, average response and resolution targets.
- Priority/team/department scope.
- Approved pause conditions, escalation rules and notifications.
- Evaluation history and scheduled evaluation worker.

**Implementation steps:**
1. Confirm SLA targets and thresholds originate from approved organisation configuration.
2. Define SLA policy and calendar DTOs.
3. Implement versioned SLA policy configuration and approval/activation controls as required by the governance model.
4. Implement calendar/timezone handling, including configured business hours and public holidays.
5. Implement policy resolution for a ticket based on tenant, priority and configured scope.
6. Calculate first-response and resolution deadlines from reliable ticket timestamps.
7. Implement average response evaluation only after its precise calculation definition is approved.
8. Re-evaluate on relevant ticket events and scheduled checkpoints.
9. Persist evaluation inputs, policy version, deadline, risk, evaluation timestamp and explanation.
10. Trigger only configured escalation workflows when thresholds are met.
11. Make scheduled jobs idempotent and retry-safe.
12. Expose SLA policy and evaluation endpoints.

**Expected files/deliverables:**
- `modules/sla/`
- SLA migrations/schema.
- `workers/sla-evaluation/`
- Calendar and evaluation unit tests.
- OpenAPI updates.

**Dependencies:** Phase 1; ticket interface from Phase 3; approved SLA targets, calendars and pause/escalation rules. Can develop calculations using fixture tickets before ticket integration.

**Completion criteria:**
- Correct approved policy version is resolved.
- Deadlines respect configured calendar/timezone and target.
- Historical evaluation records remain explainable and retain the policy version used.
- Expired/superseded policies are not applied incorrectly.
- Escalations occur only when configured and authorised.

**Testing:**
- Business-hours boundary and timezone tests.
- Holidays and daylight-saving behavior where relevant to configured regions.
- Priority and team policy selection.
- Pause/resume tests only if pause conditions are approved.
- Historical version consistency.
- Duplicate scheduled job and retry tests.

### Phase 5 — AI workflows and knowledge retrieval

**Objective:** Implement bounded, auditable AI workflows for document analysis and ticket assistance.

**Components:**
- LLM provider adapter.
- Document classifier/text extraction coordinator and rule extraction integration.
- Ticket classifier and summariser.
- Priority recommender.
- Similarity retrieval.
- Resolution recommender.
- Team routing recommender.
- SLA risk insight component.
- AI execution tracking, confidence/evidence and evaluation.

**Implementation steps:**
1. Confirm approved providers, models, data-processing constraints and embedding/retrieval technology.
2. Implement provider adapter interface so domain modules do not import provider SDKs.
3. Secure credentials and model/configuration settings.
4. Define typed input/output schemas for each bounded component.
5. Implement execution ID, timeout, structured logging and failure handling for every component.
6. Implement ticket classification against configured taxonomy.
7. Implement structured ticket summary with issue, impact and missing information.
8. Implement priority recommendation using configured priority factors; do not invent severity rules.
9. Implement tenant- and permission-filtered similarity retrieval.
10. Implement resolution recommendations using approved policy/knowledge evidence and citations.
11. Implement routing recommendations using configured routing rules and permitted workload data.
12. Implement SLA risk insights from verified ticket/SLA data; do not replace deterministic SLA evaluation.
13. Persist AI analysis/execution metadata, model/provider, prompt/config version, evidence references, warnings and reviewer outcome.
14. Validate model output before persistence or downstream use.
15. Flag low-confidence, missing-evidence or uncertain outputs for human review.
16. Integrate AI suggestions with ticket and policy review flows without allowing AI to perform governed mutations.
17. Add evaluation datasets/tests for groundedness, extraction accuracy, classification and prompt-injection resistance.

**Expected files/deliverables:**
- `modules/ai/`
- `modules/knowledge/`
- `infrastructure/llm/`
- `infrastructure/embeddings/`
- `workers/ticket-ai/`
- AI execution and analysis persistence.
- Evaluation fixtures and test reports.
- Provider configuration documentation.
- OpenAPI updates.

**Dependencies:** Phase 1; Phase 2 approved policy/knowledge provenance; Phase 3 ticket interfaces; approved provider and vector-search decisions. Use mock adapters until approvals are made.

**Completion criteria:**
- Each AI component has a bounded task and typed contract.
- Retrieval is tenant- and permission-filtered before ranking.
- Outputs contain evidence or explicitly identify missing evidence.
- Low-confidence output is flagged for human review.
- Provider failures do not corrupt tickets or policy documents.
- AI cannot activate policies or execute consequential actions.
- Every execution is traceable.

**Testing:**
- Schema validation and malformed model output.
- Provider timeout/retry/circuit behavior.
- Prompt injection and untrusted document content.
- Cross-tenant retrieval isolation.
- Evidence/citation correctness and groundedness.
- Confidence/uncertainty handling.
- Data minimisation and sensitive-data redaction.
- Human approval enforcement.

### Phase 6 — Performance, coaching, reporting and dashboards

**Objective:** Implement verified performance assessment and authorised reporting without allowing AI to determine numeric scores arbitrarily.

**Components:**
- Role/KPA/KPI assignments.
- Verified performance measurements and provenance.
- Deterministic assessment calculation.
- Assessment snapshots and result details.
- Coaching records.
- Authorised reports and dashboard queries.

**Implementation steps:**
1. Confirm KPI/KPA definitions, formulas, weights, scoring scales, periods and effective versions with the project owner.
2. Confirm permitted data sources and how measurements are verified.
3. Implement role-specific performance assignments with effective dates.
4. Implement measurement ingestion/validation and provenance.
5. Implement deterministic calculations using approved formula and weighting versions.
6. Persist assessment snapshot, configuration version, period and per-KPI result.
7. Ensure a leader's own assessment is distinct from team metrics.
8. Implement coaching records with employee, leader, action and due date.
9. Enforce restricted access to employee performance records.
10. Implement authorised report queries and dashboard aggregations.
11. Avoid exposing unauthorised metrics through cached or exported data.
12. Document report definitions, filters and calculation provenance.

**Expected files/deliverables:**
- `modules/performance/`
- `modules/coaching/`
- `modules/reporting/`
- Performance migrations/schema.
- Assessment worker if calculations are asynchronous.
- API/OpenAPI definitions and tests.

**Dependencies:** Phase 1; approved KPI/KPA formulas and source data; Phase 3 ticket data if ticket measures are used. The source documents do not provide actual formulas or thresholds; use approved configuration only.

**Completion criteria:**
- Assessments use verified measurements and approved versioned formulas.
- Assessment snapshots are reproducible and auditable.
- Access is limited by subject, leader and administrator permissions.
- Team reports do not disclose unauthorised personal details.
- AI does not arbitrarily determine numeric performance scores.

**Testing:**
- Formula/weighting unit tests.
- Measurement provenance and invalid-data tests.
- Version/effective-date tests.
- Subject/leader/team permission tests.
- Leader self-assessment separation.
- Export and aggregation tenant isolation.

### Phase 7 — System integration, verification and hardening

**Objective:** Verify that independently developed modules operate as one secure backend.

**Implementation steps:**
1. Merge modules through reviewed pull requests in dependency order.
2. Run database migrations from a clean environment.
3. Verify all module contracts against the shared API and job schemas.
4. Run end-to-end document ingestion and policy approval.
5. Run end-to-end ticket creation, triage, review and audit.
6. Run SLA evaluation against approved policy versions and calendars.
7. Run performance calculation using verified fixture/source data.
8. Run tenant-isolation and privilege-escalation suites.
9. Test provider/storage/queue outages and recovery.
10. Verify logs, correlation IDs, job status and operational health.
11. Resolve integration defects and record known limitations.
12. Publish test evidence; never report tests as passed unless executed.

**Deliverables:**
- Integrated backend.
- Integration and E2E test suites.
- Security test report.
- API contract/OpenAPI validation.
- Migration and setup instructions.
- Known issues and limitations.

**Dependencies:** Phases 1–6.

**Completion criteria:** All critical end-to-end flows work, critical security tests pass, contracts are consistent, and known limitations are documented.

### Phase 8 — Deployment and handover

**Objective:** Prepare a repeatable deployment and support handover.

**Implementation steps:**
1. Finalise environment variable documentation and `.env.example` without real secrets.
2. Provide reproducible local development setup.
3. Provide API and worker container/build configuration if containers are selected.
4. Document database setup, migration and seed procedure.
5. Document private object storage, queue and provider setup.
6. Configure production secrets through the approved secret-management mechanism.
7. Configure health/readiness checks, logs, metrics and alerts.
8. Confirm backups, restore procedure and retention configuration.
9. Publish complete OpenAPI/Swagger documentation.
10. Document deployment, rollback and operational recovery.
11. Provide test evidence, known issues and handover notes.

**Deliverables:**
- Deployment configuration and instructions.
- `.env.example`.
- Database migration/setup instructions.
- OpenAPI documentation.
- README and operational runbook.
- Backup/restore and rollback notes.
- Final test and known-issues report.

**Dependencies:** Phase 7 and approved infrastructure choices.

**Completion criteria:** Another developer can configure, run, test, deploy and diagnose the backend using the supplied documentation.

---

## 11. Five-Member Team Allocation

### 11.1 Ownership overview

Each member owns a defined set of modules. Shared contracts and integration points are agreed centrally, but module implementation remains with its owner.

| Member | Primary ownership | Main phases | Secondary collaboration |
|---|---|---|---|
| **Thuto** | Backend foundation, identity, tenant context, organisations, teams, shared API contracts | 0, 1, 2 foundation | Reviews security boundaries and shared integration |
| **Olerato** | Documents, private file handling, policy lifecycle, extraction review and policy approval | 2, 7 | Coordinates with Wandile on AI extraction |
| **Fhulu** | Ticket domain, ticket API, comments, attachments, queue/search and ticket history | 3, 7 | Provides stable ticket interfaces to Faith and Wandile |
| **Faith** | SLA engine, performance assessments, coaching and operational reporting | 4, 6, 7 | Consumes ticket events/data; coordinates with Thuto on access controls |
| **Wandile** | AI orchestration, provider adapters, knowledge retrieval, AI workers and AI evaluation | 5, 7 | Integrates with Olerato's document/policy provenance and Fhulu's ticket contracts |

All members participate in Phase 0 contract review, Phase 7 integration and Phase 8 handover. Ownership does not permit changing another member's module without agreement.

### 11.2 Thuto — Foundation, identity and organisation services

**Module ownership**
- `shared/` foundation contracts and middleware.
- `modules/organisations/`
- `modules/identity/`
- `modules/teams/`
- Shared API bootstrap, configuration and tenant-aware persistence conventions.

**Responsibilities**
1. Complete repository baseline with the team and record existing reusable infrastructure.
2. Implement or adapt server bootstrap, environment validation and API versioning.
3. Integrate the approved authentication provider/session model.
4. Resolve authenticated user and organisation membership.
5. Implement `TenantContext` and tenant-scoped repository conventions.
6. Implement shared RBAC/permission checks and deny-by-default middleware.
7. Implement organisation, user membership, department and team management.
8. Define shared error envelope, request IDs, logging and pagination contracts.
9. Maintain shared DTOs and job/event contract conventions.
10. Add health/readiness endpoints and database connection integration.
11. Review cross-tenant security tests with all module owners.

**Files/folders**
- `src/app.ts`, `src/server.ts` or existing equivalents.
- `src/config/`
- `src/shared/auth/`
- `src/shared/tenancy/`
- `src/shared/errors/`
- `src/shared/middleware/`
- `src/shared/validation/`
- `src/shared/logging/`
- `src/shared/contracts/`
- `src/modules/organisations/`
- `src/modules/identity/`
- `src/modules/teams/`
- Foundation migrations/schema and tests.

**APIs/services**
- `/auth/login`, `/auth/refresh` if local auth/session support is selected.
- `/me`.
- `/organisations` and `/organisations/:organisationId`.
- `/users`, `/users/:id`.
- `/departments`, `/teams`.
- Shared auth, tenant resolution and permission services.

**Dependencies**
- Phase 0 approval of stack, database, tenant model and identity provider.
- Olerato, Fhulu, Faith and Wandile depend on Thuto's tenant context, error handling and shared contracts.
- Thuto must not define another module's domain rules.

**Deliverables**
- Working foundation and organisation/IAM/team APIs.
- Shared contracts and `.env.example`.
- Database setup/migration baseline.
- Auth/RBAC/tenant tests.
- Setup notes and module integration guide.

**Testing responsibilities**
- Authentication and token/session behavior.
- Membership resolution and permission checks.
- Cross-tenant negative tests.
- Invalid configuration and error handling.
- Shared middleware/contract tests.
- Review tenant-scope enforcement in other modules.

### 11.3 Olerato — Documents and policy governance

**Module ownership**
- `modules/documents/`
- `modules/policies/`
- Policy-specific approval workflow integration.
- `workers/document-ingestion/` ingestion orchestration, excluding AI model implementation owned by Wandile.
- Document storage adapter integration at the domain boundary.

**Responsibilities**
1. Implement document metadata, versions, checksums and processing status.
2. Implement secure upload and authorised download interfaces using approved private storage.
3. Validate file type, size and content according to approved configuration.
4. Create extraction job records and enqueue the agreed document-ingestion contract.
5. Preserve extracted text provenance, including source page/section.
6. Persist candidate structured rules with evidence, confidence and ambiguity flags returned by the extraction component.
7. Implement policy and policy-version lifecycle.
8. Implement reviewer approval/rejection, reasons and immutable decision history.
9. Enforce effective dates and prevent unapproved policy activation.
10. Expose document status, extraction candidates, policy versions and approval APIs.
11. Record audit events for material policy/document actions.
12. Coordinate the extraction input/output contract with Wandile.

**Files/folders**
- `src/modules/documents/`
- `src/modules/policies/`
- Policy approval integration in `src/modules/approvals/`
- `src/workers/document-ingestion/` orchestration.
- Object-storage adapter interface/integration.
- Document/policy migrations/schema and tests.

**APIs/services**
- `POST /documents`
- `GET /documents`
- `GET /documents/:id`
- `POST /documents/:id/process`
- `GET /documents/:id/extractions`
- `POST /extracted-rules/:id/approve`
- `POST /extracted-rules/:id/reject`
- `GET/POST /policies`
- `GET /policies/:id/versions`
- `POST /policies/:id/activate`

**Dependencies**
- Thuto: tenant context, permissions, shared errors and persistence conventions.
- Faith: approved policy version interface for SLA consumers.
- Wandile: extraction/classification adapter and typed candidate-rule output.
- Approved object storage and queue technology.

**Deliverables**
- Document and policy services/routes/schemas.
- Secure file lifecycle.
- Versioned policy lifecycle and approval records.
- Extraction job orchestration.
- OpenAPI updates and tests.
- Document/policy setup and integration notes.

**Testing responsibilities**
- File validation, privacy and authorised download.
- Tenant and document-level permission checks.
- Extraction job failure/retry.
- Provenance preservation.
- Policy state transitions and effective dates.
- Approval permissions, concurrency and audit history.
- Verify candidates cannot become active without approval.

### 11.4 Fhulu — Ticket management

**Module ownership**
- `modules/tickets/`
- Ticket comments, attachments, search and queue.
- Ticket lifecycle and ticket-facing API contracts.
- Ticket audit integration.

**Responsibilities**
1. Define and implement ticket DTOs and validated request schemas.
2. Implement ticket creation and authorised external ingestion only where its contract is approved.
3. Derive tenant scope from `TenantContext`; never trust a request-body organisation ID.
4. Implement ticket listing, filtering, searching and pagination.
5. Implement ticket detail and permitted updates.
6. Implement comments and visibility controls.
7. Implement private attachment metadata/storage integration.
8. Enforce requester, team and role scope on reads and writes.
9. Publish stable ticket application-service interfaces for AI and SLA modules.
10. Publish ticket-created/updated events or job contracts where agreed.
11. Maintain ticket history and audit integration.
12. Document ticket statuses, allowed transitions and field-level permissions based on approved requirements.

**Files/folders**
- `src/modules/tickets/`
- Ticket migrations/schema and indexes.
- Ticket attachment adapter integration.
- Ticket event/contract definitions owned within the agreed shared contract process.
- Ticket unit/integration/API tests.

**APIs/services**
- `POST /tickets`
- `POST /tickets/ingest` only after external source/auth contract approval.
- `GET /tickets`
- `GET /tickets/:id`
- `PATCH /tickets/:id`
- `POST /tickets/:id/comments`
- Ticket attachment operations as finalised in OpenAPI.
- Ticket data interfaces consumed by SLA, AI and reporting.

**Dependencies**
- Thuto: tenant context, permission middleware, shared DTO/error conventions.
- Olerato: shared file-storage contract for attachments.
- Faith: ticket event timestamps and ticket read interface for SLA.
- Wandile: ticket content and stable read interface for AI analysis.

**Deliverables**
- Ticket module and API.
- Ticket persistence and indexes.
- Comments, attachments and search.
- Ticket integration contracts.
- OpenAPI updates and tests.

**Testing responsibilities**
- CRUD, validation and allowed state transitions.
- Requester/team/agent permission boundaries.
- Cross-tenant ticket access.
- Comment visibility and author checks.
- Attachment privacy.
- Pagination/filter correctness.
- Concurrency and audit behavior.

### 11.5 Faith — SLA, performance, coaching and reporting

**Module ownership**
- `modules/sla/`
- `modules/performance/`
- `modules/coaching/`
- `modules/reporting/`
- SLA evaluation and performance calculation workers.

**Responsibilities**
1. Confirm SLA targets, calendar definitions, timezones, pause rules and escalation thresholds with the project owner.
2. Implement versioned SLA policy configuration and evaluation.
3. Implement working calendars, business hours and public holidays.
4. Calculate response and resolution deadlines from reliable ticket events.
5. Persist SLA evaluation inputs, policy version, deadline, risk and explanation.
6. Implement scheduled/event-driven reevaluation and configured escalation records.
7. Confirm KPI/KPA catalogue, formulas, weights, scoring scales and assessment periods before coding scoring behavior.
8. Implement role performance assignments and verified measurement provenance.
9. Implement deterministic, versioned assessment calculation and result snapshots.
10. Implement coaching records.
11. Implement authorised reports and dashboard aggregation.
12. Ensure team metrics and a leader's own assessment remain distinct.
13. Coordinate with Fhulu on ticket event semantics and Thuto on permissions.

**Files/folders**
- `src/modules/sla/`
- `src/modules/performance/`
- `src/modules/coaching/`
- `src/modules/reporting/`
- `src/workers/sla-evaluation/`
- Performance assessment worker.
- Migrations/schema and tests.

**APIs/services**
- `GET/POST /sla-policies`
- `POST /sla-policies/:id/activate`
- `GET /sla/evaluations`
- `POST /performance/assessments/calculate`
- `GET /reports`
- Additional performance/coaching endpoints only after their full contracts are agreed.

**Dependencies**
- Thuto: tenant context, RBAC and shared infrastructure.
- Fhulu: ticket data/events and reliable timestamp definitions.
- Olerato: approved policy/version interfaces where SLA targets are policy-derived.
- Project owner: approved SLA targets and KPI/KPA formulas.
- Wandile: optional SLA risk insights; deterministic SLA engine remains Faith's responsibility.

**Deliverables**
- SLA engine and evaluation worker.
- Performance and coaching modules.
- Reporting APIs/queries.
- Approved formula/configuration contracts.
- OpenAPI updates, test evidence and operational notes.

**Testing responsibilities**
- Calendar, timezone, deadline and policy-version tests.
- Escalation thresholds and idempotency.
- Formula, weighting and provenance tests.
- Performance access controls and leader self-assessment separation.
- Tenant-safe reports, aggregations and exports.
- Verify AI does not set numeric performance scores or replace deterministic SLA outcomes.

### 11.6 Wandile — AI orchestration and knowledge retrieval

**Module ownership**
- `modules/ai/`
- `modules/knowledge/`
- `infrastructure/llm/`
- `infrastructure/embeddings/`
- `workers/ticket-ai/`
- AI evaluation fixtures and test harness.

**Responsibilities**
1. Confirm provider, model, embedding and vector search decisions with the team.
2. Implement provider-neutral interfaces and keep SDKs in infrastructure adapters.
3. Implement bounded AI components: classifier, summariser, priority recommender, similarity retrieval, resolution recommender, routing recommender and SLA risk insight.
4. Coordinate document classification and candidate rule extraction with Olerato.
5. Define typed task-specific inputs/outputs, timeouts, execution IDs and warnings.
6. Implement tenant- and permission-filtered retrieval of approved/effective documents and knowledge.
7. Return source IDs, versions and relevant evidence excerpts with recommendations.
8. Validate model output and reject malformed or unsupported structures.
9. Persist execution metadata, provider/model, prompt/config version, duration, status, evidence and reviewer outcome where available.
10. Implement confidence and uncertainty handling; low-confidence output requires human review.
11. Treat all uploaded/retrieved content as untrusted and defend against prompt injection.
12. Minimise/redact sensitive content sent to providers.
13. Ensure provider failure cannot corrupt the source ticket/document.
14. Integrate with Fhulu's ticket analysis interfaces and Olerato's document ingestion contract.
15. Build evaluation tests for groundedness, extraction accuracy, classification quality, uncertainty and cross-tenant isolation.

**Files/folders**
- `src/modules/ai/`
- `src/modules/knowledge/`
- `src/infrastructure/llm/`
- `src/infrastructure/embeddings/`
- `src/workers/ticket-ai/`
- AI evaluation tests/fixtures and configuration documentation.

**APIs/services**
- `POST /tickets/:id/analyze`
- `GET /tickets/:id/analyses`
- `GET /tickets/:id/similar`
- `POST /tickets/:id/recommend-resolution`
- `POST /tickets/:id/recommend-routing`
- AI application-service interfaces consumed by document and ticket modules.
- `GET /jobs/:jobId` is a shared job-status API; implementation ownership must be agreed with Thuto.

**Dependencies**
- Thuto: auth/tenant context, job contract, shared logging and configuration.
- Olerato: document and policy provenance, extraction orchestration contract.
- Fhulu: ticket DTO and analysis lifecycle integration.
- Faith: SLA inputs and performance boundaries.
- Approved provider and vector-search decisions.

**Deliverables**
- Provider adapter(s) and configuration.
- Bounded AI workflows and typed schemas.
- Permission-filtered retrieval.
- AI execution/analysis records.
- Evaluation suite and results.
- OpenAPI updates and operational notes.

**Testing responsibilities**
- Provider timeout/failure/retry behavior.
- Structured output validation.
- Groundedness, evidence references and uncertainty.
- Prompt injection and data exfiltration resistance.
- Cross-tenant and document-permission retrieval tests.
- Sensitive-data minimisation.
- Verify AI recommendations require review where specified and never perform governed mutations.

### 11.7 Shared work and fairness rules

- Each owner implements and tests their own module.
- Each owner reviews at least one other member's contract/integration pull request.
- Shared foundation changes are coordinated through Thuto.
- Module-specific business rules remain with the module owner.
- Do not assign two owners to write the same module or schema.
- Pair on integration boundaries, not duplicate implementation.
- Work blocked by an unresolved decision should be recorded explicitly and progressed only with safe mocks/interfaces.

---

## 12. Independent Development Guidelines

### 12.1 Before implementation begins

The team must agree and publish:

- `TenantContext`.
- Shared error envelope and error-code catalogue.
- Success response and pagination format.
- Authentication middleware contract.
- Permission-check interface.
- Database/repository conventions.
- Job status and job payload conventions.
- File storage interface.
- Audit event interface.
- AI recommendation/evidence contract.
- Ticket, document, policy and SLA cross-module DTOs.
- API route ownership.

Each owner should create a short module contract document before implementing cross-module behavior.

### 12.2 Module isolation

A module owner may:
- Create and modify files inside their owned module.
- Add module-local tests.
- Add module-owned migrations/schema changes following the agreed migration process.
- Add module-owned API definitions.
- Propose changes to shared contracts.

A module owner may not:
- Directly write another module's persistence records.
- Change shared middleware without review.
- Rename or alter another module's exported contract without agreement.
- Change environment variable names or global dependencies unilaterally.
- introduce a new primary datastore or provider without approval.

### 12.3 Mocking dependencies

When another module is not ready:
1. Import the agreed interface, not its internal implementation.
2. Use a module-local mock or test fixture.
3. Keep mock behavior aligned with the published contract.
4. Mark the integration as pending.
5. Replace the mock with the real adapter during integration.
6. Do not create a second competing DTO to work around an unfinished contract.

### 12.4 Database coordination

- Agree the primary database and migration tool first.
- Each module owns its schema/migration files.
- Do not edit another module's migration.
- Coordinate shared table/collection changes before creating migrations.
- Use additive migrations where possible.
- Do not run destructive migrations against shared environments without approval.
- Seed only synthetic development/test data.
- Preserve tenant consistency and version uniqueness.
- Document rollback limitations for each migration.

### 12.5 Shared configuration

- Thuto maintains environment parsing and `.env.example`.
- Module owners propose new variables with purpose, type, required/optional status and safe example.
- Secrets are never committed.
- Provider/model selection and thresholds belong in secure configuration, not hardcoded domain logic.
- Environment-specific values must not be embedded in source files.

---

## 13. Git Collaboration Workflow

### 13.1 Branching

Use a protected `main` branch and short-lived feature branches:

```text
main
  ├── feature/thuto-foundation
  ├── feature/olerato-documents-policies
  ├── feature/fhulu-tickets
  ├── feature/faith-sla-performance
  └── feature/wandile-ai-retrieval
```

For smaller work, use task branches from the relevant feature branch:

```text
feature/fhulu-ticket-search
feature/faith-sla-calendar
feature/wandile-ticket-classifier
```

### 13.2 Commit conventions

Use clear, scoped commit messages, for example:

```text
feat(tickets): add tenant-scoped ticket creation
test(sla): cover business-hours deadline calculation
fix(auth): reject inactive organisation membership
docs(api): document document-processing job response
```

### 13.3 Pull request requirements

Every pull request must include:

- Assigned owner and module.
- Purpose and linked requirement.
- Summary of behavior.
- Files/modules changed.
- API/schema/migration changes.
- Tests added and commands/results.
- Security and tenant-isolation impact.
- Screenshots or API examples where useful.
- Outstanding issues and integration dependencies.

### 13.4 Review and merge rules

1. Pull latest `main` before starting and before opening a PR.
2. Keep PRs small and module-scoped.
3. Do not commit generated secrets, local uploads or environment files.
4. Run formatting, lint, type-check, unit and relevant integration tests.
5. Request review from the owner of any affected shared contract.
6. Resolve migration conflicts with the affected module owner.
7. Merge only after CI and required reviews pass.
8. Rebase/merge latest `main` and rerun relevant tests before final merge.
9. Do not force-push shared branches without coordination.
10. Tag integration milestones/releases.

### 13.5 Avoiding shared-file conflicts

- Thuto is the primary editor for bootstrap, global middleware, environment parsing and shared contracts.
- Each module owner owns their own routes, schemas, services, repositories and tests.
- Open a contract-change PR before consuming a breaking shared change.
- Avoid multiple people editing the same migration or OpenAPI section simultaneously; divide OpenAPI by tags/files if tooling permits, then generate/merge the final document.
- Communicate planned changes to shared types before coding against them.

---

## 14. Testing Strategy

Testing is required at module level and again after integration. A passing test suite is evidence only for the tested environment and cases.

### 14.1 Test layers

| Test type | What to verify | Primary owners |
|---|---|---|
| Unit | Domain rules, validation, state transitions, calendar math, scoring formulas | Every module owner |
| Integration | Repositories, tenant filters, object storage, queue workers, provider adapters | Module owner + relevant infrastructure owner |
| API contract | Request/response schemas, auth, permissions, pagination and error envelopes | Route owner; Thuto for shared contracts |
| Database | Constraints, indexes, migrations, tenant consistency and transactions | Module owner + Thuto |
| Authentication | Login/session/token validation, membership and inactive-user behavior | Thuto |
| Security | Cross-tenant access, privilege escalation, file access, prompt injection and data leakage | All owners; coordinated by Thuto |
| AI evaluation | Extraction correctness, classification, summary completeness, groundedness and confidence | Wandile with Olerato |
| E2E | Complete user journeys across API, workers, database and storage | All owners during Phase 7 |

### 14.2 Mandatory critical scenarios

1. A user cannot access another tenant's ticket, document, policy, knowledge item or performance record.
2. A user cannot access resources outside their ownership/team scope.
3. Extracted policy remains inactive until approved.
4. Expired or superseded policy is not applied to new evaluations.
5. Policy activation checks approval, effective date and concurrency/version.
6. SLA deadline uses the configured calendar and approved target.
7. Historical SLA evaluation retains the policy version used.
8. AI recommendation includes evidence or explicitly identifies missing evidence.
9. Low-confidence output is flagged for human review.
10. Required approval blocks consequential action.
11. Provider failure does not corrupt the original ticket or document.
12. File download requires authorised access.
13. Background jobs are safe to retry and do not duplicate consequential effects.
14. Performance calculation uses approved formulas and verified measurements.
15. A leader's own assessment is distinct from team metrics.
16. Reports and exports enforce tenant and role permissions.
17. Logs do not expose secrets or unnecessary sensitive content.

### 14.3 Module verification before merge

**Thuto**
- Auth middleware tests.
- Membership/tenant resolution tests.
- Role/permission matrix tests.
- Shared error and request-ID tests.
- Cross-tenant repository tests.

**Olerato**
- File upload/download security tests.
- Extraction job lifecycle tests.
- Provenance and version tests.
- Policy state-machine and approval tests.
- Effective-date and concurrency tests.

**Fhulu**
- Ticket CRUD and filtering tests.
- Ownership/team visibility tests.
- Comment visibility tests.
- Attachment privacy tests.
- Ticket event/contract tests.

**Faith**
- SLA calendar and deadline tests.
- Policy-version selection tests.
- Escalation and idempotency tests.
- KPI formula and measurement provenance tests.
- Performance/report access tests.

**Wandile**
- AI schema and adapter tests.
- Provider failure/timeout tests.
- Evidence and groundedness evaluation.
- Prompt-injection and sensitive-data tests.
- Tenant-filtered retrieval tests.

### 14.4 Test evidence format

For every test run, record:

```text
Module:
Commit/branch:
Environment:
Command:
Suite:
Passed:
Failed:
Skipped:
Known limitations:
Date:
```

Never claim tests passed unless the command was actually run and the result inspected.

---

## 15. Integration Strategy

### 15.1 Integration order

Integrate in dependency order:

1. Thuto foundation: app bootstrap, tenant context, auth, shared errors and contracts.
2. Olerato organisation-facing document/policy integration against foundation.
3. Fhulu ticket module against foundation and shared file storage.
4. Faith SLA/performance modules against approved ticket and policy interfaces.
5. Wandile AI workflows against ticket, document and approved knowledge interfaces.
6. Reporting and audit cross-module verification.
7. Full E2E and security validation.

This order does not prevent parallel development. Owners may develop against approved interfaces and fixtures while upstream modules are being built.

### 15.2 Required end-to-end flows

**A. Document-to-approved-policy**
1. Authorised administrator uploads a document.
2. API validates and privately stores it.
3. Document/version metadata is persisted.
4. Extraction job is queued.
5. Worker extracts text and provenance.
6. AI proposes structured candidate rules with evidence and uncertainty.
7. Candidate rules are presented for administrator review.
8. Administrator approves, rejects or requests changes.
9. Approved version is activated according to effective dates.
10. Audit history records the full lifecycle.

**B. Ticket-to-AI recommendation**
1. User creates a ticket.
2. Ticket service validates tenant/requester and persists it.
3. AI analysis is queued.
4. AI classifies and summarises the ticket.
5. Priority is recommended using configured factors.
6. Retrieval returns only permitted evidence.
7. Resolution and routing suggestions are generated.
8. Execution and recommendations are recorded.
9. Agent reviews/edits/approves/rejects as permitted.
10. Decision and audit record are persisted.

**C. Ticket-to-SLA evaluation**
1. Ticket event or scheduled checkpoint starts evaluation.
2. SLA service loads tenant and ticket.
3. Applicable approved SLA version is resolved.
4. Calendar, timezone and priority are applied.
5. Response/resolution deadlines are calculated.
6. Reliable timestamps are compared to deadlines.
7. Evaluation and explanation are persisted.
8. Configured escalation workflow is triggered if thresholds are met.

**D. Performance assessment**
1. Assessment period and approved role assignment are loaded.
2. Configured source measurements are collected.
3. Measurements and provenance are validated.
4. Approved deterministic formulas/weights are applied.
5. Overall result and detail are persisted as a versioned snapshot.
6. Role-authorised dashboard/review access is enforced.

### 15.3 Integration failure handling

- Use timeouts and bounded retries.
- Use idempotency for retryable operations where appropriate.
- Make workers safe to retry.
- Use dead-letter or failed-job handling supported by the selected queue.
- Apply provider circuit-breaking where appropriate.
- Expose clear job status and safe error messages.
- Do not let a failed AI provider call corrupt the original ticket/document.
- Protect policy activation and approval transitions against concurrent updates.
- Preserve correlation IDs across API, queue, worker and provider calls.

---

## 16. API Documentation Requirements

Maintain an OpenAPI 3.x specification for `/api/v1`.

For every endpoint document:

- Summary and owning module.
- Authentication requirement.
- Permission requirement and tenant scope.
- Path, query and body parameters.
- Required and optional fields.
- Validation constraints.
- Success response schemas and status codes.
- Error codes and response schemas.
- Pagination behavior.
- Idempotency behavior where applicable.
- Asynchronous job behavior and status URL.
- File upload content type/limits where applicable.
- Example requests and responses.

The supplied OpenAPI excerpt is a draft, not a complete contract. Expand every endpoint before frontend integration is considered complete. Swagger UI or equivalent may be exposed in development; production access must follow the project's security policy.

---

## 17. AI Coding Agent Instructions

This section is mandatory for every AI coding agent working on the backend.

### 17.1 Before making changes

1. Read `BACKEND_IMPLEMENTATION.md` completely.
2. Inspect the existing repository structure, package manifests, scripts, dependencies, routes, models, tests and configuration.
3. Read the relevant project design documents and identify the requirements applicable to the assigned module.
4. Run or inspect existing tests/build status where practical.
5. Identify the assigned member, phase, module ownership and permitted files.
6. Identify upstream interfaces and unresolved decisions that affect the task.
7. If ownership or scope is unclear, stop and ask for clarification before editing.

### 17.2 Scope and ownership rules

1. Work only on the assigned phase or module.
2. Do not modify another team member's module without explicit permission.
3. Do not make unrelated refactors or rewrite existing architecture.
4. Do not alter shared middleware, contracts, global configuration or migrations owned by another member without review.
5. Do not add features unsupported by the project requirements.
6. Do not silently select a database, framework, identity provider, queue, storage vendor, LLM provider or business rule where the guide marks a decision unresolved.
7. Use approved interfaces and mocks when dependencies are not ready.

### 17.3 Implementation rules

1. Follow the architecture and folder conventions in this guide, adapted to existing repository conventions.
2. Reuse existing code and dependencies wherever appropriate.
3. Use TypeScript strict mode if TypeScript is used.
4. Validate all external input at the boundary.
5. Keep controllers thin and use application services for orchestration.
6. Keep domain logic independent of UI, HTTP and provider SDKs.
7. Use tenant-scoped repositories for all tenant-owned data.
8. Enforce authentication, permissions, ownership and tenant checks server-side.
9. Use consistent DTOs, naming, timestamps, errors and response envelopes.
10. Implement secure file handling and data minimisation.
11. Validate AI outputs and treat retrieved content as untrusted.
12. Implement idempotency, concurrency controls and safe retries where required.
13. Write clean, modular, maintainable code with clear responsibility boundaries.

### 17.4 Testing and documentation rules

1. Create or update tests for every implemented behavior.
2. Include negative tests for permission and tenant boundaries.
3. Run relevant unit, integration, type-check, lint and API contract tests.
4. Do not claim tests passed unless they were run.
5. Update OpenAPI documentation for new or changed endpoints.
6. Document new environment variables without exposing secrets.
7. Document migrations, worker/job behavior and operational requirements.
8. Preserve known limitations and unresolved decisions in the handover.

### 17.5 Required completion report

At the end of each task, the coding agent must report:

```text
Assigned member:
Assigned module/phase:
Task completed:
Implementation summary:
Files created:
Files modified:
APIs/services added or changed:
Database/schema/migration changes:
Tests added:
Commands executed and actual results:
Security/tenant-isolation checks:
Integration dependencies:
Outstanding issues:
Unresolved decisions:
Confirmation that no unauthorised module was modified:
```

An agent must not report a module as complete if its tests, documentation or required integration contract are missing.

---

## 18. Environment Configuration

Use a validated configuration module. The following names are illustrative placeholders; align them with the repository and approved providers.

```dotenv
NODE_ENV=development
PORT=3000
API_BASE_PATH=/api/v1

# Database: use only the approved primary database configuration.
DATABASE_URL=

# Identity provider/session configuration: names depend on the approved provider.
AUTH_ISSUER=
AUTH_AUDIENCE=
AUTH_PUBLIC_KEY=

# Private object storage: exact variables depend on the selected vendor.
OBJECT_STORAGE_ENDPOINT=
OBJECT_STORAGE_BUCKET=
OBJECT_STORAGE_ACCESS_KEY=
OBJECT_STORAGE_SECRET_KEY=

# Queue: exact variables depend on the selected technology.
QUEUE_CONNECTION=

# AI provider: keep credentials server-side.
LLM_PROVIDER=
LLM_API_KEY=
LLM_MODEL=
EMBEDDING_MODEL=

# Observability
LOG_LEVEL=info
```

Do not commit a populated `.env` file. `.env.example` must contain safe placeholders only. Validate required variables at startup and document which variables are conditional on enabled integrations.

---

## 19. Final Deployment Checklist

### Architecture and configuration
- [ ] Repository baseline and architecture decisions are approved.
- [ ] One primary database is selected and documented.
- [ ] Tenant isolation model is documented and tested.
- [ ] Identity provider and role/permission catalogue are approved.
- [ ] Object storage, queue, AI provider and vector search choices are approved where used.
- [ ] Environment configuration is validated at startup.
- [ ] Secrets are stored outside source control and client bundles.

### Database and storage
- [ ] Migrations/schema setup is reproducible.
- [ ] Indexes and tenant-consistency constraints are applied.
- [ ] Backup and restore procedure is documented and tested.
- [ ] Uploaded files are private and authorised.
- [ ] Retention/deletion settings are approved and configured.
- [ ] No unintended public storage access exists.

### API and security
- [ ] OpenAPI covers all implemented endpoints.
- [ ] Authentication and permission checks are enabled.
- [ ] Tenant isolation tests pass.
- [ ] Rate limits are configured for authentication, public intake and expensive AI operations.
- [ ] Error responses do not leak stack traces or secrets.
- [ ] Audit records cover material actions and approvals.
- [ ] CORS, TLS and deployment security settings are reviewed.

### Workers and AI
- [ ] Worker processes can start independently.
- [ ] Job retries and failure states are tested.
- [ ] Idempotency is implemented where needed.
- [ ] Provider timeouts and failure handling are tested.
- [ ] AI outputs are schema-validated and evidence-aware.
- [ ] Prompt-injection and cross-tenant retrieval tests pass.
- [ ] AI cannot activate policies or execute governed actions without approval.

### Business functionality
- [ ] Document ingestion and policy approval flow works.
- [ ] Ticket intake, search, comments and attachments work.
- [ ] SLA evaluation uses approved targets and calendars.
- [ ] Performance uses approved formulas and verified measurements.
- [ ] Reports enforce role and tenant scope.
- [ ] Required audit and history views work.

### Quality and handover
- [ ] Unit, integration, API contract, security and E2E tests have recorded results.
- [ ] Build, lint and type-check pass in the deployment pipeline.
- [ ] Health/readiness checks and structured logs work.
- [ ] Monitoring and operational alerts are configured.
- [ ] Deployment, rollback and incident/recovery notes are available.
- [ ] Known limitations and outstanding decisions are documented.
- [ ] Team ownership and support handover are complete.

---

## 20. Backend Definition of Done

The backend is complete only when all applicable items below are satisfied:

1. The implementation is consistent with the approved architecture and existing repository conventions.
2. All required backend modules are implemented: identity/tenant, organisations/teams, documents/policies, tickets, SLA, AI/knowledge, approvals/audit, performance/coaching and reporting.
3. Every tenant-owned data path enforces tenant scope and has negative security tests.
4. Authentication and server-side authorisation are implemented using the approved identity model.
5. API endpoints have validated DTOs, consistent response/error envelopes and OpenAPI documentation.
6. Document uploads and attachments use private storage and authorised access.
7. Policy versions follow the approved lifecycle; extracted candidates cannot be activated without required human approval.
8. SLA evaluation uses approved targets, calendars and policy versions and stores explainable history.
9. Ticket workflows support the documented intake, read, update, comment, attachment and AI integration requirements.
10. AI workflows are bounded, typed, provider-abstracted, evidence-aware, traceable and guarded by human review where required.
11. Performance calculations are deterministic, versioned and based on verified measurements and approved formulas.
12. Audit records exist for material changes, approvals, AI recommendations and overrides.
13. Background jobs are observable, retry-safe and protected against duplicate consequential effects.
14. Unit, integration, API contract, database, authentication, security, AI evaluation and E2E tests have been executed with results recorded.
15. No unresolved critical security or data-isolation defects remain.
16. Environment, migration, deployment, backup/restore and operational instructions are complete.
17. All five owners have supplied module handover reports and integration dependencies are resolved or explicitly accepted.
18. Known limitations and decisions deferred beyond the project scope are documented.

A feature is not Done merely because its route or UI call exists. Its validation, permissions, domain behavior, persistence, error handling, tests, documentation and integration must also be complete.

---

## 21. Source Documents and Traceability

This guide is derived from the project documents supplied for this task:

1. `AI-Architecture.md` — bounded AI components, document ingestion, retrieval, provider abstraction and AI governance.
2. `Architecture.md` — platform purpose, modular-monolith direction, logical architecture, tenant isolation and unresolved database decision.
3. `Component-Design.md` — component boundaries and component input/output contracts.
4. `Database-Design.md` — logical entities, relationships, tenant fields, indexes and outstanding database decisions.
5. `Data-Flow.md` — document/policy ingestion, ticket triage, SLA monitoring and data protection flows.
6. `HLD.md` — component responsibilities, deployment units, reliability and security boundaries.
7. `Implementation-Roadmap.md` — repository baseline, architecture approval and ordered implementation gates/phases.
8. `LLD.md` — TypeScript conventions, folder structure, tenant-scoped repository contract, policy state machine and AI result contracts.
9. `Policy-and-SLA-Engine.md` — policy lifecycle, structured rules, SLA configuration and evaluation.
10. `Security-and-Permissions.md` — role templates, authorisation, tenant isolation, file/AI security and audit/privacy.
11. `Testing-Strategy.md` — test layers and critical scenarios.
12. `UI-UX-Design.md` — user roles, backend-facing screens, evidence display and role-specific dashboard boundaries.
13. `API-Specification.md` — draft API catalogue, response/error examples, async triage, policy approval and performance calculation example.

### Traceability note

Where the source documents are incomplete or contradictory, this guide marks the issue as an approval decision rather than presenting an assumption as a confirmed requirement. The implementation team must preserve that distinction in code, pull requests and handover documentation.

---

**End of document.**
