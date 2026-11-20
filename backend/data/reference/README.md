# Business policy references

These files are source evidence, not application instructions or active tenant policies.
Original Markdown bytes were preserved when moving them from `data/seed/`.
`catalogue.json` records source IDs, versions, SHA-256 hashes, original status wording
and application status. Missing organisation, effective date and approval remain null.
An "Approved Template" heading is not application approval.

## Layout and use

- `policies/priority-policy.md`: ITSM-POL-001 v1.0, impact/urgency matrix.
- `policies/service-level-agreement.md`: ITSM-POL-002 v2.0, illustrative client-tier SLAs.
- `performance/support-agent-kpa-kpi.md`: HR-KPA-SA-001 v1.0, eight agent KPAs.
- `performance/support-lead-kpa-kpi.md`: HR-KPA-SL-001 v1.0, nine lead KPAs.
- `candidates/`: manually prepared structured draft transcriptions for review, not runtime seeds.

No startup script loads these references or candidates. `data/seed/` remains structured
synthetic initial data; no active SLA seed targets were replaced. Source checksums are
tested. If a source changes, create/review a new version and regenerate its candidates;
do not silently approve or activate a changed source. Checksums detect drift, not authenticity.

The priority draft uses canonical P1/P2/P3/P4 as written in the document. The isolated
`previewPriority` function receives the draft and explicit impact/urgency values; it
requires review and has no persistence, provider, permissions or mutation capabilities.
Legacy internal `high`, `medium`, and `low` ticket values normalize to P2, P3, and P4.
Jira source priority remains verbatim and is never mapped automatically.

## Adopted project priority contract

On 2026-11-19, the project adopted the source matrix and labels as its canonical ticket
priority contract: P1 Critical, P2 High, P3 Medium, P4 Low. The source impact/urgency
matrix is unchanged. `support_lead` and `organisation_admin` may set or override
priority; `support_agent` and `requester` may not. A changed priority requires a
non-empty override reason and business justification. The server records the
authenticated actor, timestamp, and before/after priority in ticket history.

This decision standardizes the application contract; it does not mark the source
template approved for a tenant or activate it. Tenant policy activation still requires
the existing tenant approval and effective-date workflow. The candidate remains inactive
and is not loaded as an active policy at startup.

## Adopted ticket/SLA evidence contract

On 2026-11-19, the project adopted the following event rules:

- Response and resolution clocks start at the server-generated ticket `createdAt`.
- First response requires acknowledgement, completed assessment, and first team
  assignment evidence; its timestamp is the latest of those three events. A public
  comment alone is not response evidence.
- Resolution requires an explicit documented resolution event on a transition into a
  configured resolved status. Customer-confirmation status and its evidence are recorded,
  but customer confirmation is not a completion gate.
- Pause and exclusion intervals require an allowed reason, evidence, actor, server
  timestamps, and a contract reference. Only support leads and organisation administrators
  may record or resume them. Exclusions subtract only their interval and do not remove the
  ticket from reports.
- Reopening resumes the existing resolution clock without resetting it; time spent in a
  resolved status is excluded from that clock.

These event rules do not verify client entitlement or approve contractual targets,
calendars, holidays, or effective dates. The source SLA candidate remains draft and
inactive until those decisions are verified.

## Governed ingestion boundary

For a real organisation, authorised uploads must create private document/version metadata
through the existing document service. Then extract candidate rules with document/version,
section and evidence references; validate them; obtain a recorded authorised human decision;
activate only the approved effective version. Retrieval must filter for the current tenant,
permissions, approval and effective dates before using sources as enforceable evidence.
Reference paths/hashes are not a substitute for those runtime document/version records.

Markdown upload is currently unsupported and the provisional `.txt` regex extractor cannot
read these tables correctly. Do not rename the files and claim they were interpreted.
The candidates here are review artifacts, not output attributed to an AI model. Do not
feed them to SLA activation endpoints without completing the relevant decisions below.

## Remaining decision register

| Decision | Proposed review owners | Required outcome |
|---|---|---|
| Organisation and approvals | Thuto + Olerato + authorised policy owner | Tenant, approver, effective date and immutable source version |
| Client entitlement model | Thuto + Fhulu + Faith | Client account/contract/version/effective dates; authorised classification register, separate from organisation and incident severity |
| Contractual SLA targets | Faith + business/service owner | Confirm illustrative table values against actual contracts |
| Calendars | Faith + business owner | Timezone, holidays, business-day length, tier/priority-specific 24/7 or business hours |
| Response and resolution evidence | Faith + Fhulu | Adopted 2026-11-19: acknowledgement + assessment + assignment; documented resolution event; customer-confirmation status is recorded but not a gate |
| Pause/exclusion evidence | Faith + Fhulu | Adopted 2026-11-19: evidenced intervals with reason, actor, server timestamps and contract reference; only support leads/admins can record |
| SLA historical selection | Faith + Thuto | Preserve contract/tier/policy versions used; define effect of entitlement changes without rewriting history |
| Performance scope and ownership | Whole team + project owner | Confirm performance is retained scope; assign an owner before expanding the placeholder module |
| Performance formulas | Approved performance owner + HR | Within-KPA KPI weights, target normalisation (higher/lower is better), rating boundaries, missing-data treatment and eligible denominators |
| Performance evidence/access | Performance owner + Thuto | CSAT, quality audits, shifts, training and escalation sources; separate employee/lead assessment and tenant/role visibility |

## Next implementation gates

1. Review priority preview and source matrix; the project contract is adopted, but the
   candidate remains inactive until tenant approval. No LLM is required to calculate it.
2. Verify client entitlement, contractual targets, calendars, holidays and effective dates
   before activating any SLA policy based on the reference candidate.
3. Implement priority recommendation inputs/evidence separately from calculation; missing
   impact/urgency must request review rather than guess a low priority.
4. Implement versioned performance calculations only after scope/formulas/evidence are agreed.

AI may propose structured interpretations and cite evidence. It does not grant permissions,
change client entitlement, activate policy, assign tickets or determine arbitrary employee scores.
Neither LangGraph nor embeddings/index storage are added by this task.

## Implementation evidence

Completed preparation: byte-preserving relocation of four documents, inactive source
catalogue, four source-linked candidate JSON files, and a pure priority preview in
`src/modules/ai/components/priority-matrix.ts`. Root README links to this guide.
No existing domain module, API, permissions, active seed policy or employee record
was changed. No dependencies, LLM calls or LangGraph work were introduced.

Verification: `npm test` passed 107/107 (13 new checks); `npm run typecheck` and
`npm run build` passed; `git diff --check` passed. The priority checks cover all
nine matrix combinations, missing/invalid input, extra permission/client fields,
incomplete/active-policy claims, source hash consistency and inactive SLA/performance
artifacts. These results verify previews and existing regressions, not approval of
business policy or production SLA/performance readiness.
