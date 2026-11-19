import { AppError } from "../errors/app-error.ts";
import type { TenantContext, TenantResolver } from "../auth/authentication.ts";

export async function requireTenant(
  resolver: TenantResolver,
  userId: string,
  organisationId: string,
): Promise<TenantContext> {
  const tenant = await resolver.resolve(userId, organisationId);
  if (!tenant) throw new AppError(403, "ORGANISATION_ACCESS_DENIED", "You do not have access to this organisation.");
  return tenant;
}
