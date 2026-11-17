import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../shared/errors/app-error.ts";
import { JsonFileStore } from "../../infrastructure/persistence/json/json-file-store.ts";
import { JsonOrganisationRepository } from "./repositories.ts";
import type { TenantContext } from "../../shared/auth/authentication.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "triage-organisations-"));
  directories.push(directory);
  const repository = new JsonOrganisationRepository(new JsonFileStore(directory));
  const tenant: TenantContext = { organisationId: "org-a", userId: "user-a", roles: ["organisation_admin"] };
  return { repository, tenant };
}

describe("organisation management", () => {
  it("creates and updates tenant-owned organisations while preserving creation time", async () => {
    const { repository, tenant } = await setup();
    const created = await repository.create({ name: "Support A" });
    const scopedTenant = { ...tenant, organisationId: created.id };
    const updated = await repository.update(scopedTenant, { name: "Support A West", settings: { timezone: "Africa/Johannesburg" } });

    assert.equal(updated.name, "Support A West");
    assert.equal(updated.createdAt, created.createdAt);
    assert.deepEqual(updated.settings, { timezone: "Africa/Johannesburg" });
    assert.ok(Date.parse(updated.updatedAt) >= Date.parse(created.updatedAt));
    assert.equal(await repository.findById(tenant, created.id), null);
  });

  it("rejects duplicate names on creation and rename without changing existing records", async () => {
    const { repository, tenant } = await setup();
    const first = await repository.create({ name: "Support A" });
    const second = await repository.create({ name: "Support B" });
    const tenantForSecond = { ...tenant, organisationId: second.id };

    await assert.rejects(repository.create({ name: "support a" }), (error: unknown) => error instanceof AppError && error.code === "DUPLICATE_ORGANISATION");
    await assert.rejects(repository.update(tenantForSecond, { name: "SUPPORT A" }), (error: unknown) => error instanceof AppError && error.code === "DUPLICATE_ORGANISATION");
    assert.equal((await repository.findById(tenantForSecond, second.id))?.name, "Support B");
    assert.equal((await repository.findById({ ...tenant, organisationId: first.id }, first.id))?.name, "Support A");
  });
});
