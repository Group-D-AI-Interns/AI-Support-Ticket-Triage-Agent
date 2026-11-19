import { AppError } from "../../shared/errors/app-error.ts";
import { IdentityProviderError, type IdentityProvisioningProvider, type TenantContext, type TenantResolver } from "../../shared/auth/authentication.ts";
import type { IdentityRepository } from "./repositories.ts";
import type { OrganisationMembership } from "./model.ts";

export class IdentityService implements TenantResolver {
  private readonly repository: IdentityRepository;
  private readonly provisioner: IdentityProvisioningProvider | undefined;
  constructor(repository: IdentityRepository, provisioner?: IdentityProvisioningProvider) { this.repository = repository; this.provisioner = provisioner; }

  async resolve(userId: string, organisationId: string): Promise<TenantContext | null> {
    const [user, membership, organisationStatus] = await Promise.all([
      this.repository.findUserById(userId),
      this.repository.findMembership(organisationId, userId),
      this.repository.findOrganisationStatus(organisationId),
    ]);
    if (!user || user.status !== "active" || !membership || membership.status !== "active" || organisationStatus !== "active") return null;
    return { organisationId, userId, roles: [...membership.roles] };
  }

  async resolveForOrganisationManagement(userId: string, organisationId: string): Promise<TenantContext | null> {
    const [user, membership, organisationStatus] = await Promise.all([
      this.repository.findUserById(userId),
      this.repository.findMembership(organisationId, userId),
      this.repository.findOrganisationStatus(organisationId),
    ]);
    if (!user || user.status !== "active" || !membership || membership.status !== "active" || organisationStatus === null) return null;
    return { organisationId, userId, roles: [...membership.roles] };
  }

  async currentUser(userId: string, organisationId?: string) {
    const user = await this.repository.findUserById(userId);
    if (!user || user.status !== "active") throw new AppError(403, "ACCOUNT_INACTIVE", "This account is not active.");
    if (!organisationId) {
      const memberships = await this.repository.listMemberships(userId);
      const organisations = await Promise.all(memberships.map(async (membership) => {
        const tenant = await this.resolve(userId, membership.organisationId);
        return tenant ? { organisationId: tenant.organisationId, roles: tenant.roles } : null;
      }));
      return { user, organisations: organisations.filter((value): value is { organisationId: string; roles: string[] } => value !== null) };
    }
    const tenant = await this.resolve(userId, organisationId);
    if (!tenant) throw new AppError(403, "ORGANISATION_ACCESS_DENIED", "You do not have access to this organisation.");
    return { user, organisations: [{ organisationId, roles: tenant.roles }] };
  }

  async listUsers(tenant: TenantContext) {
    const [users, memberships] = await Promise.all([
      this.repository.listUsersForTenant(tenant),
      this.repository.listMembershipsForTenant(tenant),
    ]);
    const rolesByUserId = new Map(memberships.map((membership) => [membership.userId, membership.roles]));
    return users.flatMap((user) => {
      const roles = rolesByUserId.get(user.id);
      return roles ? [{ user, roles: [...roles] }] : [];
    });
  }

  async updateUser(tenant: TenantContext, userId: string, changes: { displayName?: string }) {
    const member = await this.repository.findMembership(tenant.organisationId, userId);
    if (!member || member.status !== "active") throw new AppError(404, "NOT_FOUND", "The user was not found in this organisation.");
    if (!this.provisioner) throw new AppError(503, "IDENTITY_PROVISIONING_UNAVAILABLE", "Keycloak user management is not configured.");
    try {
      await this.provisioner.updateUser(userId, changes);
      return await this.repository.updateUser(userId, changes);
    } catch {
      throw new AppError(503, "IDENTITY_PROVISIONING_FAILED", "The user profile could not be updated.");
    }
  }

  async getUser(tenant: TenantContext, userId: string) {
    const user = await this.repository.findUserForTenant(tenant, userId);
    if (!user) throw new AppError(404, "NOT_FOUND", "The user was not found in this organisation.");
    return user;
  }

  async getMembership(tenant: TenantContext, userId: string) {
    const membership = await this.repository.findMembership(tenant.organisationId, userId);
    if (!membership || membership.status !== "active") throw new AppError(404, "NOT_FOUND", "The user was not found in this organisation.");
    return membership;
  }

  async setMembership(tenant: TenantContext, userId: string, status: "active" | "inactive" | "suspended", roles: OrganisationMembership["roles"]) {
    return this.repository.setMembership(tenant, userId, status, roles);
  }

  async inviteUser(tenant: TenantContext, email: string, displayName: string, roles: OrganisationMembership["roles"]) {
    if (!this.provisioner) throw new AppError(503, "IDENTITY_PROVISIONING_UNAVAILABLE", "Keycloak user provisioning is not configured.");
    let invited: { userId: string };
    try {
      invited = await this.provisioner.inviteUser({ email, displayName });
    } catch (error) {
      if (error instanceof IdentityProviderError) throw new AppError(error.statusCode, error.code, error.message);
      throw new AppError(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Keycloak could not create the invitation.");
    }
    try {
      const user = await this.repository.createProvisionedUser(invited.userId, email, displayName);
      const membership = await this.repository.setMembership(tenant, user.id, "active", roles);
      return { user, membership };
    } catch (error) {
      await this.repository.removeMembership(tenant.organisationId, invited.userId).catch(() => undefined);
      await this.repository.removeProvisionedUser(invited.userId).catch(() => undefined);
      await this.provisioner.deleteUser(invited.userId).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(503, "IDENTITY_PROVISIONING_FAILED", "The account invitation could not be saved.");
    }
  }
}
