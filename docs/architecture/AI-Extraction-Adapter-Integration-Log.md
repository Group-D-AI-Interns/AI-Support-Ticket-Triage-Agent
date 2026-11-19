# AI Document Extraction Integration Log

## Agreed integration decisions

- Use the worker's batch result envelope: `executionId`, `status`, `rules[]`, and `warnings`.
- Carry document and document-version provenance, evidence, confidence, ambiguity, and human-review flags on each candidate rule.
- Store provider/model and timing metadata on the extraction job.
- Bind each extraction job to a policy and policy version before it runs; reject missing or mismatched targets.
- Support `text/plain` `.txt` documents in this integration. PDF and Word extraction remain deferred because no text extraction adapter is installed.
- Retry thrown/transient failures only up to the job's `maxAttempts`; adapter-reported non-retryable failures and unsupported document formats fail without retry.
- `ProvisionalExtractionAdapter` remains a local deterministic placeholder. Do not treat it as an approved LLM provider.

## File change record

### Entry 001 — Shared batch extraction contract

- **Created:** `backend/src/modules/documents/services/extraction-adapter.ts`.
- **Modified:** `backend/src/modules/documents/services/provisional-extraction-adapter.ts` to return a one-item batch and execution metadata.
- **Modified:** `backend/src/modules/documents/services/mock-extraction-adapter.ts` to implement the same contract.
- **Contract validation:** Validates batch status, execution metadata, per-rule confidence and review fields, evidence sources/provenance fields, warnings, and retryable failure metadata.

### Entry 002 — Worker and policy-bound candidate persistence

- **Modified:** `backend/src/modules/documents/domain/extraction-job.ts` to bind a job to `policyId` and `policyVersionId` and retain warnings/execution metadata.
- **Modified:** `backend/src/modules/documents/repositories/document.repository.ts` and `backend/src/modules/documents/repositories/json-document.repository.ts` to retrieve a tenant-scoped document version.
- **Modified:** `backend/src/modules/documents/workers/extraction-worker.ts` to load tenant-scoped UTF-8 text, reject unsupported file formats without retry, verify policy/version and source provenance, persist the full rule batch, record execution metadata, and distinguish retryable from terminal failures.
- **Modified:** `backend/src/modules/documents/services/candidate-rule-service.ts` to validate the policy/version relationship, preserve extraction metadata, and persist candidate batches with stable execution-based IDs.
- **Modified:** `backend/src/modules/policies/domain/policy.ts`, `backend/src/modules/policies/repositories/policy.repository.ts`, and `backend/src/modules/policies/repositories/json-policy.repository.ts` to persist candidate batches idempotently and retain execution, document-version, review, and warning fields. New fields are optional for compatibility with existing candidate records.

### Entry 003 — Integration tests and AI documentation

- **Modified:** `backend/tests/document-phase3.test.ts` to cover worker input loading, candidate persistence, and retry state.
- **Modified:** `backend/tests/document-phase4.test.ts` to cover extraction validation, idempotent batch writes, end-to-end provisional-worker integration, unsupported formats, and non-retryable failures.
- **Modified:** `backend/src/modules/ai/README.md` to reflect the TypeScript ticket API and distinguish the provisional extraction parser from a production LLM.
- **Created:** `docs/architecture/AI-Extraction-Adapter-Integration-Log.md`.
- **Validation:** `npm test` passed **34/34**. `git diff --check` passed. `npx tsc --noEmit` remains blocked by `TS2688` because `@types/node` is missing; no dependency manifests were changed.

## Remaining limitations

- The provisional extractor is regex-based; no production provider is selected or integrated.
- Only UTF-8 plain-text `.txt` files are supported by this worker path. PDF/DOC/DOCX uploads must not be sent through it.
- The confidence review threshold remains the provisional `0.7` rule and is not calibrated.
- There is no job-creation API/composition root in this change; callers enqueue jobs with a trusted tenant, document version, policy ID, and policy-version ID.
- Candidate persistence uses the existing JSON store, whose broader concurrency and read-error behavior remains unchanged.
