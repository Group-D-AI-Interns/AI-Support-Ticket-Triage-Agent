# Integration and system verification

**Integration snapshot:** local branch `thuto/foundation-identity-organisation`, commit `0ac3cda` (`Latest Update`) plus current local integration changes. This report records the local state and test evidence; it does not claim a live Keycloak integration test.

## Summary

The tickets runtime decision is now Node.js/TypeScript with Express. The Python ticket implementation was retired in the recorded migration, and ticket, document, policy, SLA and reporting routes are available from `backend/src/modules/tickets/api.ts`, started by `backend/src/main.ts`. AI classification and summarization components are present, but their README says no authorization-aware HTTP route or production provider is wired.

**Integration status: auth and persistence foundations unified; integration verification remains.** `backend/src/main.ts` starts one configured native HTTP server. It routes ticket, document, SLA, reporting, and workflow paths to the Express app, passing the shared Keycloak verifier, identity membership resolver, team lookup, permission policy, and the same `JsonFileStore` instance. Its normal application path does not use the static development principal.

## Six-item checklist

| Item | Status | Evidence / remaining work |
|---|---|---|
| Ticket runtime | Decided | TypeScript/Express is canonical; Python was retired. Ensure the shared Keycloak foundation and all modules use one bootstrap before deployment. |
| Ticket auth and permissions | Shared auth integrated; RBAC partially mapped | Express resolves `X-Organisation-ID` through active server-side membership and loads active team membership. The typed shared permission catalogue and role grants are documented in `docs/architecture/Role-Capability-Matrix.md`. Shared permissions gate ticket creation, configuration, audit reads, reopen approvals, organisation-wide reports, ticket visibility, routing, and support access. The application bootstrap disables the standalone development principal. Remaining write capabilities need team approval. |
| Document/policy auth and storage alignment | Shared foundation integrated; candidate review API remains open | The configured Express app passes the shared Keycloak authenticator, active-membership resolver, role permission policy, and same `JsonFileStore` instance to document/policy routes. Document/policy JSON collections now validate tenant records, surface typed storage errors, preserve legacy array files, and use locked atomic updates. Candidate-review permissions are defined, but no candidate-review endpoint exists yet. |
| Lockfile | Resolved | `npm ci` completed successfully on the current staged update. |
| AI, SLA and reporting | Code present; integration partial | AI classifier/summarizer, SLA evaluation and operational reporting sources and tests are present. SLA and reports are exposed through the tickets Express app. AI README explicitly says there is no authorized ticket source or HTTP/job route. No approved production LLM provider is configured. |
| Organisation creation rule | Unresolved | API specification says platform admin only, while `backend/src/app.ts` requires `organisations.create` in a selected tenant context. Team/coach must choose the rule and align implementation plus docs. |

## Integration risks to close

1. **Verify the unified auth path.** The one listener is wired, but no live Keycloak request was run in this update. Verify issuer/audience and membership behavior using the local realm and integration tests before deployment.
2. **Resolve remaining permission gaps.** Ticket status changes, reopen requests, general ticket metadata edits, comments, and attachments still rely on workflow role rules or resource access because the shared catalogue has no matching write permission. Do not grant new access until the team approves those capability IDs and role grants. `reports.read.team` is not used because the current report returns organisation-wide results; the route requires `reports.read.all`.
3. **Add candidate review operations.** Extracted candidates are persisted and the `policies.candidates.review` permission is defined, but no tenant-scoped candidate listing/review endpoint or review-state persistence exists yet.
4. **Finish AI integration deliberately.** Components currently provide service-level classification/summarization, not an authenticated API workflow. Add the endpoint/job integration only after an approved provider and a trusted authorized ticket-source interface are available.
5. **Resolve the organisation creation contract.** Current docs disagree; do not infer whether creation is platform-scoped or tenant-admin-scoped.

## Checks

| Check | Result |
|---|---|
| `npm ci` | Passed on the staged dependency update. |
| `npm run typecheck` | Passed after the RBAC catalogue and route changes. |
| `npm run build` | Passed after the RBAC catalogue and route changes. |
| Focused ticket auth/RBAC integration test | Passed: includes missing/invalid token, active/inactive membership, tenant isolation, requester grants, document/policy role denial, and shared foundation routes. Uses an injected authentication provider, not a live Keycloak token. |
| `npm test` | Passed: 57 tests, 0 failures, including storage error propagation, legacy collection migration, concurrent updates, and document/policy role grants/denials. |
| `src/tests/foundation.test.ts` | Passed: 19 tests, including signed Keycloak token issuer/audience/signature validation and identity membership checks. |
| Local Keycloak discovery | Passed; `http://localhost:8081/realms/ai-support` returned matching issuer metadata and JWKS URI. |
| Backend `.env` startup smoke test | Passed; `npm start` loaded `AUTH_MODE=keycloak`, and both `/api/v1/tickets` and `/api/v1/me` returned structured 401 responses without a bearer token. |
| Live Keycloak request through the Express ticket API | Not run; requires the local Keycloak realm and user login. |

## Next integration actions

- Fhulu/Thuto: verify the shared auth path against Keycloak, review workflow action permissions, and add cross-tenant denial tests.
- Olerato: implement tenant-scoped candidate listing/review state and routes using `policies.candidates.review`, `TenantContext`, and `JsonTenantStore.updateCollection`.
- Wandile/Faith: review AI/SLA/reporting routes and contracts with the integrated bootstrap; AI still needs a provider and authorized source wiring.
- Thuto/team: decide the organisation creation scope and verify the single startup path against the local Keycloak realm.
