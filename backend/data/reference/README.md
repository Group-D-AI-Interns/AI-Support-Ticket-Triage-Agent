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
No automatic conversion of existing `high` or Jira source labels is implemented.

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

## Decision register (pending; not represented as team agreement)

| Decision | Proposed review owners | Required outcome |
|---|---|---|
| Organisation and approvals | Thuto + Olerato + authorised policy owner | Tenant, approver, effective date and immutable source version |
| Priority IDs and overrides | Wandile + Fhulu + policy owner | Adopt P1?P4 or explicitly approve a migration mapping; map Incident/Service Desk Manager authority to application roles; override reason and justification fields |
| Client entitlement model | Thuto + Fhulu + Faith | Client account/contract/version/effective dates; authorised classification register, separate from organisation and incident severity |
| Contractual SLA targets | Faith + business/service owner | Confirm illustrative table values against actual contracts |
| Calendars | Faith + business owner | Timezone, holidays, business-day length, tier/priority-specific 24/7 or business hours |
| Response and resolution evidence | Faith + Fhulu | Acknowledgement + assessment + assignment events, restoration/resolution notes, eligible start time; existing first-public-comment proxy is insufficient |
| Pause/exclusion evidence | Faith + Fhulu | Approved reason, actor, start/end and contract entitlement, beyond a paused-status name |
| SLA historical selection | Faith + Thuto | Preserve contract/tier/policy versions used; define effect of entitlement changes without rewriting history |
| Performance scope and ownership | Whole team + project owner | Confirm performance is retained scope; assign an owner before expanding the placeholder module |
| Performance formulas | Approved performance owner + HR | Within-KPA KPI weights, target normalisation (higher/lower is better), rating boundaries, missing-data treatment and eligible denominators |
| Performance evidence/access | Performance owner + Thuto | CSAT, quality audits, shifts, training and escalation sources; separate employee/lead assessment and tenant/role visibility |

## Next implementation gates

1. Review priority preview and source matrix. No LLM required to calculate a matrix.
2. Agree the priority contract before wiring preview into ticket AI/API responses or writes.
3. Approve the client/calendar/event design before extending SLA resolution.
4. Implement priority recommendation inputs/evidence separately from calculation; missing
   impact/urgency must request review rather than guess a low priority.
5. Implement versioned performance calculations only after scope/formulas/evidence are agreed.

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
