import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { createApp } from "../app.ts";
import { loadEnvironment } from "../config/env.ts";
import { JsonFileStore, JsonStorageError } from "../infrastructure/persistence/json/json-file-store.ts";
import { JsonIdentityRepository } from "../modules/identity/repositories.ts";
import { IdentityService } from "../modules/identity/service.ts";
import { KeycloakAuthenticationProvider } from "../infrastructure/auth/keycloak-authentication.ts";
import { KeycloakUserProvisioningProvider } from "../infrastructure/auth/keycloak-user-provisioning.ts";
import { DenyByDefaultAuthorization, RolePermissionAuthorization, ROLE_DISPLAY_NAMES, ROLE_PERMISSIONS, requirePermission } from "../shared/auth/authorization.ts";
import { AppError } from "../shared/errors/app-error.ts";
import type { TenantContext } from "../shared/auth/authentication.ts";

const directories: string[] = [];
const servers: Array<ReturnType<typeof createApp>> = [];

async function makeDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "triage-foundation-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JSON file store", () => {
  it("returns an empty envelope for a missing collection and rejects malformed JSON", async () => {
    const store = new JsonFileStore(await makeDirectory());
    const validate = (value: unknown): value is { schemaVersion: 1; records: string[] } =>
      typeof value === "object" && value !== null && (value as { schemaVersion?: unknown }).schemaVersion === 1 && Array.isArray((value as { records?: unknown }).records);
    assert.deepEqual(await store.read("items.json", validate), { schemaVersion: 1, records: [] });
    await writeFile(join((directories.at(-1))!, "items.json"), "{oops", "utf8");
    await assert.rejects(store.read("items.json", validate), (error: unknown) => error instanceof JsonStorageError && error.code === "STORAGE_INVALID_JSON");
    await writeFile(join((directories.at(-1))!, "items.json"), JSON.stringify({ schemaVersion: 2, records: [] }), "utf8");
    await assert.rejects(store.read("items.json", validate), (error: unknown) => error instanceof JsonStorageError && error.code === "STORAGE_INVALID_SCHEMA");
    await writeFile(join((directories.at(-1))!, "items.json"), JSON.stringify({ schemaVersion: 1, records: [{ id: "dupe" }, { id: "dupe" }] }), "utf8");
    await assert.rejects(store.read("items.json", validate), (error: unknown) => error instanceof JsonStorageError && error.code === "STORAGE_INVALID_SCHEMA");
  });

  it("serializes concurrent read-modify-write operations", async () => {
    const store = new JsonFileStore(await makeDirectory());
    const validate = (value: unknown): value is { schemaVersion: 1; records: number[] } =>
      typeof value === "object" && value !== null && (value as { schemaVersion?: unknown }).schemaVersion === 1 && Array.isArray((value as { records?: unknown }).records) && (value as { records: unknown[] }).records.every((item) => typeof item === "number");
    await Promise.all(Array.from({ length: 24 }, () => store.update("items.json", validate, async (envelope) => {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)));
      envelope.records.push(1);
    })));
    assert.equal((await store.read("items.json", validate)).records.length, 24);
  });

  it("times out safely when another process holds the lock", async () => {
    const directory = await makeDirectory();
    const store = new JsonFileStore(directory, 15);
    await writeFile(join(directory, "items.json.lock"), "held", "utf8");
    await assert.rejects(store.write("items.json", { schemaVersion: 1, records: [] }), (error: unknown) =>
      error instanceof JsonStorageError && error.code === "STORAGE_IO_ERROR" && error.message.includes("Timed out"));
  });
});

describe("environment configuration", () => {
  it("rejects invalid ports and JSON lock timeout values", () => {
    assert.throws(() => loadEnvironment({ PORT: "70000" }), /PORT/);
    assert.throws(() => loadEnvironment({ JSON_WRITE_LOCK_TIMEOUT_MS: "0" }), /JSON_WRITE_LOCK_TIMEOUT_MS/);
  });

  it("requires issuer and audience when Keycloak mode is enabled", () => {
    assert.throws(() => loadEnvironment({ AUTH_MODE: "keycloak" }), /AUTH_ISSUER and AUTH_AUDIENCE/);
    assert.equal(loadEnvironment({ AUTH_MODE: "keycloak", AUTH_ISSUER: "https://sso.example.test/realms/support", AUTH_AUDIENCE: "support-api" }).authMode, "keycloak");
  });
});

