import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.ts";
import type { TenantContext } from "../../shared/auth/authentication.ts";
import { JsonFileStore } from "../../infrastructure/persistence/json/json-file-store.ts";
import { isEnvelope, isMembership, isUser } from "../identity/model.ts";
import { isDepartment, isTeam, isTeamMembership, type Department, type Team, type TeamMembership } from "./model.ts";

export interface TeamRepository {
  listDepartments(tenant: TenantContext): Promise<Department[]>;
  createDepartment(tenant: TenantContext, name: string): Promise<Department>;
  listTeams(tenant: TenantContext): Promise<Team[]>;
  createTeam(tenant: TenantContext, name: string, departmentId: string | null): Promise<Team>;
  updateTeam(tenant: TenantContext, teamId: string, changes: { name?: string; departmentId?: string | null }): Promise<Team>;
  setTeamMembership(tenant: TenantContext, teamId: string, userId: string, role: TeamMembership["role"], status: TeamMembership["status"]): Promise<TeamMembership>;
  listTeamMemberships(tenant: TenantContext, teamId: string): Promise<TeamMembership[]>;
  listTeamIdsForUser(tenant: TenantContext, userId: string): Promise<string[]>;
}

export class JsonTeamRepository implements TeamRepository {
  private readonly store: JsonFileStore;
  constructor(store: JsonFileStore) { this.store = store; }

  async listDepartments(tenant: TenantContext): Promise<Department[]> {
    return (await this.store.read("departments.json", isEnvelope(isDepartment))).records
      .filter((department) => department.organisationId === tenant.organisationId);
  }

  async createDepartment(tenant: TenantContext, name: string): Promise<Department> {
    return this.store.update("departments.json", isEnvelope(isDepartment), (envelope) => {
      const records = envelope.records;
      if (records.some((item) => item.organisationId === tenant.organisationId && item.name.toLowerCase() === name.toLowerCase())) {
        throw new AppError(409, "DUPLICATE_DEPARTMENT", "A department with this name already exists.");
      }
      const timestamp = new Date().toISOString();
      const department = { id: `dept_${randomUUID()}`, organisationId: tenant.organisationId, name, createdAt: timestamp, updatedAt: timestamp };
      records.push(department);
      return department;
    });
  }

  async listTeams(tenant: TenantContext): Promise<Team[]> {
    return (await this.store.read("teams.json", isEnvelope(isTeam))).records
      .filter((team) => team.organisationId === tenant.organisationId);
  }

  async createTeam(tenant: TenantContext, name: string, departmentId: string | null): Promise<Team> {
    return this.store.update("teams.json", isEnvelope(isTeam), async (envelope) => {
      const records = envelope.records;
      if (departmentId) {
        const departments = (await this.store.read("departments.json", isEnvelope(isDepartment))).records;
        if (!departments.some((department) => department.id === departmentId && department.organisationId === tenant.organisationId)) {
          throw new AppError(400, "INVALID_DEPARTMENT", "The department does not belong to this organisation.");
        }
      }
      if (records.some((item) => item.organisationId === tenant.organisationId && item.name.toLowerCase() === name.toLowerCase())) {
        throw new AppError(409, "DUPLICATE_TEAM", "A team with this name already exists.");
      }
      const timestamp = new Date().toISOString();
      const team = { id: `team_${randomUUID()}`, organisationId: tenant.organisationId, departmentId, name, createdAt: timestamp, updatedAt: timestamp };
      records.push(team);
      return team;
    });
  }

  async updateTeam(tenant: TenantContext, teamId: string, changes: { name?: string; departmentId?: string | null }): Promise<Team> {
    return this.store.update("teams.json", isEnvelope(isTeam), async (envelope) => {
      const index = envelope.records.findIndex((team) => team.id === teamId && team.organisationId === tenant.organisationId);
      if (index < 0) throw new AppError(404, "NOT_FOUND", "The team was not found.");
      if (changes.departmentId) {
        const departments = (await this.store.read("departments.json", isEnvelope(isDepartment))).records;
        if (!departments.some((department) => department.id === changes.departmentId && department.organisationId === tenant.organisationId)) {
          throw new AppError(400, "INVALID_DEPARTMENT", "The department does not belong to this organisation.");
        }
      }
      if (changes.name && envelope.records.some((team) => team.organisationId === tenant.organisationId && team.id !== teamId && team.name.toLowerCase() === changes.name!.toLowerCase())) {
        throw new AppError(409, "DUPLICATE_TEAM", "A team with this name already exists.");
      }
      envelope.records[index] = { ...envelope.records[index]!, ...changes, updatedAt: new Date().toISOString() };
      return envelope.records[index]!;
    });
  }

