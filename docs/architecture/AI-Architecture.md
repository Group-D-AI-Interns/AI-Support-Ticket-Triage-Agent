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

## 7. Phase 4 implementation status

This table reflects backend source and synthetic tests, not claims about live tenant policy or
provider quality.

| Required component | Current implementation | Status / boundary |
|---|---|---|
| Ticket Classifier Agent | Typed classifier, configured tenant categories, exact ticket evidence, uncertainty/review branch in LangGraph. | Implemented in the tested backend path. |
| Summarizer Agent | Typed structured summary, required fields, runner validation and prompt version metadata. | Implemented in the tested backend path. |
| Priority Recommendation Agent | Provider assesses evidence-backed impact and urgency; configured draft matrix deterministically previews priority; never writes ticket priority. | Implemented as review-only recommendation; matrix is not an active tenant-approved policy. |
| Similarity Retrieval Agent | Tenant-authorized, active/approved/effective knowledge and verified historical resolutions are retrieved with provenance. | Lexical only; semantic/vector retrieval and index are not connected. |
| Resolution Recommender Agent | Provider suggests ordered steps only when each step cites a permitted exact passage; otherwise returns insufficient evidence. | Implemented as review-only guidance; reviewer edits and confidence contract remain undefined. |
| Routing Agent | Deterministic recommendation from approved effective category-to-team rules and caller-eligible teams. | Implemented; no workload, product ownership, or expertise inputs. Never assigns. |
| SLA Evaluator | Deterministic SLA engine evaluates ticket timestamps, active policy versions, calendars and evidence; AI exposes only a verified current result. | Engine is connected; real tenant-approved active policies/calendars have not been verified. |
| Approval Workflow Manager | Separate ticket-review, policy-approval and recommendation-review paths enforce their own permissions and record decisions. | No universal manager or shared action matrix. Do not infer approval rules for other consequential actions. |

### Execution and provider metadata

Provider-backed tasks use `AiExecutionRunner` for execution IDs, bounded timeouts, retry
rules, strict output validation, safe errors and execution logging. Successful core
classification/summary runs persist provider, model, attempts, duration and timestamps. The
LangGraph record persists the core run ID, snapshot/configuration hashes, trace, outcome and
prompt versions. Priority and resolution include their runner execution metadata in their
reviewable outputs. Deterministic retrieval, routing and SLA evaluation do not call a model
and do not currently have individual provider execution records. There is no universal
component-level run ledger for every capability.

OpenAI-compatible responses now preserve non-negative integer prompt, completion and total
token counts when the provider supplies them. Missing or malformed usage is omitted. These
counts are estimates/reports from the provider and are not derived from raw prompts. Legacy
records without usage remain valid. Other provider adapters may omit counts.

Prompt text and prompt-version constants currently live in component source files. Provider,
model, timeout/retry and confidence-threshold selection is configured through the process
environment; tenant categories, routing rules and SLA policies use their existing governed
configuration APIs. There is no administrator-editable prompt registry or prompt deployment
workflow. This remains a Phase 4 gap; moving prompt editing into tenant-facing configuration
would require a defined permission, review and versioning contract.

Uploaded and retrieved content is passed as untrusted data, not executable instructions;
structured outputs and evidence are validated by trusted code. That protects the workflow
boundary but does not constitute a general-purpose prompt-injection detector or prove model
robustness. The synthetic tests verify these constraints at the adapter boundaries; live
quality and attack resistance need a governed evaluation dataset and provider-specific review.
