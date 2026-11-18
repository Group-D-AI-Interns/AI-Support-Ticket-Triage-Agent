import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.ts";
import { JsonFileStore } from "../../infrastructure/persistence/json/json-file-store.ts";
import { isEnvelope, isMembership, isUser, type OrganisationMembership, type User } from "./model.ts";
import type { TenantContext } from "../../shared/auth/authentication.ts";
import { isOrganisation, type OrganisationStatus } from "../organisations/model.ts";

export interface IdentityRepository {
  findUserById(userId: string): Promise<User | null>;
  findOrganisationStatus(organisationId: string): Promise<OrganisationStatus | null>;
  listUsersForTenant(tenant: TenantContext): Promise<User[]>;
  findMembership(organisationId: string, userId: string): Promise<OrganisationMembership | null>;
  listMemberships(userId: string): Promise<OrganisationMembership[]>;
  updateUser(userId: string, changes: { displayName?: string; status?: User["status"] }): Promise<User>;
  setMembership(tenant: TenantContext, userId: string, status: OrganisationMembership["status"], roles: OrganisationMembership["roles"]): Promise<OrganisationMembership>;
  findUserForTenant(tenant: TenantContext, userId: string): Promise<User | null>;
  createProvisionedUser(userId: string, email: string, displayName: string): Promise<User>;
  removeProvisionedUser(userId: string): Promise<void>;
  removeMembership(organisationId: string, userId: string): Promise<void>;
}

export class JsonIdentityRepository implements IdentityRepository {
  private readonly store: JsonFileStore;
  constructor(store: JsonFileStore) { this.store = store; }

  async findUserById(userId: string): Promise<User | null> {
    return (await this.store.read("users.json", isEnvelope(isUser))).records.find((user) => user.id === userId) ?? null;
  }

  async findOrganisationStatus(organisationId: string): Promise<OrganisationStatus | null> {
    const organisations = (await this.store.read("organisations.json", isEnvelope(isOrganisation))).records;
    return organisations.find((organisation) => organisation.id === organisationId)?.status ?? null;
  }

  async listUsersForTenant(tenant: TenantContext): Promise<User[]> {
    const memberships = (await this.store.read("memberships.json", isEnvelope(isMembership))).records
      .filter((membership) => membership.organisationId === tenant.organisationId && membership.status === "active");
    const ids = new Set(memberships.map((membership) => membership.userId));
    return (await this.store.read("users.json", isEnvelope(isUser))).records
      .filter((user) => ids.has(user.id) && user.status === "active");
  }

  async listMemberships(userId: string): Promise<OrganisationMembership[]> {
    return (await this.store.read("memberships.json", isEnvelope(isMembership))).records
      .filter((membership) => membership.userId === userId && membership.status === "active");
  }

  async findMembership(organisationId: string, userId: string): Promise<OrganisationMembership | null> {
    const memberships = (await this.store.read("memberships.json", isEnvelope(isMembership))).records;
    const matches = memberships.filter((item) => item.organisationId === organisationId && item.userId === userId);
    if (matches.length > 1) throw new AppError(500, "DATA_INTEGRITY_ERROR", "Organisation membership data is inconsistent.");
    return matches[0] ?? null;
  }

  async updateUser(userId: string, changes: { displayName?: string; status?: User["status"] }): Promise<User> {
    return this.store.update("users.json", isEnvelope(isUser), (envelope) => {
      const index = envelope.records.findIndex((user) => user.id === userId);
      if (index < 0) throw new AppError(404, "NOT_FOUND", "The user was not found.");
      const current = envelope.records[index]!;
      envelope.records[index] = { ...current, ...changes, updatedAt: new Date().toISOString() };
      return envelope.records[index]!;
    });
  }

  async setMembership(tenant: TenantContext, userId: string, status: OrganisationMembership["status"], roles: OrganisationMembership["roles"]): Promise<OrganisationMembership> {
    const users = (await this.store.read("users.json", isEnvelope(isUser))).records;
    const user = users.find((candidate) => candidate.id === userId);
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "The user was not found.");
    if (status === "active" && user.status !== "active") throw new AppError(400, "ACCOUNT_INACTIVE", "An inactive account cannot be activated as an organisation member.");
    return this.store.update("memberships.json", isEnvelope(isMembership), (envelope) => {
      const matches = envelope.records.filter((membership) => membership.organisationId === tenant.organisationId && membership.userId === userId);
      if (matches.length > 1) throw new AppError(500, "DATA_INTEGRITY_ERROR", "Organisation membership data is inconsistent.");
      const timestamp = new Date().toISOString();
      const existing = matches[0];
      if (existing) {
        const index = envelope.records.indexOf(existing);
        envelope.records[index] = { ...existing, status, roles: [...roles], updatedAt: timestamp };
        return envelope.records[index]!;
      }
      const membership: OrganisationMembership = {
        id: `membership_${randomUUID()}`,
        organisationId: tenant.organisationId,
        userId,
        status,
        roles: [...roles],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      envelope.records.push(membership);
      return membership;
    });
  }

  async findUserForTenant(tenant: TenantContext, userId: string): Promise<User | null> {
    const membership = await this.findMembership(tenant.organisationId, userId);
    if (!membership || membership.status !== "active") return null;
    const user = await this.findUserById(userId);
    return user?.status === "active" ? user : null;
  }

  async createProvisionedUser(userId: string, email: string, displayName: string): Promise<User> {
    return this.store.update("users.json", isEnvelope(isUser), (envelope) => {
      if (envelope.records.some((user) => user.id === userId || user.email.toLowerCase() === email.toLowerCase())) {
        throw new AppError(409, "USER_ALREADY_EXISTS", "A user with this identity or email already exists.");
      }
      const timestamp = new Date().toISOString();
      const user: User = { id: userId, email, displayName, status: "active", createdAt: timestamp, updatedAt: timestamp };
      envelope.records.push(user);
      return user;
    });
  }

  async removeProvisionedUser(userId: string): Promise<void> {
    await this.store.update("users.json", isEnvelope(isUser), (envelope) => {
      envelope.records = envelope.records.filter((user) => user.id !== userId);
    });
  }

  async removeMembership(organisationId: string, userId: string): Promise<void> {
    await this.store.update("memberships.json", isEnvelope(isMembership), (envelope) => {
      envelope.records = envelope.records.filter((membership) => membership.organisationId !== organisationId || membership.userId !== userId);
    });
  }
}
