export type WorkspaceView = "overview" | "users" | "organisations" | "teams" | "dashboard" | "tickets" | "reports" | "audit" | "configuration";

const supportPermissions = ["tickets.create.own", "tickets.read.own", "tickets.read.assigned", "tickets.read.team", "tickets.read.all"];
const foundationPermissions = ["users.read", "teams.manage", "organisations.create"];

export function hasSupportWorkspacePermission(permissions: readonly string[]): boolean {
  return permissions.some(permission => supportPermissions.includes(permission));
}

export function hasFoundationWorkspacePermission(permissions: readonly string[]): boolean {
  return permissions.some(permission => foundationPermissions.includes(permission));
}

export function landingView(permissions: readonly string[]): WorkspaceView {
  const hasSupport = hasSupportWorkspacePermission(permissions);
  const hasFoundation = hasFoundationWorkspacePermission(permissions);
  if (permissions.includes("reports.read.team")) return "dashboard";
  return hasSupport && !hasFoundation ? "tickets" : "overview";
}

export function visibleWorkspaceNavigation(
  permissions: readonly string[],
  hasSupportWorkspace: boolean,
  hasFoundationWorkspace: boolean,
): WorkspaceView[] {
  const can = (permission: string) => permissions.includes(permission);
  const support = ["dashboard", "tickets"] as const;
  const visible: WorkspaceView[] = [];
  if (hasSupportWorkspace) visible.push(...support);
  if (can("reports.read.team") || can("reports.read.all")) visible.push("reports");
  if (can("tickets.audit.read")) visible.push("audit");
  if (can("configuration.manage")) visible.push("configuration");
  if (hasFoundationWorkspace) {
    visible.push("overview");
    if (can("users.read")) visible.push("users");
    if (can("organisation.read")) visible.push("organisations");
    if (can("teams.read")) visible.push("teams");
  }
  return [...new Set(visible)];
}
