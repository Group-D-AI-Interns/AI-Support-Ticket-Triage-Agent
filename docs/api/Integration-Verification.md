# Integration and system verification

**Integration snapshot:** `f764c51` (`origin/thuto/foundation-identity-organisation`), with the subsequent local Phase 7 readiness check and handover edits. This report does not modify ticket, document, policy, AI, SLA or reporting domain code.

## Summary

The Thuto foundation is available, and the tenant-scoped repository/service patterns appear in the document and policy code. The team modules are not yet integrated into one runnable backend. The ticket API is a standalone Python/FastAPI application while the shared application and package scripts use Node.js/TypeScript. Ticket auth also uses a separate development principal instead of the shared Keycloak verifier, membership resolver and RBAC policy.

**Integration status: not yet system-ready.** Resolve the runtime and auth integration decisions below, repair the TypeScript build and clean-install failures, and then run protected API contract tests against the assembled application.

## Findings for module owners

### Blockers

1. **Two backend runtimes and entry points.** `backend/src/server.ts` starts the shared Node application. `backend/src/main.py` separately starts the FastAPI ticket application. The Node `createApp` does not mount the ticket API; the `npm start`, typecheck, build and test scripts target the TypeScript application. Agree whether tickets will be ported/mounted into the Node app or whether the project is approving a separately deployed Python service and documenting how it shares auth, tenancy and API contracts.

2. **Ticket authentication is not integrated with Keycloak.** `backend/src/modules/tickets/api.py` authenticates against the environment-backed development bearer principal in `development_auth.py`. That principal supplies `organisationId`, user ID, roles and team IDs from configuration rather than deriving them from a Keycloak token and server-side memberships. Ticket role checks are implemented locally rather than through shared `requirePermission`. Keep this only as an explicitly isolated test adapter; production ticket requests need the approved shared identity, tenant and permission contract.

3. **Merged TypeScript build fails.** `npm run typecheck` and `npm run build` report errors in document extraction queues, document repositories, extraction adapters/workers, policy repositories and document tests. These are in the document/policy implementation and need their owners to resolve before the Node app is considered buildable.

4. **Clean npm install fails.** `npm ci` reports `package.json` and `package-lock.json` are out of sync, including missing locked entries for `@types/node` and `undici-types`. Regenerate and commit the lockfile before asking teammates to install dependencies.

### Contract and persistence alignment

5. **Tenant context has two TypeScript import paths.** The foundation defines `TenantContext` under `shared/auth/authentication.ts`; document, policy and AI code imports a structurally similar type from `shared/tenant.ts`. It currently carries the same tenant concepts, but choose one canonical import path to prevent drift. Both paths must continue to require `organisationId`, `userId` and trusted membership `roles`.

6. **Document/policy JSON persistence bypasses the shared adapter.** Those repositories use `JsonTenantStore` (`infrastructure/persistence/json/json-store.ts`) rather than `JsonFileStore`. The alternate store catches all read/parse errors and returns an empty collection, and writes directly without atomic replacement or the shared writer lock. Adopt the shared adapter or agree on an adapter interface that preserves its validation and concurrency guarantees before the modules share runtime data.

7. **Permission and error contracts need a joint check.** Ticket routes perform local role checks; policy repositories throw generic `Error` for domain conflicts; the shared API maps unknown errors to a generic 500. Review those cases against shared permission identifiers and typed `AppError` responses. The API draft also says organisation creation is platform-admin-only, while the current implementation requires an existing tenant context with `organisations.create`; agree on the intended rule before changing either contract.

8. **Not all modules are in the integration branch.** The fetched Wandile classifier branch contains AI components but is not merged into `development`; SLA and reporting folders remain placeholders. Faith’s module cannot yet be checked for shared-contract use from this snapshot.

## Checks run

| Check | Result |
|---|---|
| Shared foundation source tests via Node's built-in TypeScript support | 23 passed, 0 failed |
| Ticket Python tests (`python -m pytest -q`) | 15 passed, 1 deprecation warning |
| TypeScript typecheck/build | Failed on document/policy module and test type errors listed above |
| `npm ci` | Failed because package and lock files are out of sync |
| Default `npm test` | Could not run: `tsx` is absent locally and the lockfile prevents `npm ci`; tests also need to avoid discovering generated `dist` output |
| End-to-end Keycloak-protected ticket/document/policy request | Not verified; modules are not mounted into the shared Node app and ticket auth is development-principal based |

## Integration exit criteria

- Agree on the ticket module runtime and wire its routes into the documented service topology.
- Replace ticket development-principal auth in the integrated path with verified Keycloak identity, active membership-derived `TenantContext`, and shared permission checks.
- Select the canonical tenant type and JSON repository contract and migrate module adapters accordingly.
- Resolve the compile errors and lockfile mismatch; make the test script run source tests deterministically without scanning generated output.
- Merge AI work and add the SLA/reporting module owners' code before claiming whole-system coverage.
- Add cross-tenant negative tests and authenticated API contract tests for tickets, documents, policies, AI, SLA and reporting.
