# UI/UX Design

## 1. Experience goals

Provide a responsive, accessible interface that adapts navigation and information to the user's role, organisation, department and team permissions.

## 2. Main screens

- Sign-in and organisation context.
- System administration and tenant management.
- Organisation configuration.
- User, role, department and team management.
- Document repository and upload.
- Document extraction review and policy approval.
- Policy and SLA configuration.
- Support dashboard.
- Ticket intake, queue and detail.
- AI triage panel with confidence, evidence and human review actions.
- Similar tickets and approved knowledge.
- Resolution workspace.
- Approval queue.
- Audit, reports and analytics.

## 3. Interaction requirements

Show original ticket/document content alongside AI-derived information. Distinguish recommendations from approved decisions. Display evidence, uncertainty, rule version and reviewer status. Provide approve, reject, edit and request-more-information actions where authorised.

## 4. UX states and accessibility

Provide loading, empty, validation, error, success and permission-denied states. Support keyboard navigation, visible focus, semantic labels, adequate contrast and responsive layouts. Do not expose inaccessible or unauthorised metrics through client-side cached data.

## 5. Dashboard principles

Agents see their permitted workload and ticket information. Leaders see assigned team operations. Organisation administrators see permitted organisation-level operations. System administrators see platform-level operational information, not unrestricted tenant business data by default.
