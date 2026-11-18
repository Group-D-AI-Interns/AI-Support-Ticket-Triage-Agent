export type OrganisationStatus = "active" | "inactive" | "suspended";

export type Organisation = {
  id: string;
  name: string;
  status: OrganisationStatus;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export const isOrganisation = (value: unknown): value is Organisation => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.name === "string" && record.name.trim().length > 0 &&
    ["active", "inactive", "suspended"].includes(String(record.status)) && typeof record.settings === "object" && record.settings !== null &&
    typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt)) &&
    typeof record.updatedAt === "string" && !Number.isNaN(Date.parse(record.updatedAt));
};
