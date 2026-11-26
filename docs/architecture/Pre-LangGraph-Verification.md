# Verification before LangGraph

Verified on 2026-11-19 against the merged TypeScript backend. The repository has an API
backend and no frontend application. No LangGraph or other dependencies were installed;
shared package/configuration files were not changed.

## Results

| Check | Result and scope |
| --- | --- |
| Full regression suite | 154 tests passed, 0 failed, 10 suites |
| Typecheck and build | Passed; verification script also typechecked separately |
| Normal startup | Passed after the approved local environment update |
| Actual running server | Started with `npm start`; `http://127.0.0.1:3000/health/ready` returned `ready` |
| Authentication guards | Missing bearer token returns 401; regression tests cover tenant/team/role isolation with synthetic signed identities |
| Keycloak and PostgreSQL | Both Docker containers healthy; live realm discovery and JWKS returned successfully |
| Real-user API access | Not verified: configured storage has zero active users, organisations and memberships |
| Groq live classification and summary | Passed with synthetic input, using configured `openai/gpt-oss-120b` |
| Inception live HTTP analysis | Passed with synthetic input, using configured `mercury-3`; history persisted in isolated test storage |
| Live HTTP priority preview | Passed strict validation after citation fix; final example returned `insufficient_information`, null priority and mandatory review |
| Live HTTP resolution | Passed citation validation; final example returned two cited steps with `insufficient_evidence` and mandatory review |
| Live Mistral adapter | Returned a valid embedding for synthetic text; vector discarded, no index created |
| PDF/DOCX conversion | Valid generated documents successfully converted; page/paragraph provenance checked |
| HTTP PDF/DOCX processing | Multipart upload and local extraction passed; extracted `targetHours: 2` using `local-provisional` |
| Forced provider failover | Covered by mocked tests; not forced against live providers |
| Candidate-review routes | Source audit confirms standalone routes are absent from main-server composition; main-server probe returned 404 |

Live calls used only synthetic ticket/runbook data. No real customer documents were sent.
Synthetic identity tokens used the existing verifier with locally supplied signing keys;
they do not prove a real user's Keycloak login or local membership setup. Synthetic
storage was removed after verification. Existing application data was not modified.

These checks establish integration and output validation for a few examples, not model
accuracy. A successful provider call can legitimately return missing information.
The final live priority example did not establish a numeric priority; resolution still
identified missing information despite providing cited steps. Citation matching proves
quotation provenance, not semantic correctness of a recommendation.

## Failure found and fixed

The first live HTTP priority request returned 502 `INVALID_OUTPUT`. The provider was
estimating character positions incorrectly. `PriorityRecommender` now supplies bounded
sentence evidence options with exact UTF-16 offsets and instructs the model to copy them.
Existing validation, output contracts, provider abstraction, runner, deterministic matrix
and mandatory human review remain in place. Fabricated citations still fail validation.
Regression coverage includes Unicode, repeated sentences and surrounding whitespace.

Local `.env` changes were explicitly approved by Wandile: `APP_ENV=development` and
the development category list `ACCOUNT_ACCESS` / `BILLING`. Keys were preserved.
The file is ignored by Git. This does not enable production AI or approve a tenant policy.

## Files changed

- `backend/src/modules/ai/components/priority-recommender.ts`: precomputed evidence options and prompt clarification.
- `backend/tests/priority-recommendation.test.ts`: citation-option regression coverage.
- `backend/tests/document-text-converter.test.ts`: successful PDF/DOCX conversion and corrected invalid-DOCX test name.
- `backend/tests/fixtures/document-fixtures.ts`: valid in-memory PDF/DOCX fixtures without extra dependencies.
- `backend/scripts/verify-project.ts`: repeatable startup/discovery/live HTTP verification with isolated storage.
- `backend/src/modules/ai/priority-recommendations.md`: link to the current verification and citation change.
- This verification report.
- Ignored `backend/.env`: approved local settings only.

## Reproduce

From `backend/`:

```powershell
npm run typecheck
npm run build
npm test
node --env-file=.env --import tsx scripts/verify-project.ts
node --env-file=.env --import tsx scripts/verify-project.ts --live
```

Without `--live`, the script checks startup, public health, missing-token rejection,
active identity record counts and live Keycloak discovery/JWKS. With `--live`, it also
makes provider calls (usage may apply) and tests the main HTTP API with synthetic signed
identity, records and evidence. The priority draft and synthetic runbook are injected
only into the isolated verifier; regular server feature flags/knowledge access stay unchanged.
The script reports known gaps separately; exit 0 means executed probes passed, not that
all application capabilities or real-user onboarding are complete.

Ignored local evidence logs: `backend/.local-data/pre-langgraph-tests.log`,
`pre-langgraph-runtime.log` and `pre-langgraph-startup.log`.

## LangGraph decision and remaining work

The existing classifier, summarizer, provider port and runner are suitable for a small
independently tested orchestration graph. Ticket authorization must remain outside its
entry point. Keep the graph limited to classification, summarization and explicit routing
for insufficient/invalid output; preserve existing service contracts and tests.

`@langchain/langgraph` is not installed. Dependency/peer-version selection and shared
package changes require team approval before installation. No checkpoint storage design
has been approved, so no checkpoint persistence should be introduced.

Separate outstanding application work:

1. Implement a real provider-backed document `ExtractionAdapter` and its agreed rule schema.
2. Integrate candidate review through the main authentication/authorization flow, preserving
   the human approval boundary. Do not mount the static development principal as production auth.
3. Bootstrap actual user, organisation and membership records and verify real token access.
4. Connect approved staff knowledge and verified historical-resolution sources. A working
   Mistral adapter is not a configured historical-ticket RAG index.
5. Evaluate classification quality, priority factors, retrieval relevance and citation entailment.

These gaps prevent declaring the entire application complete. They can remain outside
the initial orchestration-only graph while that graph is developed and tested independently.