describe("Keycloak access token verification", () => {
  it("accepts a signed token with the expected issuer, audience, and expiry", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "key-1" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: "https://sso.example.test/realms/support", typ: "Bearer", aud: ["support-api"], sub: "keycloak-user-1", exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
    const input = `${header}.${payload}`;
    const token = `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
    const provider = new KeycloakAuthenticationProvider({
      issuer: "https://sso.example.test/realms/support",
      audience: "support-api",
      jwksUri: "https://sso.example.test/realms/support/certs",
      fetcher: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const request = { headers: { authorization: `Bearer ${token}` } } as import("node:http").IncomingMessage;
    assert.deepEqual(await provider.authenticate(request), { userId: "keycloak-user-1" });
    assert.equal(await provider.authenticate({ headers: {} } as import("node:http").IncomingMessage), null);
  });

  it("rejects wrong issuer, wrong audience, expiry, and invalid signatures", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };
    const provider = new KeycloakAuthenticationProvider({ issuer: "https://sso.example.test/realms/support", audience: "support-api", jwksUri: "https://sso.example.test/certs", fetcher: async () => new Response(JSON.stringify({ keys: [jwk] })) });
    const tokenFor = (claims: Record<string, unknown>) => {
      const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1" })).toString("base64url");
      const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const input = `${head}.${body}`;
      return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
    };
    const requestFor = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as import("node:http").IncomingMessage;
    const base = { iss: "https://sso.example.test/realms/support", typ: "Bearer", aud: "support-api", sub: "u1", exp: Math.floor(Date.now() / 1000) + 60 };
    assert.equal(await provider.authenticate(requestFor(tokenFor({ ...base, iss: "https://wrong.test" }))), null);
    assert.equal(await provider.authenticate(requestFor(tokenFor({ ...base, aud: "wrong-api" }))), null);
    assert.equal(await provider.authenticate(requestFor(tokenFor({ ...base, exp: 1 }))), null);
    const valid = tokenFor(base).split(".");
    valid[2] = Buffer.from("not a signature").toString("base64url");
    assert.equal(await provider.authenticate(requestFor(valid.join("."))), null);
  });
});

describe("Keycloak user invitations", () => {
  it("creates a Keycloak account and sends verify/password actions", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const provider = new KeycloakUserProvisioningProvider({
      issuer: "https://sso.example.test/realms/support",
      clientId: "support-admin",
      clientSecret: "test-secret",
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
        if (url.endsWith("/protocol/openid-connect/token")) return new Response(JSON.stringify({ access_token: "service-token", expires_in: 300 }), { status: 200 });
        if (url.endsWith("/admin/realms/support/users")) return new Response(null, { status: 201, headers: { location: "https://sso.example.test/admin/realms/support/users/kc-user-5" } });
        if (url.includes("/execute-actions-email")) return new Response(null, { status: 204 });
        throw new Error(`Unexpected Keycloak request ${url}`);
      },
    });
    assert.deepEqual(await provider.inviteUser({ email: "agent@example.test", displayName: "Support Agent" }), { userId: "kc-user-5" });
    assert.equal(requests[1]!.url, "https://sso.example.test/admin/realms/support/users");
    assert.deepEqual(JSON.parse(requests[2]!.body!), ["VERIFY_EMAIL", "UPDATE_PASSWORD"]);
  });

  it("preserves Keycloak user fields when updating the display name", async () => {
    let updateBody = "";
    const provider = new KeycloakUserProvisioningProvider({ issuer: "https://sso.example.test/realms/support", clientId: "admin", clientSecret: "secret", fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/protocol/openid-connect/token")) return new Response(JSON.stringify({ access_token: "svc", expires_in: 300 }));
      if (init?.method === "PUT") { updateBody = String(init.body); return new Response(null, { status: 204 }); }
      return new Response(JSON.stringify({ id: "kc-user-5", username: "agent@example.test", email: "agent@example.test", enabled: true, firstName: "Old" }));
    } });
    await provider.updateUser("kc-user-5", { displayName: "New Name" });
    const updated = JSON.parse(updateBody) as Record<string, unknown>;
    assert.equal(updated.firstName, "New Name");
    assert.equal(updated.username, "agent@example.test");
  });
});

describe("role-based user management API", () => {
  it("lists role capabilities and returns effective permissions on memberships and users", async () => {
    const directory = await makeDirectory();
    const store = new JsonFileStore(directory);
    const timestamp = new Date().toISOString();
    await store.write("users.json", { schemaVersion: 1, records: [
      { id: "admin", email: "admin@example.test", displayName: "Admin", status: "active", createdAt: timestamp, updatedAt: timestamp },
      { id: "agent", email: "agent@example.test", displayName: "Agent", status: "active", createdAt: timestamp, updatedAt: timestamp },
    ] });
    await store.write("memberships.json", { schemaVersion: 1, records: [
      { id: "m-admin", organisationId: "org-a", userId: "admin", status: "active", roles: ["organisation_admin"], createdAt: timestamp, updatedAt: timestamp },
      { id: "m-agent", organisationId: "org-a", userId: "agent", status: "active", roles: ["support_agent"], createdAt: timestamp, updatedAt: timestamp },
    ] });
    await store.write("organisations.json", { schemaVersion: 1, records: [
      { id: "org-a", name: "Organisation A", status: "active", settings: {}, createdAt: timestamp, updatedAt: timestamp },
    ] });
    const invitations: Array<{ email: string; displayName: string }> = [];
    const server = createApp(loadEnvironment({ NODE_ENV: "test", DATA_DIRECTORY: directory, PORT: "0" }), {
      authenticator: { authenticate: async (request) => ({ userId: typeof request.headers["x-test-user"] === "string" ? request.headers["x-test-user"] : "admin" }) },
      userProvisioner: {
        inviteUser: async (input) => { invitations.push(input); return { userId: "new-keycloak-user" }; },
        updateUser: async () => undefined,
        deleteUser: async () => undefined,
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/json", "x-organisation-id": "org-a" };

    const roleResponse = await fetch(`${base}/api/v1/roles`, { headers });
    assert.equal(roleResponse.status, 200);
    const roleBody = await roleResponse.json() as { data: Array<{ id: string; permissions: Array<{ id: string; description: string }> }> };
    const requesterRole = roleBody.data.find((role) => role.id === "requester");
    assert.ok(requesterRole?.permissions.some((permission) => permission.id === "tickets.create.own"));

    const meResponse = await fetch(`${base}/api/v1/me?organisationId=org-a`, { headers });
    const meBody = await meResponse.json() as { data: { organisations: Array<{ permissions: string[] }> } };
    assert.equal(meResponse.status, 200);
    assert.ok(meBody.data.organisations[0]?.permissions.includes("users.manage"));

    const created = await fetch(`${base}/api/v1/users`, {
      method: "POST", headers, body: JSON.stringify({ email: "new@example.test", displayName: "New User", roles: ["requester"] }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { data: { permissions: string[]; membership: { roles: string[] }; user: Record<string, unknown> } };
    assert.deepEqual(createdBody.data.membership.roles, ["requester"]);
    assert.deepEqual(createdBody.data.permissions, ["tickets.create.own", "tickets.read.own"]);
    assert.equal("password" in createdBody.data.user, false);

    const usersResponse = await fetch(`${base}/api/v1/users?organisationId=org-a`, { headers });
    assert.equal(usersResponse.status, 200);
    const usersBody = await usersResponse.json() as { data: Array<{ id: string; roles: string[]; permissions: string[] }> };
    assert.deepEqual(usersBody.data.find((user) => user.id === "new-keycloak-user")?.permissions, createdBody.data.permissions);

    const denied = await fetch(`${base}/api/v1/users?organisationId=org-a`, {
      method: "POST", headers: { ...headers, "x-test-user": "agent" },
      body: JSON.stringify({ email: "denied@example.test", displayName: "Denied", roles: ["support_agent"] }),
    });
    assert.equal(denied.status, 403);
    assert.equal(invitations.length, 1);

    const rejectedMembershipUpdate = await fetch(`${base}/api/v1/users/agent/memberships?organisationId=org-a`, {
      method: "PUT", headers, body: JSON.stringify({ status: "active", roles: ["requester"], permissions: ["*"] }),
    });
    assert.equal(rejectedMembershipUpdate.status, 400);

    const membershipUpdate = await fetch(`${base}/api/v1/users/agent/memberships?organisationId=org-a`, {
      method: "PUT", headers, body: JSON.stringify({ status: "active", roles: ["requester"] }),
    });
    assert.equal(membershipUpdate.status, 200);
    const membershipBody = await membershipUpdate.json() as { data: { permissions: string[] } };
    assert.deepEqual(membershipBody.data.permissions, ["tickets.create.own", "tickets.read.own"]);
  });
});

describe("identity and tenant context", () => {
  it("requires active user and membership and returns only tenant roles", async () => {
    const directory = await makeDirectory();
    const store = new JsonFileStore(directory);
    const timestamp = new Date().toISOString();
    await store.write("users.json", { schemaVersion: 1, records: [
      { id: "u1", email: "one@example.test", displayName: "One", status: "active", createdAt: timestamp, updatedAt: timestamp },
      { id: "u2", email: "two@example.test", displayName: "Two", status: "inactive", createdAt: timestamp, updatedAt: timestamp },
    ] });
    await store.write("memberships.json", { schemaVersion: 1, records: [
      { id: "m1", organisationId: "org-a", userId: "u1", status: "active", roles: ["support_agent"], createdAt: timestamp, updatedAt: timestamp },
      { id: "m2", organisationId: "org-b", userId: "u1", status: "suspended", roles: ["organisation_admin"], createdAt: timestamp, updatedAt: timestamp },
    ] });
    await store.write("organisations.json", { schemaVersion: 1, records: [
      { id: "org-a", name: "Organisation A", status: "active", settings: {}, createdAt: timestamp, updatedAt: timestamp },
      { id: "org-b", name: "Organisation B", status: "active", settings: {}, createdAt: timestamp, updatedAt: timestamp },
    ] });
    const identity = new IdentityService(new JsonIdentityRepository(store));
    assert.deepEqual(await identity.resolve("u1", "org-a"), { organisationId: "org-a", userId: "u1", roles: ["support_agent"] });
    assert.equal(await identity.resolve("u1", "org-b"), null);
    assert.equal(await identity.resolve("u2", "org-a"), null);
  });
});

describe("authorization", () => {
  const tenant: TenantContext = { organisationId: "org-a", userId: "u1", roles: ["support_agent"] };
  it("denies by default and supports an injected reviewed policy", () => {
    assert.throws(() => requirePermission(new DenyByDefaultAuthorization(), tenant, "teams.manage"), (error: unknown) => error instanceof AppError && error.statusCode === 403);
    const policy = new RolePermissionAuthorization(new Map([["support_agent", new Set(["tickets.read.assigned"])]]));
    requirePermission(policy, tenant, "tickets.read.assigned");
    assert.throws(() => requirePermission(policy, tenant, "teams.manage"), /permission/);
  });

  it("grants the supplied role capabilities under one canonical administrator role", () => {
    const policy = new RolePermissionAuthorization(ROLE_PERMISSIONS);
    assert.deepEqual(ROLE_DISPLAY_NAMES.organisation_admin, ["Administrator", "Organisation Administrator", "System Administrator"]);
    assert.equal(policy.permissionsFor(["organisation_admin"]).has("users.manage"), true);
    assert.equal(policy.permissionsFor(["support_lead"]).has("tickets.approve"), true);
    assert.equal(policy.permissionsFor(["support_agent"]).has("tickets.ai.review"), true);
    assert.equal(policy.permissionsFor(["requester"]).has("tickets.create.own"), true);
    assert.equal(policy.permissionsFor(["requester"]).has("users.manage"), false);
    assert.equal(policy.permissionsFor(["unknown_role"]).size, 0);
  });
});

describe("HTTP foundation", () => {
  it("returns request ids, shared errors and rejects forged tenant selection", async () => {
    const directory = await makeDirectory();
    const store = new JsonFileStore(directory);
    const timestamp = new Date().toISOString();
    await store.write("users.json", { schemaVersion: 1, records: [{ id: "u1", email: "one@example.test", displayName: "One", status: "active", createdAt: timestamp, updatedAt: timestamp }] });
    await store.write("memberships.json", { schemaVersion: 1, records: [{ id: "m1", organisationId: "org-a", userId: "u1", status: "active", roles: ["support_agent"], createdAt: timestamp, updatedAt: timestamp }] });
    await store.write("organisations.json", { schemaVersion: 1, records: [
      { id: "org-a", name: "Organisation A", status: "active", settings: {}, createdAt: timestamp, updatedAt: timestamp },
    ] });
    const server = createApp(loadEnvironment({ NODE_ENV: "test", DATA_DIRECTORY: directory, PORT: "0" }), {
      authenticator: { authenticate: async () => ({ userId: "u1" }) },
      authorization: new RolePermissionAuthorization(new Map([["support_agent", new Set(["teams.manage", "teams.members.read"])]])),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    const denied = await fetch(`${base}/api/v1/teams?organisationId=org-b`);
    assert.equal(denied.status, 403);
    const error = await denied.json() as { error: { code: string; requestId: string } };
    assert.equal(error.error.code, "ORGANISATION_ACCESS_DENIED");
    assert.equal(denied.headers.get("x-request-id"), error.error.requestId);

    const department = await fetch(`${base}/api/v1/departments?organisationId=org-a`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Billing" }),
    });
    assert.equal(department.status, 201);
    const departmentData = (await department.json() as { data: { id: string } }).data;
    const team = await fetch(`${base}/api/v1/teams?organisationId=org-a`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Billing support", departmentId: departmentData.id }),
    });
    assert.equal(team.status, 201);
    const teamData = (await team.json() as { data: { id: string } }).data;
    const assignment = await fetch(`${base}/api/v1/teams/${teamData.id}/members?organisationId=org-a`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "u1", role: "support_agent", status: "active" }),
    });
    assert.equal(assignment.status, 200);
    const teamMembers = await fetch(`${base}/api/v1/teams/${teamData.id}/members?organisationId=org-a`);
    assert.equal(teamMembers.status, 200);
    assert.equal((await teamMembers.json() as { data: unknown[] }).data.length, 1);

    const invalidCrossTenantTeam = await fetch(`${base}/api/v1/teams?organisationId=org-a`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Wrong tenant", departmentId: "dept-org-b" }),
    });
    assert.equal(invalidCrossTenantTeam.status, 400);
    assert.equal((await invalidCrossTenantTeam.json() as { error: { code: string } }).error.code, "INVALID_DEPARTMENT");

    const health = await fetch(`${base}/health/ready`, { headers: { "x-request-id": "req_test_1" } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-request-id"), "req_test_1");
  });

  it("reports missing provider configuration as a structured service error", async () => {
    const server = createApp(loadEnvironment({ NODE_ENV: "test", DATA_DIRECTORY: await makeDirectory(), PORT: "0" }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/me`);
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "AUTHENTICATION_NOT_CONFIGURED");
  });

  it("rejects a missing or invalid authenticated principal", async () => {
    const server = createApp(loadEnvironment({ NODE_ENV: "test", DATA_DIRECTORY: await makeDirectory(), PORT: "0" }), {
      authenticator: { authenticate: async () => null },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/me`);
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "UNAUTHENTICATED");
  });

  it("allows an organisation administrator to update a member profile through Keycloak", async () => {
    const directory = await makeDirectory();
    const store = new JsonFileStore(directory);
    const timestamp = new Date().toISOString();
    await store.write("users.json", { schemaVersion: 1, records: [
      { id: "admin", email: "admin@example.test", displayName: "Admin", status: "active", createdAt: timestamp, updatedAt: timestamp },
      { id: "member", email: "member@example.test", displayName: "Before", status: "active", createdAt: timestamp, updatedAt: timestamp },
    ] });
    await store.write("memberships.json", { schemaVersion: 1, records: [
      { id: "m-admin", organisationId: "org-a", userId: "admin", status: "active", roles: ["organisation_admin"], createdAt: timestamp, updatedAt: timestamp },
      { id: "m-member", organisationId: "org-a", userId: "member", status: "active", roles: ["support_agent"], createdAt: timestamp, updatedAt: timestamp },
    ] });
    await store.write("organisations.json", { schemaVersion: 1, records: [
      { id: "org-a", name: "Organisation A", status: "active", settings: {}, createdAt: timestamp, updatedAt: timestamp },
    ] });
    const updated: string[] = [];
    const server = createApp(loadEnvironment({ NODE_ENV: "test", DATA_DIRECTORY: directory, PORT: "0" }), {
      authenticator: { authenticate: async () => ({ userId: "admin" }) },
      userProvisioner: {
        inviteUser: async () => ({ userId: "unused" }),
        updateUser: async (userId) => { updated.push(userId); },
        deleteUser: async () => undefined,
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/users/member?organisationId=org-a`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "After" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { data: { displayName: string } }).data.displayName, "After");
    assert.deepEqual(updated, ["member"]);
  });

  it("blocks tenant APIs for an inactive organisation but lets its member admin reactivate it", async () => {
    const directory = await makeDirectory();
    const store = new JsonFileStore(directory);
    const timestamp = new Date().toISOString();
    await store.write("users.json", { schemaVersion: 1, records: [
      { id: "admin", email: "admin@example.test", displayName: "Admin", status: "active", createdAt: timestamp, updatedAt: timestamp },
      { id: "agent", email: "agent@example.test", displayName: "Agent", status: "active", createdAt: timestamp, updatedAt: timestamp },
    ] });
    await store.write("memberships.json", { schemaVersion: 1, records: [
      { id: "m-admin", organisationId: "org-a", userId: "admin", status: "active", roles: ["organisation_admin"], createdAt: timestamp, updatedAt: timestamp },
      { id: "m-agent", organisationId: "org-a", userId: "agent", status: "active", roles: ["support_agent"], createdAt: timestamp, updatedAt: timestamp },
    ] });
    await store.write("organisations.json", { schemaVersion: 1, records: [
      { id: "org-a", name: "Organisation A", status: "active", settings: {}, createdAt: timestamp, updatedAt: timestamp },
    ] });
    const server = createApp(loadEnvironment({ NODE_ENV: "test", DATA_DIRECTORY: directory, PORT: "0" }), {
      authenticator: { authenticate: async (request) => ({ userId: typeof request.headers["x-test-user"] === "string" ? request.headers["x-test-user"] : "admin" }) },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    const forbiddenTransition = await fetch(`${base}/api/v1/organisations/org-a`, {
      method: "PATCH", headers: { "content-type": "application/json", "x-test-user": "agent" }, body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(forbiddenTransition.status, 403);

    const suspend = await fetch(`${base}/api/v1/organisations/org-a`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "suspended" }),
    });
    assert.equal(suspend.status, 200);
    const denied = await fetch(`${base}/api/v1/teams?organisationId=org-a`);
    assert.equal(denied.status, 403);

    const reactivate = await fetch(`${base}/api/v1/organisations/org-a`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active" }),
    });
    assert.equal(reactivate.status, 200);
    const restored = await fetch(`${base}/api/v1/organisations/org-a`);
    assert.equal(restored.status, 200);
  });

  it("returns a safe 503 when Keycloak discovery or JWKS is unavailable", async () => {
    const server = createApp(loadEnvironment({ NODE_ENV: "test", DATA_DIRECTORY: await makeDirectory(), PORT: "0" }), {
      authenticator: { authenticate: async () => { throw new Error("upstream detail"); } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/me`);
    assert.equal(response.status, 503);
    const body = await response.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "AUTH_PROVIDER_UNAVAILABLE");
    assert.doesNotMatch(body.error.message, /upstream detail/);
  });

  it("returns 503 from readiness when the JSON data directory is not writable", async () => {
    const parent = await makeDirectory();
    const dataPath = `${parent}/not-a-directory`;
    await writeFile(dataPath, "file prevents a directory from being created");
    const server = createApp(loadEnvironment({ NODE_ENV: "test", DATA_DIRECTORY: dataPath, PORT: "0" }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    assert.equal(response.status, 503);
    const body = await response.json() as { error: { code: string; requestId: string } };
    assert.equal(body.error.code, "STORAGE_IO_ERROR");
    assert.equal(response.headers.get("x-request-id"), body.error.requestId);
  });
});
