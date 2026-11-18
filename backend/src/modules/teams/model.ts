export type Department = {
  id: string;
  organisationId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type Team = {
  id: string;
  organisationId: string;
  departmentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type TeamMembership = {
  id: string;
  organisationId: string;
  teamId: string;
  userId: string;
  role: "support_lead" | "support_agent" | "requester";
  status: "active" | "inactive" | "suspended";
  createdAt: string;
  updatedAt: string;
};

export const isDepartment = (value: unknown): value is Department => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.organisationId === "string" && typeof record.name === "string" &&
    typeof record.createdAt === "string" && typeof record.updatedAt === "string";
};

export const isTeam = (value: unknown): value is Team => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.organisationId === "string" &&
    (record.departmentId === null || typeof record.departmentId === "string") && typeof record.name === "string" &&
    typeof record.createdAt === "string" && typeof record.updatedAt === "string";
};

export const isTeamMembership = (value: unknown): value is TeamMembership => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.organisationId === "string" && typeof record.teamId === "string" &&
    typeof record.userId === "string" && ["support_lead", "support_agent", "requester"].includes(String(record.role)) &&
    ["active", "inactive", "suspended"].includes(String(record.status)) && typeof record.createdAt === "string" && typeof record.updatedAt === "string";
};
