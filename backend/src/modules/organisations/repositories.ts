import { AppError } from "../../shared/errors/app-error.ts";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "../../shared/auth/authentication.ts";
import { JsonFileStore } from "../../infrastructure/persistence/json/json-file-store.ts";
import { isEnvelope, isMembership } from "../identity/model.ts";
import { isOrganisation, type Organisation, type OrganisationStatus } from "./model.ts";

export interface OrganisationRepository {
  findById(tenant: TenantContext, organisationId: string): Promise<Organisation | null>;
  listForUser(userId: string): Promise<Organisation[]>;
  listAll(): Promise<Organisation[]>;
  create(input: { name: string; settings?: Record<string, unknown> }): Promise<Organisation>;
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

  async create(input: { name: string; settings?: Record<string, unknown> }): Promise<Organisation> {
    return this.store.update("organisations.json", isEnvelope(isOrganisation), (envelope) => {
      if (envelope.records.some((item) => item.name.toLowerCase() === input.name.toLowerCase())) {
        throw new AppError(409, "DUPLICATE_ORGANISATION", "An organisation with this name already exists.");
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
      envelope.records.push(record);
      return record;
    });
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
