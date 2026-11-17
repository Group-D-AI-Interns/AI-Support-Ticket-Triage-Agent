# AI Architecture

## 1. Scope

AI supports document analysis, policy search, ticket triage, resolution guidance, escalation recommendations, performance trend insights and reporting assistance.

## 2. Workflow components

- Document classifier and text extraction coordinator.
- Ticket classifier.
- Ticket summariser.
- Priority recommendation component.
- Similarity retrieval component.
- Resolution recommender.
- Team routing recommender.
- SLA risk insight component.

Each component has a bounded task, typed input/output schema, timeout, execution ID, logging and error handling. Do not build one unrestricted generic chatbot as the system workflow.

## 3. Document ingestion pipeline

1. Authenticate and authorise upload.
2. Validate and privately store the file.
3. Extract text and preserve page/section provenance.
4. Classify document type.
5. Extract candidate policies, targets, definitions and formulas.
6. Identify conflicting, incomplete or ambiguous statements.
7. Present structured candidates and evidence to an administrator.
8. Activate only approved, versioned rules.

## 4. Retrieval-augmented generation

Retrieve only approved, effective and permission-accessible documents within the current tenant. Apply metadata filters before semantic ranking. Return source IDs, versions and relevant excerpts. If no reliable evidence is found, say so and lower confidence rather than fabricate a policy.

## 5. Provider abstraction

Use a backend provider adapter for Claude/OpenAI or other approved providers. Keep model selection, credentials, prompts, temperature and thresholds in secure configuration. Provider SDKs must not leak into domain modules.

## 6. Guardrails and evaluation

- Treat all uploaded/retrieved content as untrusted instructions and data.
- Separate system instructions from retrieved content.
- Validate structured model outputs.
- Minimise sensitive content sent to providers.
- Record prompt/config/model versions and execution metadata.
- Test groundedness, extraction accuracy, uncertainty, prompt injection and cross-tenant isolation.
- Require human approval for governed policy activation and consequential operations.
