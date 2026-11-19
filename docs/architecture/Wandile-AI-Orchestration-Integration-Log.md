# Wandile AI Orchestration Integration Log

## Entry 001 — Local ticket analysis flow

### Goal

Connect the ticket API to Wandile's existing classification and summarization
orchestrator so the complete flow can be exercised before selecting an
approved external LLM provider.

### Decisions and limits

- The new API integration uses the existing tenant-scoped ticket read service
  and ticket requester/team/administrator access rules before analysis.
- Analysis categories come from `TICKET_AI_CATEGORIES`; clients cannot supply
  or override the allowed category list.
- The provider is an opt-in local deterministic keyword/extractive demo. It
  makes no network calls, always returns null confidence and requires human
  review. Its warnings identify results as demo-only.
- Demo mode is disabled by default and may be enabled from the environment only
  when `APP_ENV=development`.
- Analysis history is tenant-scoped in process memory and is lost on restart.
  No new JSON persistence implementation or dependency was added.
- Analysis does not modify the source ticket. The Express API still uses its
  development bearer principal; the separate Keycloak server is not wired to
  this route.

### Files created

- `backend/src/modules/ai/local-demo-runtime.ts` — local provider, environment
  validation, safe execution logging, and tenant-scoped in-memory history.
- `backend/tests/ticket-ai-api-integration.test.ts` — API-level success,
  ticket immutability, authentication, requester/tenant isolation, and
  development-only configuration tests.
- `docs/architecture/Wandile-AI-Orchestration-Integration-Log.md` — this
  implementation record.

### Files modified

- `backend/src/modules/tickets/api.ts` — composes the authorized ticket source
  and exposes `POST /api/v1/tickets/:ticketId/analyze` and
  `GET /api/v1/tickets/:ticketId/analyses`.
- `backend/src/modules/ai/ticket-ai-analysis.service.ts` — shares authorized
  ticket validation and provides tenant-scoped analysis history reads.
- `backend/src/modules/ai/ports.ts` — adds the history query to the analysis
  repository boundary.
- `backend/src/modules/ai/components/ticket-classifier.ts` — exports category
  validation for demo configuration checks.
- `backend/tests/ticket-ai-phase1.test.ts` — updates the test repository and
  verifies saved analyses can be listed.
- `backend/src/modules/ai/README.md` — documents setup, route behavior, and
  demo limitations.
- `docs/api/API-Specification.md` — replaces the unimplemented asynchronous
  example with the current synchronous demo contract.
- `backend/.env.example` — removes the stale claim that the separate ticket app
  is Python and clarifies that this file does not configure the Express app.

### Validation

- `npm test --prefix backend` — passed, **58/58**.
- `npm run typecheck --prefix backend` — passed.
- `npm run build --prefix backend` — passed.
- `git diff --check` — passed.

### Remaining integration work

This is an orchestration demonstration, not production AI. A real provider and
model require team approval. Production readiness also requires approved
authentication for the Express app, durable tenant-scoped AI analysis
persistence, operational controls, and evaluation of real model quality.
Similarity retrieval, knowledge integration, priority/routing/resolution
recommendations, and background jobs are not implemented by this entry.

## Entry 002 — Provider configuration placeholders

### Provider direction

- Groq and Inception are selected LLM providers; Mistral is selected for
  embeddings.
- The user requested runtime failover to Groq when Inception fails.
- The user supplied model defaults and retry/backoff/timeout settings for the
  example environment file.

### File change record

- **Modified:** `backend/.env.example` to contain only the requested Groq,
  Inception, Mistral, and LLM timeout/retry variables in its AI section.
  Existing shared-server settings were retained. Provider keys are blank and
  the requested model defaults are included.

### Compatibility and credential notes

- The current local demo still reads `TICKET_AI_DEMO_ENABLED` and
  `TICKET_AI_CATEGORIES`; the simplified example does not configure those
  values. The demo remains disabled by default; live mode uses the separate
  `TICKET_AI_LIVE_ENABLED` switch.
- The example file previously contained non-empty provider credentials. They
  are now blank in the AI section; revoke and replace those credentials if
  they were real.

### Provider lifecycle warning

- On 2026-11-19, Inception's official documentation stated that the Mercury API
  would remain available through 2026-12-28 and then be discontinued. The
  adapter is short-term; switch task routing to Groq before that date.

## Entry 003 — Live providers, failover, and Mistral embeddings

### Files created

- `backend/src/infrastructure/llm/openai-compatible-provider.ts` — bounded
  HTTP client for Groq and Inception JSON chat completions with normalized,
  redacted provider errors.
- `backend/src/infrastructure/llm/inception-fallback-provider.ts` — retries
  Inception transient errors/timeouts with configured capped exponential
  backoff, then calls Groq as fallback.
- `backend/src/infrastructure/embeddings/embedding-provider.ts` — provider-
  neutral embedding interface.
- `backend/src/infrastructure/embeddings/mistral-embedding-provider.ts` —
  Mistral batch embedding client with response/order/dimension validation.
- `backend/src/modules/ai/live-ticket-ai-runtime.ts` — live-mode config,
  per-task provider selection, runner composition, and execution-time limits.
- `backend/tests/llm-provider-adapters.test.ts` — mock HTTP coverage for
  provider requests, error normalization, timeouts, retries/failover,
  embeddings, config gating, and end-to-end orchestration.

### Files modified

- `backend/.env.example` — added live-mode flags, category and per-task provider
  selectors while preserving existing shared API settings and blank secrets.
- `backend/src/infrastructure/llm/structured-generation-provider.ts` and
  `backend/src/modules/ai/ai-execution-runner.ts` — carry attempt counts from
  retries/fallback into execution metadata.
- `backend/src/modules/tickets/api.ts` — composes live or demo mode while
  rejecting simultaneous enablement.
- `backend/src/modules/ai/local-demo-runtime.ts` — shares category parsing and
  validation.
- `backend/src/modules/ai/README.md` and `docs/api/API-Specification.md` —
  document live-mode configuration, external data flow, fallback, and limits.

### Safety and verification

- Live LLM mode requires explicit `APP_ENV=development` and
  `TICKET_AI_LIVE_ENABLED=true`; it is off by default.
- Ticket data is sent to the selected external LLM only in live mode. Logs
  contain execution metadata, not request text or credentials.
- Both providers' structured responses still pass the existing runtime output
  validators. Analysis does not mutate ticket records.
- Provider tests use fake credentials and mock HTTP responses. No authenticated
  live provider call was made.
- Mistral embedding support is implemented as an adapter but is not yet
  connected to a knowledge/similarity retrieval workflow.
- Final validation: `npm test --prefix backend` passed **66/66**;
  `npm run typecheck --prefix backend` passed; `npm run build --prefix backend`
  passed; `git diff --check` passed.
- The current shell has no Groq, Inception, or Mistral API keys configured, so
  authenticated provider calls could not be attempted.
