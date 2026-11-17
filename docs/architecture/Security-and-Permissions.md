# Security and Permissions Design

## 1. Security principles

Least privilege, deny-by-default authorisation, tenant isolation, data minimisation, secure secrets, validated inputs and auditable privileged actions.

## 2. Roles

- System Administrator: platform-level tenant and system administration.
- Support Leader: assigned team operations, team reports, coaching and own leadership performance.
- Support Agent: assigned tickets, applicable knowledge and own performance.
- Requester: own permitted ticket submission and status access.

Map these role templates to actual permissions and organisational custom roles.

## 3. Authorisation checks

For every request verify authenticated identity, organisation membership, resource tenant, ownership/team scope, action permission and any approval requirement. UI hiding is not an authorisation control.

## 4. Tenant isolation

Apply tenant constraints to database access, object storage, vector search, background jobs, caches, analytics, exports and logs. Add automated negative tests proving one tenant cannot access another tenant's records.

## 5. File and AI security

Validate upload size/type/content; store privately; scan where available; use authorised downloads. Treat file text and retrieved content as untrusted. Protect against prompt injection, data exfiltration and cross-tenant retrieval. Minimise sensitive data in model prompts.

## 6. Audit and privacy

Record actor, tenant, action, target, timestamp, reason and before/after values for material changes. Define retention and deletion policies. Restrict access to employee performance data and sensitive ticket content.
