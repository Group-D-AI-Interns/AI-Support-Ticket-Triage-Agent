import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.ts";
import { insertRecord, mutateRecordById, updateTenantRecords, type JsonFileStorePort } from "../../infrastructure/persistence/json/json-file-store.ts";
import { isEnvelope, isMembership, isUser, type OrganisationMembership, type User } from "./model.ts";
import type { TenantContext } from "../../shared/auth/authentication.ts";
import { isOrganisation, type OrganisationStatus } from "../organisations/model.ts";

export interface IdentityRepository {
  findUserById(userId: string): Promise<User | null>;
  findOrganisationStatus(organisationId: string): Promise<OrganisationStatus | null>;
  listUsersForTenant(tenant: TenantContext): Promise<User[]>;
  listMembershipsForTenant(tenant: TenantContext): Promise<OrganisationMembership[]>;
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
  private readonly store: JsonFileStorePort;
  constructor(store: JsonFileStorePort) { this.store = store; }

  async findUserById(userId: string): Promise<User | null> {
    return (await this.store.findRecords("users.json", isUser, { id: userId }))[0] ?? null;
  }

  async findOrganisationStatus(organisationId: string): Promise<OrganisationStatus | null> {
    const organisation = (await this.store.findRecords("organisations.json", isOrganisation, { id: organisationId }))[0];
    return organisation?.status ?? null;
  }

  async listUsersForTenant(tenant: TenantContext): Promise<User[]> {
    const memberships = await this.store.findRecords("memberships.json", isMembership, {
      organisationId: tenant.organisationId,
      status: "active",
    });
    const ids = memberships.map((membership) => membership.userId);
    if (!ids.length) return [];
    return this.store.findRecords("users.json", isUser, { id: { $in: ids }, status: "active" });
  }

  async listMembershipsForTenant(tenant: TenantContext): Promise<OrganisationMembership[]> {
    return this.store.findRecords("memberships.json", isMembership, {
      organisationId: tenant.organisationId,
      status: "active",
    });
  }

  async listMemberships(userId: string): Promise<OrganisationMembership[]> {
    return this.store.findRecords("memberships.json", isMembership, { userId, status: "active" });
  }

  async findMembership(organisationId: string, userId: string): Promise<OrganisationMembership | null> {
    const matches = await this.store.findRecords("memberships.json", isMembership, { organisationId, userId });
    if (matches.length > 1) throw new AppError(500, "DATA_INTEGRITY_ERROR", "Organisation membership data is inconsistent.");
    return matches[0] ?? null;
  }

  async updateUser(userId: string, changes: { displayName?: string; status?: User["status"] }): Promise<User> {
    if (this.store.mutateRecord) {
      const updated = await mutateRecordById(this.store, 'users.json', userId, isUser, current => {
        if (!current) throw new AppError(404, "NOT_FOUND", "The user was not found.");
        const user = { ...current, ...changes, updatedAt: new Date().toISOString() };
        return { record: user, result: user };
      });
      if (!updated) throw new AppError(404, "NOT_FOUND", "The user was not found.");
      return updated;
    }
    return this.store.update("users.json", isEnvelope(isUser), (envelope) => {
      const index = envelope.records.findIndex((user) => user.id === userId);
      if (index < 0) throw new AppError(404, "NOT_FOUND", "The user was not found.");
      const current = envelope.records[index]!;
      envelope.records[index] = { ...current, ...changes, updatedAt: new Date().toISOString() };
      return envelope.records[index]!;
    });
  }

  async setMembership(tenant: TenantContext, userId: string, status: OrganisationMembership["status"], roles: OrganisationMembership["roles"]): Promise<OrganisationMembership> {
    const user = (await this.store.findRecords("users.json", isUser, { id: userId }))[0];
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "The user was not found.");
    if (status === "active" && user.status !== "active") throw new AppError(400, "ACCOUNT_INACTIVE", "An inactive account cannot be activated as an organisation member.");
    return updateTenantRecords<OrganisationMembership, OrganisationMembership>(this.store, "memberships.json", tenant.organisationId, isMembership, memberships => {
      const matches = memberships.filter((membership) => membership.userId === userId);
      if (matches.length > 1) throw new AppError(500, "DATA_INTEGRITY_ERROR", "Organisation membership data is inconsistent.");
      const timestamp = new Date().toISOString();
      const existing = matches[0];
      if (existing) {
        const index = memberships.indexOf(existing);
        memberships[index] = { ...existing, status, roles: [...roles], updatedAt: timestamp };
        return memberships[index]!;
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
      memberships.push(membership);
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
    try {
      if (this.store.insertRecord) {
        const timestamp = new Date().toISOString();
        const user: User = { id: userId, email, displayName, status: "active", createdAt: timestamp, updatedAt: timestamp };
        await insertRecord(this.store, "users.json", isUser, user);
        return user;
      }
      return await this.store.update("users.json", isEnvelope(isUser), (envelope) => {
        if (envelope.records.some((user) => user.id === userId || user.email.toLowerCase() === email.toLowerCase())) {
          throw new AppError(409, "USER_ALREADY_EXISTS", "A user with this identity or email already exists.");
        }
        const timestamp = new Date().toISOString();
        const user: User = { id: userId, email, displayName, status: "active", createdAt: timestamp, updatedAt: timestamp };
        envelope.records.push(user);
        return user;
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new AppError(409, "USER_ALREADY_EXISTS", "A user with this identity or email already exists.");
      throw error;
    }
  }

  async removeProvisionedUser(userId: string): Promise<void> {
    if (this.store.mutateRecord) {
      await mutateRecordById(this.store, 'users.json', userId, isUser, () => ({ record: null, result: undefined }));
      return;
    }
    await this.store.update("users.json", isEnvelope(isUser), (envelope) => {
      envelope.records = envelope.records.filter((user) => user.id !== userId);
    });
  }

  async removeMembership(organisationId: string, userId: string): Promise<void> {
    await updateTenantRecords<OrganisationMembership, void>(this.store, "memberships.json", organisationId, isMembership, memberships => {
      const remaining = memberships.filter(membership => membership.userId !== userId);
      memberships.splice(0, memberships.length, ...remaining);
    });
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if ((current as { code?: unknown }).code === 11000) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
