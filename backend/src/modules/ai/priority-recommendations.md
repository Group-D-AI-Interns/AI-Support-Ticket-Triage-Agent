# Draft priority recommendations

## Flow and dependencies

`PriorityRecommendationService.recommend(trustedTenant, ticketId)` calls an injected
`AuthorizedTicketAnalysisSource` before invoking `PriorityRecommender`. The source
must enforce current ownership/team/tenant access just as the ticket analysis source
does. The service checks tenant, ticket ID and projection shape before any model call.
A missing/inaccessible ticket or mismatched projection fails before the provider runs.
This API expects trusted server-created context, never roles copied from a request body.

The recommender receives an existing `AiExecutionRunner`, a validated draft candidate
and an explicit minimum-confidence configuration. It invokes the new
`ticket_priority_factors` task through the existing provider-neutral interface.
No SDK, dependency, retry implementation or graph is introduced. Runner timeouts,
provider error normalisation, output validation and metadata logging remain in use.
The existing classifier/summarizer service and stored analysis shape remain unchanged.

## Model response contract

The response has exactly `impact`, `urgency`, `missingInformation`, `warnings`.
Each factor has exactly:

- `value`: `high`, `medium`, `low`, or null when unknown.
- `reason`: nonempty explanation.
- `confidence`: null or a finite number from 0 through 1.
- `evidence`: ticket citations. A non-null factor requires at least one citation.

Each citation has `ticketId`, `field` (`title` or `description`), `start`, `end`,
`excerpt`. Offsets use JavaScript UTF-16 positions with exclusive end. The validator
requires the same ticket ID, integer in-range positions and an exact nonempty source
slice. Other-ticket IDs, unsupported fields, fabricated quotes, extra properties,
priority selection and model-provided permission/review overrides fail validation.

Exact quotes prove the text exists, not that the model interpreted it correctly.
The test fixtures verify the contract, not real-model groundedness or accuracy.
A ticket can itself contain false facts or prompt injection; quoted text is not a
trusted instruction. A real-model evaluation set and authorised human review remain
necessary. Ticket text is sent as data separately from system instructions, and the
provider receives only ID/title/description, not roles, organisation data or credentials.

## Deterministic result

The matrix preview calculates priority; the model cannot return P1/P2/P3/P4 directly.
Unknown factors, null confidence, confidence below the injected threshold or explicitly
reported missing information produce `insufficient_information` and null priority.
No low-priority fallback is invented. There is no default confidence threshold;
tests use a synthetic threshold, which is not a calibrated organisational policy.

Every successful output includes factor assessments and ticket evidence, draft policy
ID/version/hash/section, missing information, warnings, execution ID/provider/model/
attempts/timings, and `requiresHumanReview: true`. The policy remains `draft`, even
for well-supported inputs. Returned ticket evidence refers to the source snapshot;
before persistence/API integration, agree a ticket revision/checksum contract to detect
recommendations made stale by later ticket edits.

## Construction example (inside an authorised application use case)

```ts
const recommender = new PriorityRecommender(existingRunner, draftCandidate, reviewedThreshold);
const service = new PriorityRecommendationService(authorisedTicketSource, recommender);
const recommendation = await service.recommend(trustedTenant, ticketId);
```

The caller supplies the draft explicitly. This module does not load reference files,
activate policies, save data, assign teams, close tickets or change internal priority.
It does not automatically map P1-P4 to existing free-form or Jira priority labels.
The local heuristic demo now returns unknown factors and explicit DEMO_ONLY warnings;
`DeterministicFakeProvider` can supply task-specific fixtures for independent tests.

## Handover

Assigned owner: Wandile. Scope: AI module only; no shared package files or other
members' implementation modules changed. No existing API endpoint was added/changed.
No JSON record schema, database migration, environment variable or active policy changed.

Created:
- `priority-contracts.ts`
- `components/priority-recommender.ts`
- `priority-recommendation.service.ts`
- `priority-recommendations.md`
- `tests/priority-recommendation.test.ts` (under backend)

Modified: `contracts.ts` adds the task identifier; `local-demo-runtime.ts` rejects
unsupported tasks explicitly; `README.md` links this guide. All pre-existing local
work is preserved. No external provider requests or secret reads were performed.

Validation: `npm test` passed 122/122 including 15 new cases; `npm run typecheck`,
`npm run build` and `git diff --check` passed. Tests cover all nine matrix results,
missing/null/low-confidence inputs, forged evidence, permission fields, cross-tenant
projection checks, ticket immutability, prompt/data separation and timeout/safe errors.
Existing provider retry/fallback tests continue to pass.

Remaining integration: approved tenant policy selection and effective/version checks,
reviewed confidence settings, real-model factor/evidence evaluation, ticket revision
binding, production review/persistence contracts with Fhulu and Thuto. Do not expose the
source reference draft as an active tenant policy. Draft SLA/performance artifacts and
LangGraph remain outside this implementation.

## HTTP preview integration

The service is now exposed at `POST /api/v1/tickets/:ticketId/recommend-priority`.
It accepts `{}` only and requires `tickets.ai.review` plus ticket visibility. All
response fields remain draft/review-only. There is no priority recommendation history
store or automatic mutation. Existing analysis records and endpoints remain unchanged.

Set `APP_ENV=development`, `TICKET_PRIORITY_PREVIEW_ENABLED=true` and explicitly
configure `TICKET_PRIORITY_MIN_CONFIDENCE` alongside the existing AI runtime. The
server verifies the reference source hash before enabling the draft. Live mode uses
the existing classification provider/runner. The demo only returns unknown factors,
missing information and a DEMO_ONLY warning. It does not fabricate a priority.

The isolated offline launcher explicitly enables preview with a synthetic threshold
for demonstrations. Run `scripts/explore-demo.ps1` against the restarted demo to call
it. Real-model inference quality and active tenant policy resolution remain pending.

API changes: `modules/tickets/api.ts`; runner exposure: `live-ticket-ai-runtime.ts`
and `local-demo-runtime.ts`; server-only config: `priority-preview-config.ts`;
demonstration: `scripts/run-local-demo.ts` and `scripts/explore-demo.ps1`;
environment reference: `.env.example`; contract: `docs/api/API-Specification.md`.
`tests/integrated-app.test.ts` covers actual HTTP draft responses, ticket/analysis
immutability, cross-tenant/team/role denial, rejected body overrides, malformed evidence,
provider timeouts, disabled configuration and honest demo missing-information output.

HTTP integration verification: `npm test` passed 127/127, including five new API/config
cases; typecheck/build/diff checks passed. The offline demo was restarted and the
actual POST preview returned 200 with insufficient_information, null priority and
mandatory review. The updated PowerShell helper also passed against that server.
A successful P1 response was verified over HTTP using an injected deterministic
provider with exact ticket citations. No authenticated live provider request was made.
