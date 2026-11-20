# Ticket AI integration

The existing `TicketAiAnalysisService`, classifier, summarizer, execution runner,
provider-neutral interface and output validators are retained. LangGraph now orchestrates
classification and summarization with explicit review, invalid-output and failure routes.
Existing TypeScript output validators remain authoritative; Zod validates new graph/run
contracts and configurable document-extraction payloads.

## Integrated request flow

1. The shared application verifies the bearer token and resolves active stored tenant membership.
2. It derives team scope from server-side team memberships. Static development principals are disabled on this path.
3. The ticket adapter applies existing requester/team/administrator visibility before returning only the AI ticket projection.
4. LangGraph invokes the existing classifier and summarizer using their execution runners and provider adapters.
5. `JsonAiAnalysisRepository` validates and saves the combined analysis to `ai-analyses.json` using locked atomic JSON writes.
6. History reads re-check ticket access, so revoked membership/team access cannot read prior analyses.
7. A separate `ai-workflow-runs.json` records graph outcomes and safe execution metadata,
   including invalid/provider-failed runs. This is application history, not checkpoint storage.

Use `POST /api/v1/tickets/:ticketId/analyze` with `{}` and
`GET /api/v1/tickets/:ticketId/analyses`. Both require a bearer access token and
`X-Organisation-ID`. Analysis is synchronous and does not mutate ticket records.
The shared server defaults to port 3000. See the root README for Keycloak setup.

## Local demonstration

Set `APP_ENV=development`, `TICKET_AI_DEMO_ENABLED=true`,
`TICKET_AI_LIVE_ENABLED=false` and a JSON `TICKET_AI_CATEGORIES` array of objects
with `id`, `name` and optional `description` fields. Demo results are deterministic
keyword/extractive output with null confidence, mandatory review and `DEMO_ONLY`
warnings. This is not real-model inference.

## Live providers

Set `APP_ENV=development`, `TICKET_AI_LIVE_ENABLED=true`,
`TICKET_AI_DEMO_ENABLED=false`, categories and the task selectors
`TICKET_AI_CLASSIFICATION_PROVIDER` / `TICKET_AI_SUMMARIZATION_PROVIDER` to `groq`
or `inception`. Use the provider/model/token-limit/timeout/retry variables described
in `.env.example`. Credentials belong in the process environment, never Git.
Startup does not automatically load `.env`.

Inception transient failures use bounded retries/backoff before Groq fallback. Groq
credentials are required for fallback. The outer runner does not add another retry
loop. Structured outputs still pass the existing validators. Live mode sends ticket
title and description to external providers; it remains opt-in and development-only.
Provider tests mock HTTP responses and do not verify live model quality/availability.

## Persistence and unfinished work

The integrated application injects durable history into both runtime modes. Standalone
`createTicketApp` and runtime factories retain in-memory defaults for existing focused
tests/isolated demos. Do not use those standalone defaults as the production entry point.

The AI-owned `ProviderDocumentExtractionAdapter` now implements the existing document
batch port, validates configured payload schemas and exact quotations, and requires human
review. Olerato's default processing path still uses the provisional adapter until she
approves schemas and wiring; TXT/PDF/DOCX text conversion is separate from model extraction.
Mistral embeddings remain an adapter, without a persistent semantic index. Real historical
sources, background jobs, durable aggregate triage/reviewer outcomes and broader model
evaluation remain further work. No checkpoint persistence is enabled.

`runtime.createTriageService(capabilities)` composes the core graph with existing priority,
retrieval/resolution and optional routing/SLA sources. Each run reloads authorized upstream
data. Missing sources are explicitly unavailable, and upstream failures remain visible.
Routing recommends from approved eligible-team rules; SLA insight consumes Faith's verified
evaluation and never calculates deadlines with an LLM. This factory is an internal integration
entry point; the existing `/analyze` endpoint continues to expose core classification/summary.

See [the LangGraph handover](../../../../docs/architecture/Wandile-AI-LangGraph-Handover.md)
for ports, ownership, execution flow, changed files, verification and remaining dependencies.
Keycloak, roles and shared authentication configuration remain Thuto's responsibility.

Test the AI alone with synthetic data and existing provider credentials:

```powershell
node --env-file=.env --import tsx scripts/test-live-ai-workflow.ts
```

This opt-in test invokes real providers for graph analysis, priority, cited resolution and
document extraction, using fixture routing/knowledge and isolated temporary JSON history.
It does not configure Keycloak/Jira or activate any policy; provider usage may apply.

Lexical evidence retrieval and cited resolution recommendations are now available through
the API. See [resolution-recommendations.md](resolution-recommendations.md) for connected
sources, permission boundaries, endpoints, tests and the live synthetic smoke command.
The default source reads active approved policy payloads for administrators; historical
resolutions and staff-readable knowledge still require agreed source/access adapters.

## Draft priority recommendation component

The independent priority recommendation contract and tests are documented in
[priority-recommendations.md](priority-recommendations.md). It reuses the runner and
provider boundary, validates ticket citations and calculates P1-P4 deterministically.
It is not enabled on existing analysis endpoints and does not change tickets.

## Test live AI without setting up API login

From `backend/`:

```powershell
node --env-file=.env --import tsx scripts/test-live-ai.ts
```

This explicit development smoke test reads provider credentials from the environment,
supplies synthetic ticket/category data, and calls the configured live classification
and summary providers directly through the existing service/runner. It does not start
an unauthenticated API, read real tickets, write application records or require Keycloak.
It overrides demo/live/development flags only in its own process; it does not configure
the regular server or replace tenant membership setup. Calls may incur provider usage.
Request timeouts/retries are capped for this test. Output contains synthetic results and
provider execution metadata, never credentials.

A real Inception mercury-3 classification and summary smoke test passed on 2026-11-19.
The initial request reached the provider but failed output validation; prompts were
corrected to enumerate their exact required JSON keys/types. Validators were preserved.
This verifies connectivity and the output contract for one example, not general model
accuracy, Groq failover or priority inference. The returned summary unnecessarily asked
for further error-message confirmation despite supplied text, so semantic quality still
needs evaluation. The default backend remains protected by Keycloak/membership checks.
