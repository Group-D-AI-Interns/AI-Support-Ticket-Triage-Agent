import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../shared/errors/app-error.ts";
import { JsonFileStore } from "../../infrastructure/persistence/json/json-file-store.ts";
import type { TenantContext } from "../../shared/auth/authentication.ts";
import { JsonTeamRepository } from "./repositories.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "triage-teams-"));
  directories.push(directory);
  const store = new JsonFileStore(directory);
  const timestamp = new Date().toISOString();
  await store.write("users.json", { schemaVersion: 1, records: [
    { id: "user-a", email: "a@example.test", displayName: "User A", status: "active", createdAt: timestamp, updatedAt: timestamp },
    { id: "user-b", email: "b@example.test", displayName: "User B", status: "active", createdAt: timestamp, updatedAt: timestamp },
  ] });
  await store.write("memberships.json", { schemaVersion: 1, records: [
    { id: "membership-a", organisationId: "org-a", userId: "user-a", status: "active", roles: ["support_agent"], createdAt: timestamp, updatedAt: timestamp },
    { id: "membership-b", organisationId: "org-b", userId: "user-b", status: "active", roles: ["support_agent"], createdAt: timestamp, updatedAt: timestamp },
  ] });
  return {
    store,
    repository: new JsonTeamRepository(store),
    tenant: { organisationId: "org-a", userId: "user-a", roles: ["organisation_admin"] } satisfies TenantContext,
  };
}

describe("team and department management", () => {
  it("creates tenant-scoped departments and teams and validates department ownership", async () => {
    const { repository, tenant, store } = await setup();
    const department = await repository.createDepartment(tenant, "Customer Support");
    const team = await repository.createTeam(tenant, "Billing", department.id);
    assert.equal(team.organisationId, tenant.organisationId);
    assert.equal(team.departmentId, department.id);
    assert.deepEqual(await repository.listTeams(tenant), [team]);

    await store.write("departments.json", { schemaVersion: 1, records: [
      department,
      { id: "dept-b", organisationId: "org-b", name: "Private", createdAt: department.createdAt, updatedAt: department.updatedAt },
    ] });
    await assert.rejects(repository.createTeam(tenant, "Cross tenant", "dept-b"), (error: unknown) => error instanceof AppError && error.code === "INVALID_DEPARTMENT");
    assert.equal((await repository.listTeams({ ...tenant, organisationId: "org-b" })).length, 0);
  });

  it("assigns only active organisation members and filters team members by tenant state", async () => {
    const { repository, tenant } = await setup();
    const team = await repository.createTeam(tenant, "Escalations", null);
    const membership = await repository.setTeamMembership(tenant, team.id, "user-a", "support_agent", "active");
    assert.equal(membership.userId, "user-a");
    assert.equal((await repository.listTeamMemberships(tenant, team.id)).length, 1);
    await assert.rejects(repository.setTeamMembership(tenant, team.id, "user-b", "support_agent", "active"), (error: unknown) => error instanceof AppError && error.code === "INVALID_USER_MEMBERSHIP");
    await assert.rejects(repository.listTeamMemberships({ ...tenant, organisationId: "org-b" }, team.id), (error: unknown) => error instanceof AppError && error.statusCode === 404);
  });
});
