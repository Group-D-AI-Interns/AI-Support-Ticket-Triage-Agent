import { AppError } from "../../shared/errors/app-error.ts";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "../../shared/auth/authentication.ts";
import { JsonFileStore } from "../../infrastructure/persistence/json/json-file-store.ts";
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
  private readonly store: JsonFileStore;
  constructor(store: JsonFileStore) { this.store = store; }

  async findById(tenant: TenantContext, organisationId: string): Promise<Organisation | null> {
    if (tenant.organisationId !== organisationId) return null;
    return (await this.store.read("organisations.json", isEnvelope(isOrganisation))).records.find((item) => item.id === organisationId) ?? null;
  }

  async listForUser(userId: string): Promise<Organisation[]> {
    const memberships = (await this.store.read("memberships.json", isEnvelope(isMembership))).records
      .filter((item) => item.userId === userId && item.status === "active");
    const ids = new Set(memberships.map((item) => item.organisationId));
    return (await this.store.read("organisations.json", isEnvelope(isOrganisation))).records.filter((item) => ids.has(item.id) && item.status === "active");
  }

  async listAll(): Promise<Organisation[]> {
    return (await this.store.read("organisations.json", isEnvelope(isOrganisation))).records;
  }

  async create(input: { name: string; settings?: Record<string, unknown> }, administrator: { userId: string; role: "organisation_admin" }): Promise<Organisation> {
    const user = (await this.store.read("users.json", isEnvelope(isUser))).records
      .find((record) => record.id === administrator.userId);
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

    await this.store.update("memberships.json", isEnvelope(isMembership), (envelope) => {
      envelope.records.push(membership);
    });

    try {
      return await this.store.update("organisations.json", isEnvelope(isOrganisation), (envelope) => {
        if (envelope.records.some((item) => item.name.toLowerCase() === input.name.toLowerCase())) {
          throw new AppError(409, "DUPLICATE_ORGANISATION", "An organisation with this name already exists.");
        }
        envelope.records.push(record);
        return record;
      });
    } catch (error) {
      try {
        await this.store.update("memberships.json", isEnvelope(isMembership), (envelope) => {
          envelope.records = envelope.records.filter((item) => item.id !== membership.id);
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Organisation creation failed and the provisional administrator membership could not be removed.",
        );
      }
      throw error;
    }
  }

  async update(tenant: TenantContext, changes: { name?: string; settings?: Record<string, unknown>; status?: OrganisationStatus }): Promise<Organisation> {
    return this.store.update("organisations.json", isEnvelope(isOrganisation), (envelope) => {
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
  }
}
