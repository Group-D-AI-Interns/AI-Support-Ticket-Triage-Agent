import type { TenantContext } from "../../shared/auth/authentication.ts";
import type { TeamRepository } from "./repositories.ts";
import type { TeamMembership } from "./model.ts";

export class TeamService {
  private readonly repository: TeamRepository;
  constructor(repository: TeamRepository) { this.repository = repository; }
  listDepartments(tenant: TenantContext) { return this.repository.listDepartments(tenant); }
  createDepartment(tenant: TenantContext, name: string) { return this.repository.createDepartment(tenant, name); }
  listTeams(tenant: TenantContext) { return this.repository.listTeams(tenant); }
  createTeam(tenant: TenantContext, name: string, departmentId: string | null) { return this.repository.createTeam(tenant, name, departmentId); }
  updateTeam(tenant: TenantContext, teamId: string, changes: { name?: string; departmentId?: string | null }) { return this.repository.updateTeam(tenant, teamId, changes); }
  setTeamMembership(tenant: TenantContext, teamId: string, userId: string, role: TeamMembership["role"], status: TeamMembership["status"]) { return this.repository.setTeamMembership(tenant, teamId, userId, role, status); }
  listTeamMemberships(tenant: TenantContext, teamId: string) { return this.repository.listTeamMemberships(tenant, teamId); }
}
