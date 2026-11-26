export type UserStatus = "active" | "inactive" | "suspended";
export type MembershipStatus = UserStatus;
export type OrganisationStatus = UserStatus;
export type RoleId = "organisation_admin" | "support_lead" | "support_agent" | "requester";

export type User = { id: string; email: string; displayName: string; status: UserStatus };
export type Organisation = {
  id: string;
  name: string;
  status: OrganisationStatus;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
export type OrganisationContext = { organisationId: string; roles: string[]; permissions: string[] };
export type CurrentUser = { user: User; organisations: OrganisationContext[] };
export type UserListItem = User & { roles: string[]; permissions: string[] };
export type UserDetail = User & { roles: string[]; permissions: string[] };
export type RoleCapability = {
  id: RoleId;
  displayNames: string[];
  description: string;
  permissions: { id: string; description: string }[];
};
export type Department = { id: string; organisationId: string; name: string; createdAt: string; updatedAt: string };
export type Team = { id: string; organisationId: string; departmentId: string | null; name: string; createdAt: string; updatedAt: string };
export type TeamMembership = {
  id: string;
  organisationId: string;
  teamId: string;
  userId: string;
  role: "support_lead" | "support_agent" | "requester";
  status: MembershipStatus;
  createdAt: string;
  updatedAt: string;
};
export type PageResult<T> = { data: T[]; pagination: { page: number; pageSize: number; total: number }; requestId: string };
export type ApiEnvelope<T> = { data: T; requestId: string };
export type ApiFailure = { error: { code: string; message: string; requestId: string; fields?: { field: string; message: string }[] } };
