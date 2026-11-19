import type { IncomingMessage } from "node:http";
import type { AuthenticationProvider, AuthenticatedPrincipal, TenantContext, TenantResolver } from "../auth/authentication.ts";
import { AppError } from "../errors/app-error.ts";
import { requireTenant } from "../tenancy/tenant-resolution.ts";

export async function requireAuthenticatedPrincipal(provider: AuthenticationProvider | undefined, request: IncomingMessage) {
  if (!provider) throw new AppError(503, "AUTHENTICATION_NOT_CONFIGURED", "Authentication is not configured.");
  let principal: AuthenticatedPrincipal | null;
  try {
    principal = await provider.authenticate(request);
  } catch {
    throw new AppError(503, "AUTH_PROVIDER_UNAVAILABLE", "The authentication provider is temporarily unavailable.");
  }
  if (!principal || typeof principal.userId !== "string" || !principal.userId.trim()) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication is required.");
  }
  return principal;
}

export function requireTenantContext(resolver: TenantResolver, userId: string, organisationId: string): Promise<TenantContext> {
  return requireTenant(resolver, userId, organisationId);
}
