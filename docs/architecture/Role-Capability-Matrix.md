# Role and capability matrix

This matrix translates the approved Capstone Project 05 role responsibilities into the shared backend permission IDs. The permission source of truth is `backend/src/shared/auth/authorization.ts`.

## Identity and tenant rules

- Keycloak authenticates the caller and supplies the stable subject ID.
- The API resolves the local active user and active organisation membership. Membership records supply the caller's canonical role IDs; client-supplied role claims are not used to grant backend permissions.
- Every permission check is scoped to the verified `TenantContext`. Ticket ownership and active team membership checks still apply after the permission check.
- Unknown role IDs receive no permissions. `System Administrator` and `Organisation Administrator` are display aliases for the single canonical `organisation_admin` role.

## Role capabilities

| Role | Capabilities from the project brief | Shared permissions |
|---|---|---|
| Organisation Administrator / System Administrator (`organisation_admin`) | Configure categories, scoring, routing, SLA policies, teams, users, and permissions; manage organisation documents and policies; review extracted candidates; activate approved policy versions; read organisation tickets and reports; review AI and resolution recommendations; approve governed actions; inspect audit history. | `configuration.manage`, `teams.manage`, `users.manage`, `documents.read`, `documents.manage`, `policies.read`, `policies.manage`, `policies.candidates.review`, `policies.approve`, `policies.activate`, `tickets.read.all`, `tickets.ai.review`, `tickets.priority.manage`, `tickets.routing.manage`, `tickets.approve`, `tickets.resolution.review`, `tickets.audit.read`, `reports.read.all` |
| Support Lead / Team Lead (`support_lead`) | Manage queues, priorities, team routing, and configured approvals; review AI and resolution recommendations; read team audit history. | `queues.manage`, `queues.read.all`, `tickets.read.team`, `tickets.priority.manage`, `tickets.routing.manage`, `tickets.approve`, `tickets.ai.review`, `tickets.resolution.review`, `tickets.audit.read`, `reports.read.team` |
| Support Agent (`support_agent`) | Review assigned incoming tickets, AI triage, and resolution recommendations. | `queues.read.assigned`, `tickets.read.assigned`, `tickets.ai.review`, `tickets.resolution.review` |
| Requester / Customer (`requester`) | Submit tickets and read their own permitted tickets and status. | `tickets.create.own`, `tickets.read.own` |

## Complete role grants

- **Organisation Administrator:** `organisation.read`, `organisation.update`, `organisations.create`, `users.read`, `users.manage`, `teams.read`, `teams.manage`, `teams.members.read`, `documents.read`, `documents.manage`, `policies.read`, `policies.manage`, `policies.candidates.review`, `policies.approve`, `policies.activate`, `configuration.manage`, `queues.read.all`, `queues.manage`, `tickets.read.all`, `tickets.ai.review`, `tickets.priority.manage`, `tickets.routing.manage`, `tickets.escalations.read`, `tickets.approve`, `tickets.resolution.review`, `tickets.audit.read`, `reports.read.all`.
- **Support Lead:** `organisation.read`, `teams.read`, `teams.members.read`, `queues.read.all`, `queues.manage`, `tickets.read.team`, `tickets.ai.review`, `tickets.priority.manage`, `tickets.routing.manage`, `tickets.escalations.read`, `tickets.approve`, `tickets.resolution.review`, `tickets.audit.read`, `reports.read.team`.
- **Support Agent:** `organisation.read`, `teams.read`, `queues.read.assigned`, `tickets.read.assigned`, `tickets.ai.review`, `tickets.resolution.review`, `tickets.escalate`.
- **Requester:** `tickets.create.own`, `tickets.read.own`.

These are the complete grants from `ROLE_PERMISSIONS`; no role receives a permission merely because the frontend exposes an action.

## Enforced endpoint mappings

| Capability | Permission check | Additional scope check |
|---|---|---|
| Create ticket | `tickets.create.own` | Caller becomes requester; tenant comes from verified context. |
| Read ticket/list | `tickets.read.all`, `tickets.read.team`, `tickets.read.assigned`, or `tickets.read.own` | Organisation, requester ownership, and team membership filters. |
| Configure ticket workflow and organisation-owned configuration | `configuration.manage` | Active tenant context. |
| Read/upload/process documents | `documents.read`, `documents.manage` | The resolved tenant scopes document metadata and private storage. |
| Read/create/approve/activate policies | `policies.read`, `policies.manage`, `policies.approve`, `policies.activate` | Policy and source-document records must belong to the verified tenant. |
| Review extracted policy candidates | `policies.candidates.review` | Current approve, reject and request-changes routes require an active organisation administrator. |
| Assign/reroute ticket | `tickets.routing.manage` | Target team must belong to the active organisation; non-administrators must also belong to that team. |
| Set/override ticket priority | `tickets.priority.manage` | Granted to `support_lead` and `organisation_admin`; a changed priority requires reason and business justification. The server audits actor, timestamp, and before/after values. |
| Submit escalation | `tickets.escalate` | Granted to support agents; ticket must be in the caller's accessible tenant/team scope. Reason and handover notes are persisted and audited. |
| Read/resolve escalation queue | `tickets.escalations.read` | Granted to support leads and administrators; records are filtered to the caller's ticket scope, and resolution requires follow-up notes. |
| Approve a reopen request | `tickets.approve` and approved workflow role rules | Ticket and request must belong to the verified tenant. |
| Read ticket audit | `tickets.audit.read` | Ticket must be accessible in the verified tenant. |
| Read operational report | `reports.read.all` or `reports.read.team` | Administrators receive tenant-wide aggregates; support leads receive only tickets assigned to their active teams. |

The API enforces membership and permission checks on the backend. Hiding UI controls is not an authorization mechanism.

The project priority contract uses P1 (Critical), P2 (High), P3 (Medium), and P4 (Low).
Legacy internal labels map by name (`high`→P2, `medium`→P3, `low`→P4); Jira source
priority is retained separately and is never mapped automatically. The source policy's
override authority is represented by the existing support-lead and organisation-admin
grants; support agents and requesters cannot override priority.

## Capability gaps requiring team approval

The project brief and current endpoints do not define shared permissions for direct status changes, reopen requests, general ticket edits, comments, or attachments. These routes still combine workflow configuration and ownership/access checks; their write capability grants need review before the shared RBAC contract is complete. Customer communication and ticket closure must continue to follow configured approval rules.

Support lead reports are filtered using active server-resolved team memberships. Unassigned tickets and tickets assigned to other teams are excluded.

Ticket creation is currently granted to `requester` through `tickets.create.own`. An administrator or support worker who also needs requester-style ticket submission must have an explicitly approved additional role or grant; the API does not infer create permission from administrative access.

Organisation creation remains subject to the separate unresolved policy decision documented in `docs/api/Integration-Verification.md`.
