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
const ticketIntake = await importTypeScript("../lib/ticket-intake.ts");
const ticketPresentation = await importTypeScript("../lib/ticket-presentation.ts");
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

test("requester intake exposes the specified fields, validates selections/counts, and sends selected values", async () => {
  const component = await readFile(new URL("../components/support-workspace.tsx", import.meta.url), "utf8");
  for (const label of ["Affected users", "Number of users affected", "Business impact", "Urgency"]) {
    assert.ok(component.includes(label), `requester form should include ${label}`);
  }
  for (const option of ["one_user", "small_group", "multiple_users_one_department", "multiple_departments", "organisation_wide", "critical", "immediate"]) {
    assert.ok(component.includes(`value=\"${option}\"`), `requester form should include ${option}`);
  }
  assert.match(component, /required>\s*<option value="">Choose scope/);
  assert.match(component, /required>\s*<option value="">Choose impact/);
  assert.match(component, /required>\s*<option value="">Choose urgency/);
  assert.equal(ticketIntake.requiredTicketImpactFields("", "critical", "immediate"), null);
  assert.equal(ticketIntake.requiredTicketImpactFields("one_user", "critical", ""), null);
  assert.deepEqual(ticketIntake.requiredTicketImpactFields("one_user", "critical", "immediate"), { scope: "one_user", businessImpact: "critical", urgency: "immediate" });
  assert.equal(ticketIntake.parseAffectedUserCount(""), undefined);
  assert.equal(ticketIntake.parseAffectedUserCount("150"), 150);
  for (const invalid of ["0", "-1", "1.5", "abc", "9007199254740992"]) {
    assert.throws(() => ticketIntake.parseAffectedUserCount(invalid), /positive whole number/);
  }

  apiModule.configureApi("test-token", "org-test");
  let submitted;
  globalThis.fetch = async (_input, init) => {
    submitted = JSON.parse(init.body);
    return Response.json({ data: { id: "ticket-1" }, requestId: "req-test" });
  };
  await apiModule.api.createTicket({
    title: "Synthetic requester issue", description: "Synthetic description.", product: "Network Monitoring System",
    affectedService: "Core Network Infrastructure", affectedUsers: { scope: "multiple_departments", count: 150 },
    businessImpact: "critical", urgency: "immediate",
  });
  assert.deepEqual(submitted, {
    title: "Synthetic requester issue", description: "Synthetic description.", product: "Network Monitoring System",
    affectedService: "Core Network Infrastructure", affectedUsers: { scope: "multiple_departments", count: 150 },
    businessImpact: "critical", urgency: "immediate",
  });
});

test("requester dashboard counts and status labels come from visible ticket records", () => {
  const tickets = [
    { id: "t-1", status: "NEW" },
    { id: "t-2", status: "IN_PROGRESS" },
    { id: "t-3", status: "resolved" },
    { id: "t-4", status: "PENDING" },
  ];
  assert.deepEqual(ticketPresentation.requesterTicketCounts(tickets), {
    total: 4, open: 2, inProgress: 1, resolved: 1,
  });
  assert.equal(ticketPresentation.ticketStatusLabel("IN_PROGRESS"), "In Progress");
  assert.deepEqual(ticketPresentation.requesterTicketStatusBreakdown(tickets).map(row => [row.key, row.count]), [
    ["in_progress", 1], ["new", 1], ["pending", 1], ["resolved", 1],
  ]);
});

