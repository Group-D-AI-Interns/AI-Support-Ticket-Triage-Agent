# High-Level Design (HLD)

## 1. Scope

This HLD describes the principal application components and their interactions. It is a proposal derived from the supplied requirements; repository-specific implementation details remain unverified.

## 2. Component responsibilities

| Component | Responsibilities | Data owned or managed |
|---|---|---|
| Web client | Role-based UI, forms, queues and dashboards | Client state only |
| API layer | REST endpoints, validation, auth and error handling | No independent domain ownership |
| Tenant/IAM | Tenant context, membership, roles and permissions | Organisations, users, roles, memberships |
| Document service | Upload, metadata, versions and secure file access | Document metadata and object references |
| Policy service | Policy lifecycle, extracted rules, approval and effective versions | Policies, versions, rule records |
| Ticket service | Ticket lifecycle, comments, attachments and assignment | Tickets and ticket history |
| SLA engine | Deadline calculation, breach evaluation and escalation | SLA policies and evaluation records |
| AI orchestrator | Bounded AI workflows and provider/tool calls | Agent execution metadata and outputs |
| Retrieval service | Permission-filtered historical and approved knowledge retrieval | Search references/index metadata |
| Approval/audit service | Review tasks, decisions and audit trail | Approvals and audit events |
| Reporting service | Authorised aggregations and exports | Report definitions/snapshots as configured |
| Worker | Asynchronous ingestion, AI and scheduled calculations | Job state and execution metadata |

## 3. Main interactions

- Browser calls the API; it never connects directly to the database or LLM provider.
- API authenticates the user and resolves tenant context before invoking domain services.
- Document uploads are stored privately and processed asynchronously.
- Extracted policy candidates enter a human review workflow before activation.
- Ticket triage orchestrates classification, summarisation, priority, retrieval, resolution and routing components.
- SLA evaluation uses approved policy versions, business calendars and reliable event timestamps.
- Audit events are recorded for configuration changes, AI recommendations, approvals, overrides and assessments.

## 4. Deployment units

Initial recommendation:
- Web frontend.
- Backend API application.
- Background worker process.
- Primary database.
- Private document/object storage.
- Optional queue and vector index, subject to technology approval.
- External LLM provider accessed only through a backend adapter.

## 5. Reliability and failure handling

Use timeouts, bounded retries, idempotency for suitable operations, dead-letter/retry handling for failed jobs, provider circuit-breaking where appropriate, and clear user-visible job status. A failed AI provider call must not corrupt the original ticket or policy document.

## 6. Security boundaries

Enforce permissions in the API and domain service layers. Apply tenant scope to all data access and retrieval. Use private storage and short-lived authorised download access. Redact sensitive data from logs and prompts. Record privileged actions and approvals.

## 7. Quality attributes

Security, tenant isolation, privacy, reliability, performance, maintainability, observability, accessibility and auditability are first-class acceptance criteria.
