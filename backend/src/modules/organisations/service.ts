import { AppError } from "../../shared/errors/app-error.ts";
import type { TenantContext } from "../../shared/auth/authentication.ts";
import type { OrganisationRepository } from "./repositories.ts";
import type { OrganisationStatus } from "./model.ts";

export class OrganisationService {
  private readonly repository: OrganisationRepository;
  constructor(repository: OrganisationRepository) { this.repository = repository; }

  async get(tenant: TenantContext, organisationId: string) {
    const organisation = await this.repository.findById(tenant, organisationId);
    if (!organisation || organisation.status !== "active") throw new AppError(404, "NOT_FOUND", "The organisation was not found.");
    return organisation;
  }

  listForUser(userId: string) { return this.repository.listForUser(userId); }
  listAll() { return this.repository.listAll(); }
  create(input: { name: string; settings?: Record<string, unknown> }, administrator: { userId: string; role: "organisation_admin" }) {
    return this.repository.create(input, administrator);
  }

  update(tenant: TenantContext, changes: { name?: string; settings?: Record<string, unknown>; status?: OrganisationStatus }) {
    return this.repository.update(tenant, changes);
  }
}
