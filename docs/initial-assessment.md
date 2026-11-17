# Initial Repository Assessment

**Project:** Universal AI-Powered Support Management & Performance Platform  
**Assessment status:** Pending access to the application repository  
**Prepared from:** Supplied Capstone Project 05 specification and the accompanying universal-platform project brief.

## 1. Important assessment limitation

The project specification asks for inspection of the supplied repository. The materials available for this assessment describe the desired system, but do not include the application's source repository. Therefore, no claim is made here about the current code, framework, database, routes, authentication implementation, tests, or deployment.

This is an initial assessment record and inspection plan. Replace every “Not inspected” item with evidence from the actual repository once it is supplied.

## 2. Existing stack

| Area | Finding |
|---|---|
| Frontend | Not inspected — repository required |
| Backend | Not inspected — repository required |
| Database | Not inspected — repository required |
| Authentication/authorisation | Not inspected — repository required |
| AI/LLM integration | Not inspected — repository required |
| File/document storage | Not inspected — repository required |
| Testing | Not inspected — repository required |
| Deployment/CI | Not inspected — repository required |

The capstone specification recommends React + TypeScript, Node.js + TypeScript + Express, MongoDB, an LLM provider adapter, configurable embeddings, Zod, Jest, Supertest and Playwright. These are target recommendations, not verified existing technologies.

## 3. Repository structure and reusable code

**Not inspected.** The repository review must identify:
- Application entry points and package/workspace structure.
- Existing frontend pages, components, state management and API clients.
- Backend routes, controllers, services, domain modules and repositories.
- Database models, indexes, migrations and seed data.
- Authentication, role/permission checks and tenant ownership enforcement.
- Existing file upload, document processing, AI, reporting and notification integrations.
- Existing tests, build scripts, CI/CD and deployment configuration.

Reusable components cannot be identified responsibly without the source tree.

## 4. Required capability gap review

The following are requirements to verify against the existing application, not confirmed gaps:

| Capability to inspect | Required target |
|---|---|
| Tenant management | Isolated organisation configuration and data |
| Identity and access | Roles, permissions, tenant and team ownership |
| Document/policy management | Upload, extraction, versioning, approval and audit |
| SLA engine | Configurable targets, calendars, breach risk and escalation |
| Ticket operations | Intake, queue, detail, comments and attachments |
| AI triage | Classification, summary, priority, similarity, resolution and routing |
| Dashboards/reporting | Role- and tenant-scoped views |
| Governance | Approval workflows and auditable decisions |

## 5. Risks to verify

- Cross-tenant access through APIs, background jobs, search, exports or document retrieval.
- Overly broad roles or missing ownership checks.
- Unsafe file upload or publicly accessible documents.
- Prompt injection in uploaded documents or retrieved ticket text.
- AI-generated rules becoming active without administrator approval.
- SLA calculations using unapproved or invented targets.
- Sensitive customer or employee data in prompts, logs or test fixtures.
- Destructive refactoring that breaks existing workflows.

## 6. Inspection and baseline plan

1. Obtain the complete repository and setup instructions.
2. Inspect source tree, package manifests, configuration and deployment files.
3. Install dependencies using the repository's documented process.
4. Run existing lint, build and test commands; record exact results.
5. Map current frontend, backend, database and integration boundaries.
6. Trace representative user workflows end to end.
7. Review authentication, authorisation and tenant isolation.
8. Review data models, indexes, migrations and API contracts.
9. Identify reusable code and classify findings as keep, extend, refactor or replace.
10. Produce a prioritised gap register with file paths and evidence.

## 7. Preliminary recommendation

Preserve existing functionality by default. Prefer incremental changes and document the technical reason, affected files, test plan and rollback strategy for any modification. Do not begin major implementation until the repository assessment and proposed architecture are reviewed.

## 8. Inputs required to finalise

Provide the application repository as a ZIP or accessible source repository. Exclude production credentials, secrets and real customer personal information. The repository-specific findings and final recommendations remain open until that inspection is completed.
