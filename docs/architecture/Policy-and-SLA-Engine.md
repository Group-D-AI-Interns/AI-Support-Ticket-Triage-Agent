# Policy and SLA Engine Design

## 1. Policy lifecycle

Policies have organisation ownership, type, version, effective dates, expiry dates, owner, status and audit history. Candidate rules extracted by AI remain inactive until an authorised administrator reviews and approves them.

Suggested lifecycle: Draft → Pending Approval → Approved → Active → Expired/Archived. Rejected or returned-for-changes candidates retain their decision history.

## 2. Rule model

A structured rule should retain:
- Organisation and source document/version.
- Rule type and structured payload.
- Source page/section or text evidence.
- Extraction method/model/config version.
- Confidence and ambiguity flags.
- Reviewer, decision, reason and timestamps.
- Effective-from and effective-to dates.
- Status and superseding version, if any.

## 3. SLA configuration

Support configurable first response, average response and resolution targets; priority-based policies; department/team scope; business hours; working calendars; public holidays; pause conditions where approved; escalation rules and notification settings.

Do not invent targets. All targets must originate from approved organisation configuration.

The SLA evaluator consumes a normalized payload from an active, approved `sla`
policy version. The document extraction and approval workflow remains the
source of that version; extracted text is not evaluated directly. The initial
payload contract is:

The current API accepts tenant-scoped document uploads and records document
versions. Processing supports UTF-8 plain-text (`.txt`) sources only; PDF and
Word extraction is not yet available. The provisional extractor records
version-bound candidate evidence for human review but does not create policy
payloads, set SLA defaults, or activate policies. An administrator must
transcribe and verify the full policy against the tenant's document, then use
the normal approval and activation lifecycle.

```json
{
  "calendar": {
    "timeZone": "Africa/Johannesburg",
    "weeklySchedule": {
      "monday": [{ "startMinute": 540, "endMinute": 1020 }]
    },
    "holidays": ["2026-12-25"]
  },
  "targetsByPriority": {
    "high": {
      "firstResponseMinutes": 60,
      "resolutionMinutes": 240
    }
  },
  "pausedStatuses": ["PENDING"],
  "resolvedStatuses": ["RESOLVED", "CLOSED"],
  "riskAtPercent": 75
}
```

The values above illustrate the schema only; they are not recommended or
default targets. `startMinute` and `endMinute` are minutes after local midnight.
An optional `teamIds` list scopes a policy version to matching teams; without
it, the version is organisation-wide. A team-specific active version takes
precedence over an organisation-wide version. Ambiguous active matches are
rejected rather than selected arbitrarily. Activating a later version closes
the previous version's effective period, so tickets created earlier continue
to resolve against the historical policy that applied to them.

## 4. Evaluation

The evaluation service resolves each ticket using:
1. Resolve the applicable active SLA version for the ticket's organisation,
   priority, team and creation time.
2. Determine the correct calendar and timezone.
3. Calculate deadlines using configured working time.
4. Compare reliable ticket events with the deadline.
5. Persist evaluation inputs, result and policy version.
6. Record at-risk and breached states for reporting.

The current API exposes an administrator-triggered tenant batch evaluation.
Automatic evaluation on ticket events and a scheduled worker are not yet wired.
Notification/escalation actions require a separately agreed tenant policy
contract.

## 5. Governance

Policy changes require versioning and effective dates. Historical ticket evaluations must retain the policy version used at calculation time. Administrators can inspect why a deadline or breach status was produced.
