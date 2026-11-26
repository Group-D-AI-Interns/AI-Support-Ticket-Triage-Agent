import { AppError } from "../../shared/errors/app-error.ts";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "../../shared/auth/authentication.ts";
import { insertRecord, mutateRecordById, updateTenantRecords, type JsonFileStorePort } from "../../infrastructure/persistence/json/json-file-store.ts";
import { isEnvelope, isMembership, isUser, type OrganisationMembership } from "../identity/model.ts";
import { isOrganisation, type Organisation, type OrganisationStatus } from "./model.ts";

export interface OrganisationRepository {
  findById(tenant: TenantContext, organisationId: string): Promise<Organisation | null>;
  listForUser(userId: string): Promise<Organisation[]>;
  listAll(): Promise<Organisation[]>;
  create(input: { name: string; settings?: Record<string, unknown> }, administrator: { userId: string; role: "organisation_admin" }): Promise<Organisation>;
  update(tenant: TenantContext, changes: { name?: string; settings?: Record<string, unknown>; status?: OrganisationStatus }): Promise<Organisation>;
}

export class JsonOrganisationRepository implements OrganisationRepository {
  private readonly store: JsonFileStorePort;
  constructor(store: JsonFileStorePort) { this.store = store; }

  async findById(tenant: TenantContext, organisationId: string): Promise<Organisation | null> {
    if (tenant.organisationId !== organisationId) return null;
    return (await this.store.findRecords("organisations.json", isOrganisation, { id: organisationId }))[0] ?? null;
  }

  async listForUser(userId: string): Promise<Organisation[]> {
    const memberships = await this.store.findRecords("memberships.json", isMembership, { userId, status: "active" });
    const ids = memberships.map((item) => item.organisationId);
    if (!ids.length) return [];
    return this.store.findRecords("organisations.json", isOrganisation, { id: { $in: ids }, status: "active" });
  }

  async listAll(): Promise<Organisation[]> {
    return (await this.store.read("organisations.json", isEnvelope(isOrganisation))).records;
  }

  async create(input: { name: string; settings?: Record<string, unknown> }, administrator: { userId: string; role: "organisation_admin" }): Promise<Organisation> {
    const user = (await this.store.findRecords("users.json", isUser, { id: administrator.userId }))[0];
    if (!user || user.status !== "active") {
      throw new AppError(403, "ACCOUNT_INACTIVE", "An active application user is required to create an organisation.");
    }

    const timestamp = new Date().toISOString();
    const record: Organisation = {
      id: `org_${randomUUID()}`,
      name: input.name,
      status: "active",
      settings: input.settings ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const membership: OrganisationMembership = {
      id: `membership_${randomUUID()}`,
      organisationId: record.id,
      userId: administrator.userId,
      status: "active",
      roles: [administrator.role],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await updateTenantRecords<OrganisationMembership, void>(this.store, "memberships.json", record.id, isMembership, memberships => {
      memberships.push(membership);
    });

    try {
      if (this.store.insertRecord) {
        await insertRecord(this.store, "organisations.json", isOrganisation, record);
        return record;
      }
      return await this.store.update("organisations.json", isEnvelope(isOrganisation), (envelope) => {
        if (envelope.records.some((item) => item.name.toLowerCase() === input.name.toLowerCase())) {
          throw new AppError(409, "DUPLICATE_ORGANISATION", "An organisation with this name already exists.");
        }
        envelope.records.push(record);
        return record;
      });
    } catch (error) {
      try {
        await updateTenantRecords<OrganisationMembership, void>(this.store, "memberships.json", record.id, isMembership, memberships => {
          const remaining = memberships.filter(item => item.id !== membership.id);
          memberships.splice(0, memberships.length, ...remaining);
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Organisation creation failed and the provisional administrator membership could not be removed.",
        );
      }
      if (isDuplicateKeyError(error)) throw new AppError(409, "DUPLICATE_ORGANISATION", "An organisation with this name already exists.");
      throw error;
    }
  }

  async update(tenant: TenantContext, changes: { name?: string; settings?: Record<string, unknown>; status?: OrganisationStatus }): Promise<Organisation> {
    try {
      if (this.store.mutateRecord) {
        const updated = await mutateRecordById(this.store, 'organisations.json', tenant.organisationId, isOrganisation, current => {
          if (!current) throw new AppError(404, "NOT_FOUND", "The organisation was not found.");
          const organisation = {
            ...current,
            ...(changes.name !== undefined ? { name: changes.name } : {}),
            ...(changes.settings !== undefined ? { settings: changes.settings } : {}),
            ...(changes.status !== undefined ? { status: changes.status } : {}),
            updatedAt: new Date().toISOString(),
          };
          return { record: organisation, result: organisation };
        });
        if (!updated) throw new AppError(404, "NOT_FOUND", "The organisation was not found.");
        return updated;
      }
      return await this.store.update("organisations.json", isEnvelope(isOrganisation), (envelope) => {
        const index = envelope.records.findIndex((item) => item.id === tenant.organisationId);
        if (index < 0) throw new AppError(404, "NOT_FOUND", "The organisation was not found.");
        const current = envelope.records[index]!;
        if (changes.name !== undefined && envelope.records.some((item) => item.id !== current.id && item.name.toLowerCase() === changes.name!.toLowerCase())) {
          throw new AppError(409, "DUPLICATE_ORGANISATION", "An organisation with this name already exists.");
        }
        envelope.records[index] = {
          ...current,
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.settings !== undefined ? { settings: changes.settings } : {}),
          ...(changes.status !== undefined ? { status: changes.status } : {}),
          updatedAt: new Date().toISOString(),
        };
        return envelope.records[index]!;
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new AppError(409, "DUPLICATE_ORGANISATION", "An organisation with this name already exists.");
      throw error;
    }
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