test("requester ticket screens share responsive queue, dashboard, and intake presentation", async () => {
  const workspace = await readFile(new URL("../components/support-workspace.tsx", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../components/operational-pages.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(workspace, /customer-ticket-row/);
  assert.match(workspace, /ticketStatusLabel\(ticket\.status\)/);
  assert.match(workspace, /customer-form-section/);
  assert.match(dashboard, /requesterTicketCounts\(tickets\)/);
  assert.match(dashboard, /loadVisibleTickets\(\)/);
  assert.match(styles, /\.customer-dashboard-metrics/);
  assert.match(styles, /\.customer-ticket-row/);
  assert.match(styles, /@media\(max-width:560px\)\{\.customer-dashboard/);
});

test("support lead receives escalations while only escalation-authorized staff see the handoff form", async () => {
  const workspace = await readFile(new URL("../components/support-workspace.tsx", import.meta.url), "utf8");
  const consoleSource = await readFile(new URL("../components/foundation-console.tsx", import.meta.url), "utf8");
  const authorization = await readFile(new URL("../../backend/src/shared/auth/authorization.ts", import.meta.url), "utf8");
  assert.match(consoleSource, /canEscalate=\{can\("tickets\.escalate"\)\}/);
  assert.match(consoleSource, /canResolveEscalation=\{can\("tickets\.escalations\.read"\)\}/);
  assert.match(workspace, /canEscalate && !isLead/);
  assert.match(workspace, /activeTab === "escalations" && isLead/);
  assert.match(authorization, /"tickets\.escalate"/);
  assert.match(authorization, /"tickets\.escalations\.read"/);
});

test("support dashboard derives queue and lead escalation metrics from scoped API data", async () => {
  const dashboard = await readFile(new URL("../components/operational-pages.tsx", import.meta.url), "utf8");
  for (const metric of ["Open tickets", "In progress", "P1 critical", "P2 high", "P3 medium", "P4 low", "Unassigned"]) {
    assert.ok(dashboard.includes(`title="${metric}"`), `dashboard should include ${metric}`);
  }
  assert.match(dashboard, /if \(isLead\)[\s\S]*api\.escalations\(\)/);
  assert.match(dashboard, /title="Open escalations" value=\{openEscalations\}/);
  assert.match(dashboard, /if \(isLead\) return <SupportLeadDashboard/);
  assert.match(dashboard, /title="Team tickets" value=\{tickets\.length\}/);
  assert.match(dashboard, /<CustomerMetric title="Open escalations" value=\{openEscalations\}/);
});


test("support lead ticket queue matches staff queue presentation while retaining lead tabs", async () => {
  const workspace = await readFile(new URL("../components/support-workspace.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(workspace, /const requesterStyle = isRequester \|\| isSupportAgent \|\| isLead/);
  assert.match(workspace, /support-lead-workspace/);
  assert.match(workspace, /customer-queue-card lead-queue-card/);
  assert.match(workspace, /Team & unassigned tickets/);
  assert.match(workspace, /aria-label="Support lead queues"/);
  assert.match(workspace, />Escalations <span className="nav-count">/);
  assert.match(workspace, />AI approvals <span className="nav-count">/);
  assert.match(workspace, /activeTab === "escalations" && isLead/);
  assert.match(workspace, /activeTab === "approvals" && isLead/);
  assert.match(styles, /\.support-lead-workspace \.support-tabs/);
  assert.match(styles, /\.lead-queue-card \.customer-queue-top \.ticket-filters/);
});

test("ticket audit page uses a responsive event list while retaining role-scoped audit sources and pagination", async () => {
  const audit = await readFile(new URL("../components/operational-pages.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(audit, /className="operational-page audit-workspace"/);
  assert.match(audit, /api\.auditLogs\(page, 50\)/);
  assert.match(audit, /api\.ticketAudit\(ticket\.id\)/);
  assert.match(audit, /api\.triages\(ticket\.id\)/);
  assert.match(audit, /className="content-card audit-table-card"/);
  for (const column of ["Event", "Ticket", "Changes", "Actor ID", "Time"]) assert.ok(audit.includes(`>${column}</th>`), `audit table should include ${column}`);
  assert.match(audit, /<AuditLogTable/);
  assert.match(audit, /function AuditChanges/);
  assert.match(audit, /Object\.hasOwn\(diff, "before"\)/);
  assert.match(audit, /No changes recorded/);
  assert.match(audit, /className="ticket-page-controls audit-pagination"/);
  assert.match(styles, /\.audit-table\{width:100%;min-width:900px;border-collapse:collapse/);
  assert.match(styles, /\.audit-event-created/);
  assert.match(styles, /@media\(max-width:560px\)\{\.audit-workspace/);
});

test("support agent dashboard and ticket queue share the requester visual system without changing role scope", async () => {
  const dashboard = await readFile(new URL("../components/operational-pages.tsx", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../components/support-workspace.tsx", import.meta.url), "utf8");
  const consoleSource = await readFile(new URL("../components/foundation-console.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(consoleSource, /isAgent=\{activeContext\?\.roles\.includes\("support_agent"\)/);
  assert.match(consoleSource, /isSupportAgent=\{activeContext\?\.roles\.includes\("support_agent"\)/);
  assert.match(dashboard, /if \(isAgent\)[\s\S]*customer-dashboard-metrics[\s\S]*Assigned tickets[\s\S]*Ticket status[\s\S]*Priority distribution/);
  assert.match(dashboard, /loadVisibleTickets\(\)/);
  assert.match(workspace, /isRequester \|\| isSupportAgent/);
  assert.match(workspace, /customer-queue-card agent-queue-card/);
  assert.match(workspace, /ticketStatusLabel\(ticket\.status\)/);
  assert.match(styles, /\.support-agent-dashboard/);
  assert.match(styles, /\.agent-queue-card \.customer-queue-top \.ticket-filters/);
  assert.match(styles, /@media\(max-width:560px\)[\s\S]*\.agent-dashboard-details\{grid-template-columns:1fr\}/);
});

test("support agent ticket detail uses the two-column case layout and keeps permission-gated controls", async () => {
  const workspace = await readFile(new URL("../components/support-workspace.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(workspace, /support-agent-ticket-layout/);
  assert.match(workspace, /ticket-detail-sidebar/);
  assert.match(workspace, /ticket-detail-followup/);
  assert.match(workspace, /ticket-ai-tools/);
  assert.match(workspace, /\{canAi &&/);
  assert.match(workspace, /\{canResolution &&/);
  assert.match(workspace, /canEscalate && !isLead/);
  assert.match(workspace, /saveTicketManagement\(\)/);
  assert.match(workspace, /saveResolution\(\)/);
  assert.match(styles, /\.support-agent-ticket-layout\{grid-template-columns:minmax\(0,1\.65fr\)\s+minmax\(290px,\.9fr\)/);
  assert.match(styles, /@media\(max-width:700px\)\{\.support-agent-ticket-layout\{display:flex/);
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


test("configuration cards stay compact and retain their live management actions", async () => {
  const configuration = await readFile(new URL("../components/operational-pages.tsx", import.meta.url), "utf8");
  const documents = await readFile(new URL("../components/sla-policy-workspace.tsx", import.meta.url), "utf8");
  const priority = await readFile(new URL("../components/priority-policy-workspace.tsx", import.meta.url), "utf8");
  const compactItems = await readFile(new URL("../components/compact-items.tsx", import.meta.url), "utf8");
  const foundation = await readFile(new URL("../components/foundation-console.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(configuration, /categories\.slice\(0, 3\)/);
  assert.match(configuration, /Manage categories/);
  assert.match(configuration, /role="dialog" aria-modal="true"/);
  assert.match(configuration, /categories\.map\(category =>/);
  assert.match(configuration, /api\.createCategory\(/);
  assert.match(configuration, /api\.setCategoryStatus\(/);
  assert.match(configuration, /api\.createRoutingRule\(/);
  assert.match(configuration, /api\.decideRoutingRule\(/);
  assert.match(compactItems, /items\.slice\(0, initialCount\)/);
  assert.match(compactItems, /View all \{items\.length\}/);
  assert.match(documents, /api\.uploadDocument\(/);
  assert.match(documents, /api\.extractDocumentRules\(/);
  assert.match(documents, /api\.approveExtractedRule\(/);
  assert.match(documents, /api\.publishDocumentKnowledge\(/);
  assert.match(documents, /api\.createSlaPolicy\(/);
  assert.match(documents, /api\.approveSlaPolicy\(/);
  assert.match(documents, /api\.activateSlaPolicy\(/);
  assert.match(priority, /api\.createPriorityPolicy\(/);
  assert.match(priority, /api\.decidePriorityPolicy\(/);
  assert.match(priority, /Version details and actions/);
  assert.match(priority, /Approve version/);
  assert.match(priority, /Activate version/);
  assert.match(priority, /Source: \{documents\.find/);
  assert.match(styles, /grid-auto-rows:max-content/);
  assert.match(styles, /priority-matrix-grid select\{height:29px/);
  assert.match(foundation, /page-content-wide/);
  assert.match(styles, /config-document-grid/);
  assert.match(styles, /config-primary-grid/);
  assert.match(styles, /config-policy-grid/);
  assert.match(styles, /@media\(max-width:600px\)/);
});

test("resolution workspace defaults to saved results and exposes audited explicit regeneration", async () => {
  const workspace = await readFile(new URL("../components/support-workspace.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../lib/api.ts", import.meta.url), "utf8");
  assert.match(api, /recommendResolution: \(id: string, options: \{ regenerate\?: boolean; reason\?: string \} = \{\}\)/);
  assert.match(workspace, /Regenerate recommendation/);
  assert.match(workspace, /Saved recommendation reused/);
  assert.match(workspace, /recommendation generated and saved/i);
  assert.match(workspace, /recommendationVersion/);
  assert.match(workspace, /executionId/);
});
