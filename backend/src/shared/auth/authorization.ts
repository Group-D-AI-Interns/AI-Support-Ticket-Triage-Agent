import { AppError } from "../errors/app-error.ts";
import type { TenantContext } from "./authentication.ts";

/** Permission identifiers are strings so module owners can consume shared grants without circular imports. */
export type Permission = string;
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

/** Shared permission catalogue derived from the supplied role responsibilities. */
export const ROLE_PERMISSIONS: ReadonlyMap<string, ReadonlySet<Permission>> = new Map([
  [ROLE_IDS.organisationAdmin, new Set([
    "organisation.read", "organisation.update", "organisations.create",
    "users.read", "users.manage", "teams.read", "teams.manage", "teams.members.read",
    "configuration.manage", "queues.read.all", "queues.manage", "tickets.read.all",
    "tickets.ai.review", "tickets.priority.manage", "tickets.routing.manage", "tickets.approve",
    "tickets.resolution.review", "tickets.audit.read", "reports.read.all",
  ])],
  [ROLE_IDS.supportLead, new Set([
    "organisation.read", "teams.read", "teams.members.read", "queues.read.all", "queues.manage",
    "tickets.read.team", "tickets.ai.review", "tickets.priority.manage", "tickets.routing.manage",
    "tickets.approve", "tickets.resolution.review", "tickets.audit.read", "reports.read.team",
  ])],
  [ROLE_IDS.supportAgent, new Set([
    "organisation.read", "teams.read", "queues.read.assigned", "tickets.read.assigned",
    "tickets.ai.review", "tickets.resolution.review",
  ])],
  [ROLE_IDS.requester, new Set(["tickets.create.own", "tickets.read.own"])],
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