  async setTeamMembership(tenant: TenantContext, teamId: string, userId: string, role: TeamMembership["role"], status: TeamMembership["status"]): Promise<TeamMembership> {
    const teams = (await this.store.read("teams.json", isEnvelope(isTeam))).records;
    if (!teams.some((team) => team.id === teamId && team.organisationId === tenant.organisationId)) {
      throw new AppError(404, "NOT_FOUND", "The team was not found.");
    }
    const users = (await this.store.read("memberships.json", isEnvelope(isMembership))).records;
    if (!users.some((membership) => membership.organisationId === tenant.organisationId && membership.userId === userId && membership.status === "active")) {
      throw new AppError(400, "INVALID_USER_MEMBERSHIP", "The user is not an active member of this organisation.");
    }
    const accounts = (await this.store.read("users.json", isEnvelope(isUser))).records;
    if (!accounts.some((user) => user.id === userId && user.status === "active")) {
      throw new AppError(400, "INVALID_USER_MEMBERSHIP", "The user account is not active.");
    }
    return this.store.update("team-memberships.json", isEnvelope(isTeamMembership), (envelope) => {
      const matches = envelope.records.filter((member) => member.organisationId === tenant.organisationId && member.teamId === teamId && member.userId === userId);
      if (matches.length > 1) throw new AppError(500, "DATA_INTEGRITY_ERROR", "Team membership data is inconsistent.");
      const timestamp = new Date().toISOString();
      const current = matches[0];
      if (current) {
        const index = envelope.records.indexOf(current);
        envelope.records[index] = { ...current, role, status, updatedAt: timestamp };
        return envelope.records[index]!;
      }
      const record: TeamMembership = { id: `team_membership_${randomUUID()}`, organisationId: tenant.organisationId, teamId, userId, role, status, createdAt: timestamp, updatedAt: timestamp };
      envelope.records.push(record);
      return record;
    });
  }

  async listTeamMemberships(tenant: TenantContext, teamId: string): Promise<TeamMembership[]> {
    const teams = (await this.store.read("teams.json", isEnvelope(isTeam))).records;
    if (!teams.some((team) => team.id === teamId && team.organisationId === tenant.organisationId)) {
      throw new AppError(404, "NOT_FOUND", "The team was not found.");
    }
    const [members, organisationMemberships, users] = await Promise.all([
      this.store.read("team-memberships.json", isEnvelope(isTeamMembership)),
      this.store.read("memberships.json", isEnvelope(isMembership)),
      this.store.read("users.json", isEnvelope(isUser)),
    ]);
    const activeMemberIds = new Set(organisationMemberships.records
      .filter((membership) => membership.organisationId === tenant.organisationId && membership.status === "active")
      .map((membership) => membership.userId));
    const activeUserIds = new Set(users.records.filter((user) => user.status === "active").map((user) => user.id));
    return members.records.filter((member) => member.organisationId === tenant.organisationId && member.teamId === teamId &&
      member.status === "active" && activeMemberIds.has(member.userId) && activeUserIds.has(member.userId));
  }

  async listTeamIdsForUser(tenant: TenantContext, userId: string): Promise<string[]> {
    const [members, organisationMemberships, users] = await Promise.all([
      this.store.read("team-memberships.json", isEnvelope(isTeamMembership)),
      this.store.read("memberships.json", isEnvelope(isMembership)),
      this.store.read("users.json", isEnvelope(isUser)),
    ]);
    const hasActiveOrganisationMembership = organisationMemberships.records.some((membership) =>
      membership.organisationId === tenant.organisationId && membership.userId === userId && membership.status === "active");
    const isActiveUser = users.records.some((user) => user.id === userId && user.status === "active");
    if (!hasActiveOrganisationMembership || !isActiveUser) return [];
    return members.records
      .filter((membership) => membership.organisationId === tenant.organisationId && membership.userId === userId && membership.status === "active")
      .map((membership) => membership.teamId);
  }

}
