import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.ts";
import type { TenantContext } from "../../shared/auth/authentication.ts";
import { updateTenantRecords, type JsonFileStorePort } from "../../infrastructure/persistence/json/json-file-store.ts";
import { isMembership, isUser } from "../identity/model.ts";
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
  private readonly store: JsonFileStorePort;
  constructor(store: JsonFileStorePort) { this.store = store; }

  async listDepartments(tenant: TenantContext): Promise<Department[]> {
    return this.store.findRecords("departments.json", isDepartment, { organisationId: tenant.organisationId });
  }

  async createDepartment(tenant: TenantContext, name: string): Promise<Department> {
    return updateTenantRecords<Department, Department>(this.store, "departments.json", tenant.organisationId, isDepartment, records => {
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
    return this.store.findRecords("teams.json", isTeam, { organisationId: tenant.organisationId });
  }

  async createTeam(tenant: TenantContext, name: string, departmentId: string | null): Promise<Team> {
    return updateTenantRecords<Team, Team>(this.store, "teams.json", tenant.organisationId, isTeam, async records => {
      if (departmentId) {
        const department = (await this.store.findRecords("departments.json", isDepartment, { id: departmentId, organisationId: tenant.organisationId }))[0];
        if (!department) {
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
    return updateTenantRecords<Team, Team>(this.store, "teams.json", tenant.organisationId, isTeam, async teams => {
      const index = teams.findIndex((team) => team.id === teamId);
      if (index < 0) throw new AppError(404, "NOT_FOUND", "The team was not found.");
      if (changes.departmentId) {
        const department = (await this.store.findRecords("departments.json", isDepartment, { id: changes.departmentId, organisationId: tenant.organisationId }))[0];
        if (!department) {
          throw new AppError(400, "INVALID_DEPARTMENT", "The department does not belong to this organisation.");
        }
      }
      if (changes.name && teams.some((team) => team.id !== teamId && team.name.toLowerCase() === changes.name!.toLowerCase())) {
        throw new AppError(409, "DUPLICATE_TEAM", "A team with this name already exists.");
      }
      teams[index] = { ...teams[index]!, ...changes, updatedAt: new Date().toISOString() };
      return teams[index]!;
    });
  }

  async setTeamMembership(tenant: TenantContext, teamId: string, userId: string, role: TeamMembership["role"], status: TeamMembership["status"]): Promise<TeamMembership> {
    const team = (await this.store.findRecords("teams.json", isTeam, { id: teamId, organisationId: tenant.organisationId }))[0];
    if (!team) {
      throw new AppError(404, "NOT_FOUND", "The team was not found.");
    }
    const organisationMembership = (await this.store.findRecords("memberships.json", isMembership, {
      organisationId: tenant.organisationId, userId, status: "active",
    }))[0];
    if (!organisationMembership) {
      throw new AppError(400, "INVALID_USER_MEMBERSHIP", "The user is not an active member of this organisation.");
    }
    const account = (await this.store.findRecords("users.json", isUser, { id: userId, status: "active" }))[0];
    if (!account) {
      throw new AppError(400, "INVALID_USER_MEMBERSHIP", "The user account is not active.");
    }
    return updateTenantRecords<TeamMembership, TeamMembership>(this.store, "team-memberships.json", tenant.organisationId, isTeamMembership, members => {
      const matches = members.filter((member) => member.teamId === teamId && member.userId === userId);
      if (matches.length > 1) throw new AppError(500, "DATA_INTEGRITY_ERROR", "Team membership data is inconsistent.");
      const timestamp = new Date().toISOString();
      const current = matches[0];
      if (current) {
        const index = members.indexOf(current);
        members[index] = { ...current, role, status, updatedAt: timestamp };
        return members[index]!;
      }
      const record: TeamMembership = { id: `team_membership_${randomUUID()}`, organisationId: tenant.organisationId, teamId, userId, role, status, createdAt: timestamp, updatedAt: timestamp };
      members.push(record);
      return record;
    });
  }

  async listTeamMemberships(tenant: TenantContext, teamId: string): Promise<TeamMembership[]> {
    const team = (await this.store.findRecords("teams.json", isTeam, { id: teamId, organisationId: tenant.organisationId }))[0];
    if (!team) {
      throw new AppError(404, "NOT_FOUND", "The team was not found.");
    }
    const members = await this.store.findRecords("team-memberships.json", isTeamMembership, {
      organisationId: tenant.organisationId, teamId, status: "active",
    });
    const ids = members.map(member => member.userId);
    if (!ids.length) return [];
    const [organisationMemberships, users] = await Promise.all([
      this.store.findRecords("memberships.json", isMembership, {
        organisationId: tenant.organisationId, status: "active", userId: { $in: ids },
      }),
      this.store.findRecords("users.json", isUser, { status: "active", id: { $in: ids } }),
    ]);
    const activeMemberIds = new Set(organisationMemberships.map(membership => membership.userId));
    const activeUserIds = new Set(users.map(user => user.id));
    return members.filter(member => activeMemberIds.has(member.userId) && activeUserIds.has(member.userId));
  }

  async listTeamIdsForUser(tenant: TenantContext, userId: string): Promise<string[]> {
    const [members, organisationMembership, user] = await Promise.all([
      this.store.findRecords("team-memberships.json", isTeamMembership, {
        organisationId: tenant.organisationId, userId, status: "active",
      }),
      this.store.findRecords("memberships.json", isMembership, {
        organisationId: tenant.organisationId, userId, status: "active",
      }),
      this.store.findRecords("users.json", isUser, { id: userId, status: "active" }),
    ]);
    const hasActiveOrganisationMembership = organisationMembership.length > 0;
    const isActiveUser = user.length > 0;
    if (!hasActiveOrganisationMembership || !isActiveUser) return [];
    return members.map(membership => membership.teamId);
  }

}
