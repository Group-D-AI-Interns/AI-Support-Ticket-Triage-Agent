import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";
import ts from "typescript";

async function importTypeScript(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

const apiModule = await importTypeScript("../lib/api.ts");
const roleNavigation = await importTypeScript("../lib/role-navigation.ts");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  apiModule.setApiTokenProvider(null);
  apiModule.clearApi();
});

test("API client fails closed before issuing a request without a connected identity", async () => {
  apiModule.clearApi();
  let called = false;
  globalThis.fetch = async () => { called = true; return Response.json({}); };
  await assert.rejects(apiModule.api.me(), error => error instanceof apiModule.ApiError && error.status === 401);
  assert.equal(called, false);
});

test("API client refreshes the bearer token, scopes the organisation, and disables caching", async () => {
  apiModule.configureApi("initial-token", "org-test");
  apiModule.setApiTokenProvider(async () => "refreshed-token");
  let captured;
  globalThis.fetch = async (input, init) => {
    captured = { url: String(input), init };
    return Response.json({ data: { organisations: [] }, requestId: "req-test" });
  };

  const response = await apiModule.api.me();
  assert.deepEqual(response.data.organisations, []);
  assert.equal(captured.url, "/api/backend/api/v1/me");
  const headers = new Headers(captured.init.headers);
  assert.equal(headers.get("authorization"), "Bearer refreshed-token");
  assert.equal(headers.get("x-organisation-id"), "org-test");
  assert.equal(captured.init.cache, "no-store");
});

test("API client preserves backend status, stable error code, request ID, and validation fields", async () => {
  apiModule.configureApi("test-token", "org-test");
  globalThis.fetch = async () => Response.json({ error: {
    code: "RATE_LIMITED", message: "Try again later.", requestId: "req-limited",
    fields: [{ field: "body", message: "Too many requests." }],
  } }, { status: 429, headers: { "retry-after": "12" } });

  await assert.rejects(apiModule.api.me(), error => {
    assert.ok(error instanceof apiModule.ApiError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.requestId, "req-limited");
    assert.equal(error.fields[0].field, "body");
    return true;
  });
});

test("multipart uploads leave the boundary content type to fetch and private downloads parse disposition", async () => {
  apiModule.configureApi("test-token", "org-test");
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (requests.length === 1) return Response.json({ data: { id: "att-1", fileName: "evidence.txt", mimeType: "text/plain", fileSizeBytes: 4 } });
    return new Response("safe", { headers: {
      "content-type": "text/plain", "content-disposition": "attachment; filename*=UTF-8''evidence%20file.txt",
    } });
  };

  await apiModule.api.uploadAttachment("ticket/1", new File(["safe"], "evidence.txt", { type: "text/plain" }));
  assert.equal(new Headers(requests[0].init.headers).has("content-type"), false);
  assert.equal(requests[0].url, "/api/backend/api/v1/tickets/ticket%2F1/attachments");
  const download = await apiModule.api.downloadAttachment("ticket/1", "att-1");
  assert.equal(download.fileName, "evidence file.txt");
  assert.equal(await download.blob.text(), "safe");
});

test("role navigation gives support staff their workspace and keeps admin screens permission-gated", () => {
  const requester = ["tickets.create.own", "tickets.read.own"];
  const agent = ["tickets.read.assigned", "tickets.ai.review"];
  const lead = ["tickets.read.team", "reports.read.team", "tickets.audit.read"];
  const admin = ["organisation.read", "users.read", "users.manage", "teams.read", "configuration.manage"];

  assert.equal(roleNavigation.landingView(requester), "tickets");
  assert.equal(roleNavigation.landingView(agent), "tickets");
  assert.equal(roleNavigation.landingView(lead), "dashboard");
  assert.equal(roleNavigation.landingView(admin), "overview");
  assert.deepEqual(roleNavigation.visibleWorkspaceNavigation(agent, true, false), ["dashboard", "tickets"]);
  assert.deepEqual(roleNavigation.visibleWorkspaceNavigation(lead, true, false), ["dashboard", "tickets", "reports", "audit"]);
  assert.deepEqual(roleNavigation.visibleWorkspaceNavigation(admin, false, true), ["configuration", "overview", "users", "organisations", "teams"]);
});
