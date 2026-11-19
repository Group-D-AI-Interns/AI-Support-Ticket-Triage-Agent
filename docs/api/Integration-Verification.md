# Integration and system verification

**Integration snapshot:** local `feat/wandile-classifier` branch, based on Olerato's `29a4170` (`candidate-review routes`) plus the current Wandile integration changes.

## Summary

The canonical backend is TypeScript. `backend/src/main.ts` starts one server through `backend/src/server.ts` and `backend/src/integrated-app.ts`; it serves the foundation identity/organisation/team APIs and the Express ticket, document, policy, SLA and reporting APIs together.

The integrated ticket API authenticates with the shared Keycloak verifier, resolves active tenant membership server-side, loads active team membership, and applies the shared role-permission policy. The integrated startup does not accept the static development principal.

Ticket classification, summarisation, priority preview and resolution recommendation routes are connected to the integrated API. AI work is opt-in and does not change tickets automatically. Document processing supports TXT, PDF and DOCX text conversion, but still uses the deterministic provisional extraction adapter; a provider-backed `ExtractionAdapter` has not yet been implemented or wired.

## Six-item checklist

| Item | Status | Evidence / remaining work |
|---|---|---|
| Single application bootstrap | Integrated | One listener serves foundation and Express domain routes; `tests/integrated-app.test.ts` exercises cross-module flows. |
| Authentication and tenant isolation | Integrated; external realm still needs verification | Bearer authentication, active organisation membership, team scope and role permissions are server-resolved. Signed-token tests use a mocked JWKS endpoint. |
| Ticket AI | Service and API paths integrated | Demo/live classification and summarisation, priority preview, lexical retrieval and resolution recommendation are permission-gated. AI analysis and recommendations are read-only and require human review. |
| Document policy extraction | Contract and processing path integrated; provider pending | Olerato's `ExtractionAdapter` contract, result validation, evidence provenance checks, and TXT/PDF/DOCX text conversion are present. The default remains `ProvisionalExtractionAdapter`; no provider-backed extractor is connected. |
| Persistence | Shared guarantees integrated | Domain JSON persistence delegates to the validated shared store, preserving schema validation, atomic writes, locking and explicit errors. Multi-file workflows still are not transactional. |
| Organisation creation rule | Unresolved | The API specification and implementation may still need a team decision on platform-scoped versus tenant-scoped organisation creation. |

## Integration risks to close

1. **Implement and wire a real extraction adapter.** Use the existing contract and approved policy schema; preserve document/version provenance and human-review rules. Confirm rule payloads and provider/model before sending customer documents externally.
2. **Verify live integrations in the team's environment.** No live Keycloak or LLM calls were made during these checks. Use synthetic ticket/document data and private local credentials.
3. **Resolve the organisation creation contract.** Align the API specification and implementation on platform-scoped versus tenant-scoped organisation creation.
4. **Harden multi-file workflows.** JSON collection operations are locked, but upload/version, policy approval and extraction result/status changes span files and are not transactional.

## Checks

| Check | Result |
|---|---|
| `npm ci --prefix backend` | Passed. |
| `npm test --prefix backend` | Passed: 149 tests, 0 failures. Provider tests use mocked HTTP. |
| `npm run typecheck --prefix backend` | Passed. |
| `npm run build --prefix backend` | Passed. |
| `git diff --check` | Passed before final staging. |
| Live Keycloak / Groq / Inception / Mistral requests | Not run. |

## Next integration actions

- Olerato/Wandile: agree on extraction rule schemas, provider/model, evidence format and review thresholds; implement the provider-backed adapter.
- Team: verify the single startup path against the real development Keycloak realm and decide organisation-creation scope.
- AI owners: keep live provider calls disabled in production until external data handling and provider configuration are approved.
