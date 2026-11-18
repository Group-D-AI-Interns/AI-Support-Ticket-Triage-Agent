export type UserStatus = "active" | "inactive" | "suspended";
export type MembershipStatus = "active" | "inactive" | "suspended";

export type User = {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
};

export type OrganisationMembership = {
  id: string;
  organisationId: string;
  userId: string;
  status: MembershipStatus;
  roles: string[];
  createdAt: string;
  updatedAt: string;
};

export function isEnvelope<T>(isRecord: (value: unknown) => value is T) {
  return (value: unknown): value is { schemaVersion: 1; records: T[] } => {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as { schemaVersion?: unknown; records?: unknown };
    return candidate.schemaVersion === 1 && Array.isArray(candidate.records) && candidate.records.every(isRecord);
  };
}

const isTimestamp = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));
export const isUser = (value: unknown): value is User => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.email === "string" && typeof record.displayName === "string" &&
    ["active", "inactive", "suspended"].includes(String(record.status)) && isTimestamp(record.createdAt) && isTimestamp(record.updatedAt);
};
export const isMembership = (value: unknown): value is OrganisationMembership => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.organisationId === "string" && typeof record.userId === "string" &&
    ["active", "inactive", "suspended"].includes(String(record.status)) && Array.isArray(record.roles) && record.roles.every((role) => typeof role === "string") &&
    isTimestamp(record.createdAt) && isTimestamp(record.updatedAt);
};
