# Phase 10 — Testing and verification

**Status:** Automated synthetic verification is in place; live provider quality and browser E2E are not established. Updated 24 November 2026.

## Test approach

The backend uses Node's built-in `node:test` and assertions. Jest and Supertest are not installed, and replacing the existing framework would add little value for the current route and service tests. API integration tests exercise the Express app through its in-process request harness. The frontend uses Node's built-in test runner for API-client and role-navigation tests; no DOM test library is installed.

The focused frontend suite is run with `npm test` from `frontend/`. The backend's compiled tests were run in-process because the sandbox blocks the normal Node test runner's child-process workers with `spawn EPERM`. Tests were compiled using the installed TypeScript compiler, then imported in one Node process. Read-only fixture copies were placed in the generated `backend/dist` tree for compiled tests that resolve files relative to `import.meta.url`; temporary documentation fixtures were removed after the run.

## Verified coverage

- **Backend unit/business logic:** AI classification and summary validation, output retry/failure behavior, priority matrices and evidence, retrieval, resolution citations and review revisions, routing, SLA calculations/evaluation, approval decisions, document processing, identity, and tenant-aware persistence.
- **Backend integration:** API validation and error responses, authentication and role/tenant boundaries, ticket creation and updates, AI triage/review, audit events, documents, policies, SLA APIs, and integrated OpenAPI coverage.
- **Frontend:** token-required API calls, token refresh, organisation scoping, no-store behavior, propagation of backend error code/request ID/validation fields, attachment upload/download behavior, and role-aware landing/navigation.
- **Ticket-to-triage-to-review:** backend integration tests exercise synthetic ticket/API/AI workflow and reviewer approval paths. This verifies server behavior, not a browser journey.

The latest compiled backend run executed **270 tests across 21 suites; 270 passed, 0 failed**. The standard test runner could not create child processes in this sandbox, so this count came from the in-process execution method. Backend source type-check, full source-and-test TypeScript check (`tsc --noEmit --project tsconfig.json`), and production build passed. Frontend `npm test` passed **5/5**, `npm run typecheck` passed, and `npm run lint` passed. `git diff --check` passed.

## Synthetic AI evaluation

Run `npm run evaluate:ai:synthetic` from `backend/` to evaluate the checked-in `data/evaluation/triage-v1.json` fixture against the deterministic local demo implementation. This run made no provider calls, used no customer tickets, and wrote its operation record only to a temporary directory that is removed afterward.

Observed result on 6 synthetic cases:

| Measure | Result | Interpretation |
|---|---:|---|
| Classification accuracy | 3/6 (50%) | Local keyword heuristic only; not a live model score |
| Case completion | 6/6 (100%) | All synthetic evaluation calls completed |
| First-pass completion | 6/6 (100%) | No validation retry was needed |
| Required summary fact coverage | 4/4 (100%) | Lexical substring proxy, not semantic summary quality |
| Prohibited phrase hits | 0 | Checked prohibited phrases were absent in this fixture |
| Ambiguous case | No category assigned | Human review is required by the demo classifier |

The category result shows the local heuristic is not a production classifier and does not meet an accuracy claim. These values describe only this six-case fixture and deterministic demo. They are not provider quality scores, confidence calibration, or evidence about real tickets. The evaluation harness marks semantic groundedness as requiring human review.

Priority, retrieval relevance, resolution evidence, routing quality, and approval behavior have assertion-based synthetic tests, but there are no independently labelled evaluation sets or defensible numeric scores for those dimensions. SLA tests verify configured policy calculations and state transitions; they do not establish tenant-approved production targets/calendars.

## Unverified items and limitations

- Playwright, browser binaries, DOM testing libraries, and isolated browser test identities are not available in the frontend project/environment. No rendered-browser E2E suite, Keycloak login journey, role-by-role browser navigation, or browser attachment download was run.
- No live LLM/provider evaluation was run in this phase. The repository has live verification scripts, but provider variability and external credentials require a separately scheduled synthetic-only run. No provider response text or credentials were captured here.
- The current backend test run is synthetic/in-process. It does not prove live Atlas behavior, deployment topology, external Keycloak availability, production file scanning/storage, or tenant data correctness.
- Jest/Supertest and Playwright are not added as unused dependencies. They can be introduced when the project selects and provisions a browser test environment and test identities.

## Phase 10 completion boundary

Unit, service, API integration, validation, permission, SLA, AI workflow, audit, and frontend API/navigation test coverage is documented and runnable using repository dependencies. Automated browser E2E and broad labelled AI quality evaluation remain open acceptance work; therefore Phase 10 is not fully verified for production release.
