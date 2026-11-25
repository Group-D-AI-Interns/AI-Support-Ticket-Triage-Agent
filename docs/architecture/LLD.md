# Low-Level Design

**Status:** Repository-aligned design reference, reviewed 23 November 2026. This describes existing boundaries and constraints; it does not prescribe a restructuring project.

## Backend layout

```text
backend/src/
  main.ts                         process entry and shutdown
  server.ts                       environment, persistence, and server composition
  integrated-app.ts                shared foundation + Express listener
  app.ts                           foundation HTTP dispatcher
  config/                          environment and logging
  shared/                           auth, tenant, validation, errors, request context
  infrastructure/
    auth/                           Keycloak integration
    persistence/json/               isolated test/demo adapter and compatibility port
    persistence/mongodb/             MongoDB database, collection, ticket/workflow adapters
    llm/                             structured generation provider adapters
    embeddings/                      embedding provider adapter
  modules/
    identity/ organisations/ teams/  foundation services and repositories
    tickets/                         Express API, domain, workflow and read services
    documents/                       lifecycle, extraction, storage and jobs
    policies/ sla/                   policy lifecycle and SLA evaluation
    ai/ knowledge/ reporting/         recommendations, evidence, and reports
```

This layout is not uniformly split into route/controller/service/repository folders. In particular, `modules/tickets/api.ts` is a large route-composition file. Preserve the existing boundaries when making focused changes; do not claim that each module is independently deployable.

## Request and authorization path

1. Shared request context assigns or propagates a request ID and safe structured logging metadata.
2. Foundation endpoints are dispatched in `app.ts`; ticket and domain endpoint prefixes are delegated to the Express application.
3. Keycloak authentication verifies the bearer token. The backend resolves the matching active local user and active organisation membership.
4. Permission policy derives allowed operations from backend membership roles. Tenant context is passed into protected repository/service calls.
5. Boundary validation rejects malformed or unknown inputs where specified. Stable API errors do not disclose stack traces or provider secrets.

## Persistence contracts

- Application code uses persistence ports/adapters selected during server composition.
- Local/test mode may use JSON file persistence. Production configuration selects MongoDB and validates required settings.
- MongoDB collection names are prefixed `app_`; IDs are string-based to preserve existing application identifiers.
- Mongo operations use tenant-scoped query/mutation methods where implemented, with transaction session reuse for multi-record work. Compatibility snapshot operations still exist; broad list paths and free-text ticket search remain optimization gaps.
- Do not treat a schema/index declaration or unit test as proof of live Atlas operation. Atlas indexes, transactions, migration, backup, restore, and query sizing require environment-backed verification.
- File bytes are not migrated by the JSON record migration. Local file storage remains a separate production readiness gap.

## AI and document contracts

AI provider adapters return structured content that is validated against task-specific schemas before persistence/use. Preserve execution identifiers, provenance/evidence and uncertainty metadata. Invalid provider responses fail safely and must not mutate the source ticket or activate a policy. Document extraction uses converted text and document/version context; extraction results remain candidates subject to review, not automatic policy activation.

AI workflow and SLA polling workers currently run within the backend process. Extraction jobs use the configured queue abstraction, whose current in-memory implementation is not a cross-process durable queue. Do not present these as separately deployable workers.

## API contract and verification

The integrated API contract is published at `/api/v1/openapi.json`. The legacy AI contract remains separate. Route-parity tests cover registered Express routes; the foundation dispatcher and exhaustive request/response schema conformance require separate verification. The backend test runner is Node's built-in test runner. Browser E2E coverage is not established by backend HTTP tests.

## Explicit non-decisions

This LLD does not choose a queue, hosting platform, private object store, malware scanner, monitoring vendor, retention schedule, rate limit, tenant SLA target/calendar, or new AI provider. Each requires a specified requirement or owner decision before implementation.
