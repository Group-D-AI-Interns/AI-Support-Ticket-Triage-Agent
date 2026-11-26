# Backend integration handover

Date: 2026-11-19 (Africa/Johannesburg)
Assigned member: Wandile, cross-module integration explicitly requested by the user.
Phase: integration verification before LangGraph.

## Result

The default application now serves foundation and domain endpoints on one HTTP server.
Verified identity, active organisation membership and stored team scope reach tickets,
documents, policies, SLA, reporting and AI without a static development principal.
Existing classifier/summarizer/provider/runner implementations are reused.
No dependencies were added, no LangGraph work was started, and no branch/commit/push
operation was performed. Pre-existing local AI/provider changes were preserved.
The local `.env` and real runtime records were not read or modified by this task.
Build output was generated under the ignored `backend/dist/` directory.

## Files created in this task

- `backend/src/integrated-app.ts`: one composition boundary with per-request authentication and membership-derived team scope.
- `backend/src/modules/ai/json-ai-analysis.repository.ts`: validated tenant-scoped durable history using shared JSON storage.
- `backend/tests/integrated-app.test.ts`: five assembled-server/storage integration tests.
- `docs/architecture/Backend-Integration-Handover.md`: this handover.

## Files modified in this task

- `backend/package.json`: default tests include foundation/module tests under `src/`.
- `backend/src/app.ts`: delegate existing domain route families; repair team PATCH allowed fields.
- `backend/src/main.ts`, `backend/src/server.ts`: common integrated startup.
- `backend/src/shared/tenant.ts`: re-export the canonical foundation tenant type.
- `backend/src/modules/tickets/api.ts`: injected request authentication and durable analysis repository, shared error mapping, request-scoped AI access and authorised manual priority updates.
- `backend/src/modules/tickets/repositories/json-ticket.store.ts`: audited internal priority updates.
- `backend/src/modules/ai/local-demo-runtime.ts`, `backend/src/modules/ai/live-ticket-ai-runtime.ts`: accept a repository dependency while preserving isolated in-memory defaults.
- `backend/src/infrastructure/persistence/json/json-file-store.ts`: expose exclusive operations and safely accept legacy camelCase collection filenames.
- `backend/src/infrastructure/persistence/json/json-store.ts`: shared safe-storage compatibility adapter; malformed data no longer becomes an empty collection.
- `backend/src/infrastructure/persistence/json/migrations/001_document_policy_schema.ts`: non-destructive collection setup.
- `backend/src/modules/documents/repositories/json-document.repository.ts`: lock full read/modify/write methods.
- `backend/src/modules/documents/queue/in-memory-extraction-queue.ts`: lock enqueue/claim/update operations.
- `backend/src/modules/documents/services/document-processing.service.ts`: serialise extraction writes and validate source/execution provenance.
- `backend/src/modules/policies/repositories/json-policy.repository.ts`: lock policy/version/candidate/approval writes.
- `backend/src/modules/sla/repositories/sla-evaluation.repository.ts`: lock evaluation appends.
- `README.md`, `backend/.env.example`, `backend/src/modules/ai/README.md`: integrated startup/auth/storage instructions.
- `docs/api/API-Specification.md`, `docs/api/Integration-Verification.md`, `docs/operations/Deployment-and-Handover.md`: current integration contract and limits.

Some files above were already modified/untracked before this task. This is the list
of paths touched by this integration, not a claim that all working-tree differences
were introduced here. No unrelated local work was discarded.

## API and storage contract changes

Default protected routes require foundation authentication plus verified stored membership.
Tenant selection uses `X-Organisation-ID` or `organisationId`; it does not grant access.
Jira retains its independent secret/project/reporter contract. No Jira configuration is
required merely to start the rest of the backend.

The integrated AI runtime persists history in `ai-analyses.json`. No checkpoint store
or new primary datastore was introduced. Legacy document/policy collection filenames
are retained and must contain `{schemaVersion: 1, records: [...]}` envelopes. Invalid
files fail explicitly; operators should restore/repair them rather than reset them.

Ticket PATCH accepts internal `priority` only with `tickets.priority.manage` plus
existing ticket visibility. Jira priority remains source metadata; an operator sets
internal priority explicitly before SLA evaluation. The update is audited and AI
analysis continues to leave the ticket unchanged.

## Test evidence

- `npm test`: 94 passed, 0 failed (9 suites).
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Compiled startup with temporary data and external AI disabled: `/health/ready` 200;
  `/api/v1/tickets` 503 when authentication is disabled.
- Signed-token integration uses real RSA signatures and the actual Keycloak verifier,
  with a mocked JWKS response. Tests prove membership/tenant/team isolation and revocation.
- Full local flows include upload/extraction/human policy approval/activation,
  independently authenticated Jira ingestion/manual priority/SLA/reporting, workflow
  approval/attachments/status/audit and AI history persistence across restart.

Initial integration exposed Jira source priority being absent from the internal ticket
priority. This was corrected through an explicit permission-checked human update path,
not implicit priority mapping. Focused tests and the complete suite pass after the fix.

## Remaining work and practical limits

- Verify the deployed Keycloak realm, user invitations and actual provider/model responses in the team's environment. No external authenticated request was made here.
- Bootstrap active local organisation/user/admin membership records for real development users. Empty seed files do not create these automatically.
- Shell/IDE environment loading is explicit; startup does not automatically load `.env`.
- Live AI remains development-only and synchronous; rate limiting, capacity controls, cancellation/backpressure and real-model quality evaluation remain production work.
- Domain collection boundaries validate envelopes and IDs; complete domain schema validation on every storage read remains further hardening.
- Single-collection locks/atomic writes are not multi-file transactions. Upload/version/extraction and approval/status sequences need documented crash recovery/compensation before production use.
- Foundation lockfiles do not recover stale locks automatically. Confirm no writer is active before operator lock recovery.
- `.txt` extraction is provisional; PDF/Word parsers, knowledge indexes/retrieval, AI recommendations beyond classification/summary and background ticket AI execution are not implemented.
- Reports currently cover ticket and SLA aggregates, not a complete AI performance/evaluation dashboard.
- Existing policy-bound extraction worker is exercised by its service tests; no new daemon/scheduler or job API was added.
- LangGraph dependency approval remains pending. It can be considered after this integrated baseline is reviewed.
