# Testing Strategy

## 1. Test layers

- Unit: domain rules, validation, SLA calendar calculations, state transitions.
- Integration: repositories, tenant filters, object storage, queue workers and provider adapters.
- API contract: request/response schemas, authentication, permissions, pagination and errors.
- Security: cross-tenant access, privilege escalation, file access, prompt injection and data leakage.
- AI evaluation: extraction correctness, classification quality, summary completeness, groundedness, confidence calibration and safe refusal/uncertainty.

## 2. Critical scenarios

1. User cannot access a different tenant's ticket, document, policy or performance record.
2. Extracted policy remains inactive until approved.
3. Expired or superseded policy is not applied to new evaluations.
4. SLA deadline uses the configured calendar and approved target.
5. AI recommendation includes evidence or identifies missing evidence.
6. Low-confidence output is flagged for human review.
7. Required approval blocks consequential action.
10. Leader's own assessment is distinct from team metrics.

## 3. Evidence

Record command, environment, test suite, pass/fail counts, skipped tests and known limitations. Never claim tests passed unless they were actually run.
