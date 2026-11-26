import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../shared/errors/app-error.ts";
import { JsonFileStore } from "../../infrastructure/persistence/json/json-file-store.ts";
import type { JsonEnvelope, JsonEnvelopeMigration } from "../../infrastructure/persistence/json/json-file-store.ts";
import { JsonOrganisationRepository } from "./repositories.ts";
import type { TenantContext } from "../../shared/auth/authentication.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "triage-organisations-"));
  directories.push(directory);
  const store = new JsonFileStore(directory);
  const timestamp = new Date().toISOString();
  await store.write("users.json", { schemaVersion: 1, records: [
    { id: "user-a", email: "user-a@example.test", displayName: "User A", status: "active", createdAt: timestamp, updatedAt: timestamp },
  ] });
  const repository = new JsonOrganisationRepository(store);
  const tenant: TenantContext = { organisationId: "org-a", userId: "user-a", roles: ["organisation_admin"] };
  const create = (name: string) => repository.create({ name }, { userId: tenant.userId, role: "organisation_admin" });
  return { repository, tenant, create, store };
}

describe("organisation management", () => {
  it("creates and updates tenant-owned organisations while preserving creation time", async () => {
    const { repository, tenant, create } = await setup();
    const created = await create("Support A");
    const scopedTenant = { ...tenant, organisationId: created.id };
    const updated = await repository.update(scopedTenant, { name: "Support A West", settings: { timezone: "Africa/Johannesburg" } });

    assert.equal(updated.name, "Support A West");
    assert.equal(updated.createdAt, created.createdAt);
    assert.deepEqual(updated.settings, { timezone: "Africa/Johannesburg" });
    assert.ok(Date.parse(updated.updatedAt) >= Date.parse(created.updatedAt));
    assert.equal(await repository.findById(tenant, created.id), null);
  });

  it("rejects duplicate names on creation and rename without changing existing records", async () => {
    const { repository, tenant, create } = await setup();
    const first = await create("Support A");
    const second = await create("Support B");
    const tenantForSecond = { ...tenant, organisationId: second.id };

    await assert.rejects(create("support a"), (error: unknown) => error instanceof AppError && error.code === "DUPLICATE_ORGANISATION");
    await assert.rejects(repository.update(tenantForSecond, { name: "SUPPORT A" }), (error: unknown) => error instanceof AppError && error.code === "DUPLICATE_ORGANISATION");
    assert.equal((await repository.findById(tenantForSecond, second.id))?.name, "Support B");
    assert.equal((await repository.findById({ ...tenant, organisationId: first.id }, first.id))?.name, "Support A");
  });

  it("maps a database uniqueness race to the existing conflict response and rolls back membership", async () => {
    const { repository, tenant, create, store } = await setup();
    const originalUpdate = store.update.bind(store);
    store.update = (async <T, R>(name: string, validate: (value: unknown) => value is JsonEnvelope<T>, mutate: (envelope: JsonEnvelope<T>) => R | Promise<R>, migrate?: JsonEnvelopeMigration<T>): Promise<R> => {
      if (name === "organisations.json") throw Object.assign(new Error("duplicate key"), { code: 11000 });
      return originalUpdate(name, validate, mutate, migrate);
    }) as typeof store.update;

    await assert.rejects(create("Race"), (error: unknown) => error instanceof AppError && error.code === "DUPLICATE_ORGANISATION");
    assert.deepEqual(await store.findRecords("memberships.json", (value): value is { id: string; organisationId: string; userId: string } =>
      !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" &&
      typeof (value as { organisationId?: unknown }).organisationId === "string" &&
      typeof (value as { userId?: unknown }).userId === "string", { userId: tenant.userId }), []);
  });
});
