import type { IncomingMessage } from "node:http";

export type AuthenticatedPrincipal = {
  userId: string;
};

/** Verifies a bearer access token and returns its stable external subject. */
export interface AuthenticationProvider {
  authenticate(request: IncomingMessage): Promise<AuthenticatedPrincipal | null>;
}

export interface IdentityProvisioningProvider {
  inviteUser(input: { email: string; displayName: string }): Promise<{ userId: string }>;
  updateUser(userId: string, changes: { displayName?: string }): Promise<void>;
  deleteUser(userId: string): Promise<void>;
}

export class IdentityProviderError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "IdentityProviderError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type TenantContext = {
  organisationId: string;
  userId: string;
  roles: string[];
};

/** Membership lookup must be backed by server-side records, never request tenant input. */
export interface TenantResolver {
  resolve(userId: string, organisationId: string): Promise<TenantContext | null>;
  /** Management-only resolution may allow an active member to restore an inactive tenant. */
  resolveForOrganisationManagement?(userId: string, organisationId: string): Promise<TenantContext | null>;
}

export type PermissionChecker = {
  hasPermission(tenant: TenantContext, permission: string): boolean;
};
