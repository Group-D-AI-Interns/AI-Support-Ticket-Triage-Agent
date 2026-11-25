# Security and Permissions Design

**Status:** Repository-aligned security view, reviewed 23 November 2026.

## Identity and authorization

- Keycloak issues the bearer token; the backend verifies token signature, issuer, audience, expiry, and subject using the configured verifier.
- The token subject must resolve to an active backend user and active membership in the requested organisation. A valid token alone does not grant access to an organisation.
- Backend membership roles are mapped through the permission policy. The UI may use `/api/v1/me` permissions for navigation, but every protected API action must enforce backend authorization.
- Tenant context is resolved from authenticated identity and membership. Caller-supplied organisation IDs are selectors that must be authorized, not proof of access.

## Role identifiers

The current backend role identifiers are `organisation_admin`, `support_lead`, `support_agent`, and `requester`. Permissions are defined by the backend policy and endpoint-specific checks. Do not replace these with generic “system administrator” or “support leader” labels; platform-wide administration and tenant roles must not be inferred from UI names.

The effective capabilities vary by endpoint and ticket scope. For example, support leads receive team/unassigned ticket visibility and review/escalation actions where granted; support agents are scoped according to assignment/team policy; requesters are restricted to their own permitted tickets. The backend's [role capability matrix](Role-Capability-Matrix.md) and executable permission policy are authoritative for current behavior.

## Tenant and data boundaries

Tenant filters are required on tenant-owned reads/writes, including membership, documents, policies, tickets, AI jobs/results, SLA evaluations, knowledge, and audit queries. Ticket access additionally uses server-derived requester, team, or read-all scope. MongoDB repositories apply structured tenant filters where implemented; broad compatibility reads remain a production-scale gap and must not be mistaken for live Atlas proof.

Uploaded files are served through authorization-checked API routes and local private storage. Production object-storage isolation, malware scanning, retention/deletion, and recovery are not yet verified. No vector index is active. If added later, it must enforce the same tenant and evidence visibility rules.

## AI and file safety

- Treat uploaded content, ticket text, retrieved evidence, and provider output as untrusted.
- Validate provider output against task-specific schemas and verify provenance/citations before persistence or downstream use.
- Preserve human review for governed changes; AI recommendations alone do not change ticket state or activate policies.
- Provider, conversion, or validation failures must fail safely without mutating the source ticket or approving a candidate.
- Keep secrets and raw sensitive provider output out of logs and client responses; use bounded, task-specific provider inputs.

## Audit and operational controls

`/api/v1/audit-logs` is currently admin-authorized and aggregates existing organisation-scoped records. It is not a common audit ledger for every identity/team/configuration mutation. Full audit event coverage and production tamper/recovery controls remain open.

Rate limits/public-intake behavior, retention/deletion periods, monitoring thresholds, hosting/network controls, and recovery objectives are not specified or selected here. Production private storage and malware scanning also require an approved infrastructure design. Do not implement invented policy values as defaults.
