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

## 4. Evaluation

At ticket creation/update and scheduled checkpoints:
1. Resolve the applicable approved SLA version.
2. Determine the correct calendar and timezone.
3. Calculate deadlines using configured working time.
4. Compare reliable ticket events with the deadline.
5. Persist evaluation inputs, result and policy version.
6. Trigger configured escalation workflow where thresholds are met.

## 5. Governance

Policy changes require versioning and effective dates. Historical ticket evaluations must retain the policy version used at calculation time. Administrators can inspect why a deadline or breach status was produced.
