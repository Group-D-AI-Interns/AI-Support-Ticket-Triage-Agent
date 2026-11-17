# Implementation Roadmap

## Gate 0 — Repository baseline

Inspect the repository, run existing tests/build, document current architecture and identify reusable code. No implementation changes until assessment is reviewed.

## Gate 1 — Architecture approval

Approve primary database, tenant model, identity provider, document storage, queue, AI providers, retrieval strategy, scoring governance and retention.

## Phase 1 — Foundation

Implement or adapt tenant context, authentication/authorisation, configuration, database connectivity, validation, error handling, structured logging and health checks.

## Phase 2 — Core organisation and policy domain

Implement organisations, users, roles, departments, teams, document upload/storage, extraction job tracking, policy versions and human approval.

## Phase 3 — SLA and ticket domain

Implement ticket CRUD/intake, comments, attachments, queue/search, SLA policy configuration, calendar-aware evaluation and escalation records.

## Phase 4 — AI workflows

Implement provider adapters, typed agent components, retrieval, execution tracking, confidence/evidence handling and AI evaluation tests.

## Phase 5 — Frontend and reporting

Build role-specific screens and connect them to real APIs. Avoid static mock data in final workflows.

## Phase 6 — Verification

Run unit, integration, API contract, end-to-end, security and domain-specific AI evaluation. Document results and limitations.

## Phase 7 — Deployment and handover

Provide Docker setup, `.env.example`, migrations/setup notes, Swagger/OpenAPI, README, deployment instructions, test evidence and known issues.

At each gate: demonstrate deliverables, list changed files, show tests and known issues, and wait for coach approval before proceeding.
