# Implementation Roadmap

## Gate 0 — Repository baseline

Inspect the repository, run existing tests/build, document current architecture and identify reusable code. No implementation changes until assessment is reviewed.

## Gate 1 — Architecture approval

Approve primary database, tenant model, identity provider, document storage, queue, AI providers, retrieval strategy, scoring governance and retention.

## Phase 1 — Foundation

Implement or adapt tenant context, authentication/authorisation, configuration, database connectivity, validation, error handling, structured logging and health checks.

## Phase 2 — Core organisation and policy domain

Implement organisations, users, roles, departments, teams, document upload/storage, extraction job tracking, policy versions and human approval.

## Phase 3 — Ticket management

Implement ticket CRUD/intake, comments, attachments, queue/search, approved workflow changes, audit history, and stable ticket interfaces for SLA, AI and reporting consumers.

## Phase 4 — SLA engine

Implement versioned SLA policy configuration, business-calendar evaluation, evidenced response/resolution/pause/exclusion events, and explainable evaluation history. Keep reference targets inactive until tenant entitlement and contractual terms are verified.

## Phase 5 — AI workflows and knowledge retrieval

Implement provider adapters, typed agent components, retrieval, execution tracking, confidence/evidence handling and AI evaluation tests.

## Phase 6 — Performance, coaching and reporting

Implement only approved and verified performance calculations; deliver authorised operational reporting and dashboards using tenant-scoped ticket, AI and SLA data.

## Phase 7 — System integration, verification and hardening

Verify reviewed module contracts, critical end-to-end flows, API contracts, tenant isolation, permission boundaries, failure recovery and operational health. Record evidence and known limitations.

## Phase 8 — Deployment and handover

Provide approved deployment configuration, `.env.example`, setup notes, complete Swagger/OpenAPI, runbooks, backup/restore and rollback instructions, test evidence and known issues.

At each gate: demonstrate deliverables, list changed files, show tests and known issues, and wait for coach approval before proceeding.
