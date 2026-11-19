# Evidence retrieval and resolution recommendations

This first increment retrieves permitted evidence using keyword overlap and asks the
existing structured-generation runner for cited resolution guidance. It introduces
no dependencies, LangGraph graph, embeddings index, checkpoints or ticket mutations.

## Execution flow

1. The API authenticates the caller and checks `tickets.resolution.review`.
2. The existing ticket source authorizes ticket access, including tenant/team scope.
3. The knowledge source applies its document access rules. Retrieval filters tenant,
   approval, active status and effective dates before ranking text.
4. Text is split into overlapping passages (800 characters, stride 600). Up to five
   matching passages are returned with source/version IDs, offsets and stable hashes.
5. Without evidence, return `insufficient_evidence`, empty steps and `execution: null`.
   No provider call is made.
6. Otherwise the existing provider-neutral runner executes `ticket_resolution` using
   the runtime's classification provider configuration (the existing `priorityRunner`).
7. Strict validation requires every suggested step to cite a permitted passage and
   quote an exact substring. Unknown fields/sources/quotations are rejected.
8. Return guidance, evidence, ticket snapshot hash and execution metadata for human review.

Ticket and evidence text are untrusted prompt data. Neither supplies permissions or
execution commands. The service does not assign, activate policy, close tickets or
persist recommendations. Citation matching proves quotation provenance, not that a
suggestion is correct or adequately supported; human review and quality evaluation remain necessary.

## API

All endpoints use the existing authenticated organisation context, ticket visibility
and `tickets.resolution.review` permission; responses use `Cache-Control: no-store`.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/v1/tickets/:ticketId/evidence` | Ranked permitted passages |
| GET | `/api/v1/tickets/:ticketId/similar` | Historical passages only; current ticket excluded |
| POST | `/api/v1/tickets/:ticketId/recommend-resolution` | Recommendation or insufficient evidence |

POST accepts an empty JSON object `{}`. Client-supplied sources, tenant IDs, roles or
instructions are rejected. Retrieval responses describe method `lexical` and
`persistedIndex: false`. Recommendations always include `requiresHumanReview: true`.
Disabled AI with no injected resolution runner returns 503 `RESOLUTION_NOT_CONFIGURED`.
Existing safe AI error handling maps provider/validation failures without exposing raw output.

## Connected sources and integration requirements

The default `ApprovedPolicyKnowledgeSource` reads structured policy-version payloads
through the existing repository. Versions must be active, effective and have a matching
approved decision. Current policy visibility is administrator-only, so this adapter
returns no policy content to other roles. Staff access needs an agreed document access
design; granting ticket permission alone does not grant policy visibility.

Repository reference Markdown and uploaded original files are not automatically
ingested or approved. This does not add PDF/OCR extraction. SLA rules can explain service
obligations but do not necessarily establish a technical resolution.

`AuthorizedKnowledgeSource` supports approved knowledge articles and verified historical
resolutions through trusted dependency injection. The default adapter supplies neither:
`/similar` currently returns an empty list. Do not treat arbitrary closed ticket text or
customer comments as verified guidance. A real history adapter needs team agreement on
verified-resolution fields, document/ticket access and sensitive-data handling first.

This is a small lexical RAG pipeline: retrieve text, augment the prompt, generate guidance.
It stores no embeddings and has no semantic/vector search or persistent index. Context
is bounded per record; the policy adapter scans current collections. Larger datasets
need pagination, corpus limits, evaluation and an approved storage/index design.

## Validation and live smoke test

`tests/retrieval-resolution.test.ts` covers source/tenant filtering, approval and dates,
chunk offsets, stable IDs, history isolation, citations, authorization, no-evidence
provider skipping and safe errors. `tests/integrated-app.test.ts` checks API permissions,
tenant isolation, request-field rejection, citation output and unchanged ticket data.
The full suite passed: 140 tests, no failures. Typecheck and build passed.

From `backend/`, with existing live-provider environment settings:

```powershell
node --env-file=.env --import tsx scripts/test-live-resolution.ts
```

This explicitly calls the configured external provider with a synthetic ticket and
synthetic approved runbook. It does not read real tickets, approve actual policy, change
environment files, bypass API authorization or write application records. Provider usage
may apply. A live Inception mercury-3 test on 2026-11-19 returned two validated cited
steps; another completed call declined to recommend. This verifies one integration
example, not model reliability or deployment readiness.

Files for this increment: `ai/contracts.ts`, `ai/local-demo-runtime.ts`,
`ai/resolution-recommendation.service.ts`, `ai/README.md`, this document,
`knowledge/retrieval.ts`, `knowledge/approved-policy-source.ts`, `tickets/api.ts`,
`tests/retrieval-resolution.test.ts`, `tests/integrated-app.test.ts`,
`scripts/test-live-resolution.ts` and `docs/api/API-Specification.md`.

Remaining work: approved staff knowledge visibility, real knowledge/history adapters,
evaluation of relevance and citation entailment, source refresh/revalidation for saved
suggestions if persistence is later added, and storage/index approval before vector RAG.
