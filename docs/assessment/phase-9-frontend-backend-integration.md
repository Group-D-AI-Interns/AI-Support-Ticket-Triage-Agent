# Phase 9 — Frontend/backend integration

**Status:** Source integration and focused synthetic verification, 24 November 2026. Live authenticated browser-to-production-database acceptance is not established.

## Integration path

1. `frontend/components/auth-provider.tsx` initializes the public Keycloak browser client with authorization code flow and PKCE S256, refreshes access tokens, and supplies a token provider to the frontend API client.
2. `frontend/lib/api.ts` attaches the current bearer token and selected organisation header, disables response caching, and converts backend errors into `ApiError` values with request IDs and field errors.
3. `frontend/app/api/backend/[...path]/route.ts` forwards only GET, POST, PUT, and PATCH requests to the server-configured backend URL. It forwards authorization and organisation headers, streams request/response bodies, uses a bounded timeout, and returns `no-store` responses. It now preserves `Retry-After`, `Content-Disposition`, `Content-Length`, `X-Content-Type-Options`, and request ID headers.
4. The integrated backend verifies the bearer token, resolves the active backend membership for the selected organisation, derives permissions and team scope, then dispatches ticket, AI, policy, document, and administration endpoints to repositories.

The backend remains the authority for permissions, ownership, and tenant visibility. Frontend role checks control navigation and affordances only.

## Changes in this phase

- Connected private ticket attachment downloads from the support ticket detail view through the authenticated API client and same-origin proxy. The API client reads the backend's attachment filename and returns a blob for browser download.
- Preserved the backend's `Retry-After` response header through the proxy so the frontend can honor API throttling responses. The current UI reports the backend's safe error message and request ID; it does not automatically retry rate-limited writes.
- Kept the proxy server-side backend URL and allowlisted methods/headers. No database or LLM secrets are sent to the browser.

## Verification

- Frontend TypeScript check passed.
- Frontend ESLint passed.
- A synthetic proxy-handler check passed for URL path/query forwarding, bearer and organisation headers, HTTP 429, `Retry-After`, and attachment `Content-Disposition`.
- Isolated Next.js production build was attempted with `.next-phase9-check` output but stopped before compilation because the sandbox denied child-process creation (`spawn EPERM`).
- No application server was started, and no live browser/Keycloak session was used in this pass.

## Remaining acceptance gaps

- Automated browser E2E does not yet exercise sign-in and core journeys for requester, support agent, support lead, and organisation administrator.
- This workspace's backend environment currently selects JSON persistence, so this pass does not prove the browser path against MongoDB Atlas. The Atlas endpoint must be configured and readiness verified before claiming frontend-to-Atlas acceptance.
- Attachment storage is still local private storage and has no malware scanner. Production file workflow acceptance is pending the selected private-storage and scanning services.
- The existing backend test suite and synthetic API tests prove server behavior, not rendered UI state or browser downloads. A browser automation runner and isolated test identities/data are required for that final acceptance evidence.
