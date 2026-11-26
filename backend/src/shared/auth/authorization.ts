import { AppError } from "../errors/app-error.ts";
import type { TenantContext } from "./authentication.ts";

/** Canonical permissions derived from the supplied project roles and API scope. */
export const PERMISSION_CATALOGUE = {
  "organisation.read": "Read the active organisation context.",
  "organisation.update": "Update permitted organisation settings and status.",
  "organisations.create": "Create an organisation under the approved platform policy.",
  "users.read": "Read users in the active organisation.",
  "users.manage": "Invite users and manage organisation memberships.",
  "teams.read": "Read departments and support teams.",
  "teams.manage": "Create and manage departments, teams, and team memberships.",
  "teams.members.read": "Read active team membership.",
  "documents.read": "Read and download documents in the active organisation.",
  "documents.manage": "Upload, process, and manage documents in the active organisation.",
  "policies.read": "Read policies and their versions in the active organisation.",
  "policies.manage": "Create and revise policies in the active organisation.",
  "policies.candidates.review": "Review extracted policy candidates in the active organisation.",
  "policies.approve": "Approve policy versions in the active organisation.",
  "policies.activate": "Activate approved policy versions in the active organisation.",
  "configuration.manage": "Manage categories, scoring, routing, SLA, and workflow configuration.",
  "queues.read.all": "Read all queues in the active organisation.",
  "queues.read.assigned": "Read queues assigned to the caller.",
  "queues.manage": "Manage queue operations and team work distribution.",
  "tickets.create.own": "Submit tickets as the authenticated requester.",
  "tickets.read.own": "Read tickets submitted by the authenticated requester.",
  "tickets.read.assigned": "Read tickets assigned to the caller's teams.",
  "tickets.read.team": "Read tickets within the caller's support team scope.",
  "tickets.read.all": "Read all tickets in the active organisation.",
  "tickets.ai.review": "Review AI classification and triage recommendations.",
  "tickets.priority.manage": "Set or override ticket priority.",
  "tickets.routing.manage": "Manage ticket routing and team assignment.",
  "tickets.escalate": "Submit a ticket escalation to the support lead queue.",
  "tickets.escalations.read": "Read and manage escalations in the permitted ticket scope.",
  "tickets.approve": "Approve configured consequential ticket actions.",
  "tickets.resolution.review": "Review and edit suggested ticket resolutions.",
  "tickets.audit.read": "Read ticket decision and change history.",
  "reports.read.team": "Read reports scoped to the caller's support teams.",
  "reports.read.all": "Read organisation-wide operational reports.",
} as const;

export type Permission = keyof typeof PERMISSION_CATALOGUE;
export const ROLE_IDS = {
  organisationAdmin: "organisation_admin",
  supportLead: "support_lead",
  supportAgent: "support_agent",
  requester: "requester",
} as const;

export const ROLE_DISPLAY_NAMES: Readonly<Record<string, readonly string[]>> = {
  organisation_admin: ["Administrator", "Organisation Administrator", "System Administrator"],
  support_lead: ["Support Lead", "Team Lead"],
  support_agent: ["Support Agent"],
  requester: ["Requester", "Customer"],
};

/** Public descriptions for the four approved role templates. */
export const ROLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  organisation_admin: "Manages organisation users, teams, configuration, and permitted operational information.",
  support_lead: "Oversees support team queues, routing, priorities, approvals, and operational work.",
  support_agent: "Handles assigned support tickets and reviews applicable AI and resolution recommendations.",
  requester: "Submits tickets and views permitted updates on their own tickets.",
};

/** Returns the shared policy as data for role-aware clients; callers still enforce these permissions server-side. */
export function describeRoleCapabilities(policy: RolePermissionPolicy = applicationAuthorization) {
  return Object.values(ROLE_IDS).map((id) => ({
    id,
    displayNames: [...(ROLE_DISPLAY_NAMES[id] ?? [id])],
    description: ROLE_DESCRIPTIONS[id] ?? "",
    permissions: [...(policy.permissionsFor([id]))].sort().map((permission) => ({
      id: permission,
      description: PERMISSION_CATALOGUE[permission],
    })),
  }));
}

/** Shared permission catalogue derived from the supplied role responsibilities. */
const permissions = (...grants: Permission[]) => new Set<Permission>(grants);

export const ROLE_PERMISSIONS: ReadonlyMap<string, ReadonlySet<Permission>> = new Map([
  [ROLE_IDS.organisationAdmin, permissions(
    "organisation.read", "organisation.update", "organisations.create",
    "users.read", "users.manage", "teams.read", "teams.manage", "teams.members.read",
    "documents.read", "documents.manage", "policies.read", "policies.manage",
    "policies.candidates.review", "policies.approve", "policies.activate",
    "configuration.manage", "queues.read.all", "queues.manage", "tickets.read.all",
    "tickets.ai.review", "tickets.priority.manage", "tickets.routing.manage", "tickets.escalations.read", "tickets.approve",
    "tickets.resolution.review", "tickets.audit.read", "reports.read.all",
  )],
  [ROLE_IDS.supportLead, permissions(
    "organisation.read", "teams.read", "teams.members.read", "queues.read.all", "queues.manage",
    "tickets.read.team", "tickets.ai.review", "tickets.priority.manage", "tickets.routing.manage", "tickets.escalations.read",
    "tickets.approve", "tickets.resolution.review", "tickets.audit.read", "reports.read.team",
  )],
  [ROLE_IDS.supportAgent, permissions(
    "organisation.read", "teams.read", "queues.read.assigned", "tickets.read.assigned",
    "tickets.ai.review", "tickets.resolution.review", "tickets.escalate",
  )],
  [ROLE_IDS.requester, permissions("tickets.create.own", "tickets.read.own")],
]);

export interface RolePermissionPolicy {
  permissionsFor(roles: readonly string[]): ReadonlySet<Permission>;
}

export class DenyByDefaultAuthorization implements RolePermissionPolicy {
  permissionsFor(_roles: readonly string[]): ReadonlySet<Permission> {
    return new Set();
  }
}

export class RolePermissionAuthorization implements RolePermissionPolicy {
  private readonly rolePermissions: ReadonlyMap<string, ReadonlySet<Permission>>;
  constructor(rolePermissions: ReadonlyMap<string, ReadonlySet<Permission>>) { this.rolePermissions = rolePermissions; }
  permissionsFor(roles: readonly string[]): ReadonlySet<Permission> {
    const permissions = new Set<Permission>();
    for (const role of roles) for (const permission of this.rolePermissions.get(role) ?? []) permissions.add(permission);
    return permissions;
  }
}

export const applicationAuthorization = new RolePermissionAuthorization(ROLE_PERMISSIONS);

export function requirePermission(policy: RolePermissionPolicy, tenant: TenantContext, permission: Permission): void {
  if (!policy.permissionsFor(tenant.roles).has(permission)) {
    throw new AppError(403, "FORBIDDEN", "You do not have permission to perform this action.");
  }
}
