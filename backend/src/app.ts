import { createServer, type IncomingMessage, type ServerResponse, type RequestListener } from "node:http";
import { AppError } from "./shared/errors/app-error.ts";
import type { Environment } from "./config/env.ts";
import { createLogger } from "./config/logger.ts";
import type { AuthenticationProvider, IdentityProvisioningProvider, TenantResolver, TenantContext } from "./shared/auth/authentication.ts";
import { applicationAuthorization, describeRoleCapabilities, requirePermission, ROLE_IDS, type RolePermissionPolicy } from "./shared/auth/authorization.ts";
import { JsonFileStore, JsonStorageError } from "./infrastructure/persistence/json/json-file-store.ts";
import { createJsonTenantStore } from "./infrastructure/persistence/json/json-store.ts";
import { JsonIdentityRepository } from "./modules/identity/repositories.ts";
import { IdentityService } from "./modules/identity/service.ts";
import { JsonOrganisationRepository } from "./modules/organisations/repositories.ts";
import { OrganisationService } from "./modules/organisations/service.ts";
import { JsonTeamRepository } from "./modules/teams/repositories.ts";
import { TeamService } from "./modules/teams/service.ts";
import { createRequestContext } from "./shared/middleware/request-context.ts";
import { requireAuthenticatedPrincipal, requireTenantContext } from "./shared/middleware/authentication.ts";
import { rejectUnknownFields, requireNonEmptyString } from "./shared/validation/index.ts";
import { createTicketApp } from "./modules/tickets/api.js";
import { jiraSettingsFromEnvironment } from "./modules/tickets/config.js";

export type AppDependencies = {
  moduleHandler?: RequestListener;
  authenticator?: AuthenticationProvider;
  userProvisioner?: IdentityProvisioningProvider;
  tenantResolver?: TenantResolver;
  authorization?: RolePermissionPolicy;
};

export function createApp(environment: Environment, dependencies: AppDependencies = {}) {
  const logger = createLogger(environment.logLevel);
  const store = new JsonFileStore(environment.dataDirectory, environment.jsonWriteLockTimeoutMs);
  const identity = new IdentityService(new JsonIdentityRepository(store), dependencies.userProvisioner);
  const organisation = new OrganisationService(new JsonOrganisationRepository(store));
  const teams = new TeamService(new JsonTeamRepository(store));
  const permissionPolicy = dependencies.authorization ?? applicationAuthorization;
  const ticketSettings = process.env.JIRA_TENANT_CONFIG
    ? { ...jiraSettingsFromEnvironment(), dataDirectory: environment.dataDirectory }
    : { dataDirectory: environment.dataDirectory, projectMappings: {}, organisations: {} };
  const ticketApp = dependencies.moduleHandler ?? createTicketApp({
    settings: ticketSettings,
    tenantStore: createJsonTenantStore(store),
    ...(dependencies.authenticator ? { authenticator: dependencies.authenticator } : {}),
    tenantResolver: dependencies.tenantResolver ?? identity,
    listTeamIdsForUser: (tenant, userId) => teams.listTeamIdsForUser(tenant, userId),
    authorization: permissionPolicy,
    developmentPrincipal: null,
  });

  function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  }

  function sendPage<T>(response: ServerResponse, values: T[], requestId: string, url: URL) {
    const page = Number(url.searchParams.get("page") ?? "1");
    const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new AppError(400, "VALIDATION_ERROR", "The pagination parameters are invalid.", [
        { field: "page", message: "page must be a positive integer." },
        { field: "pageSize", message: "pageSize must be an integer between 1 and 100." },
      ]);
    }
    sendJson(response, 200, {
      data: values.slice((page - 1) * pageSize, page * pageSize),
      pagination: { page, pageSize, total: values.length },
      requestId,
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const { requestId } = createRequestContext(request);
    response.setHeader("x-request-id", requestId);
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const logPath = path.startsWith('/api/v1/tickets/ingest/jira/') ? '/api/v1/tickets/ingest/jira/[redacted]' : path;
    if (isTicketModulePath(path)) {
      const startedAt = Date.now();
      response.once("finish", () => logger.info("HTTP request", {
        requestId,
        method,
        path: logPath,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
      }));
      ticketApp(request, response);
      return;
    }
    const startedAt = Date.now();

    try {
      if (method === "GET" && path === "/health/live") {
        sendJson(response, 200, { data: { status: "ok" }, requestId });
      } else if (method === "GET" && path === "/health/ready") {
        await store.checkReady();
        sendJson(response, 200, { data: { status: "ready" }, requestId });
      } else if (method === "GET" && path === "/api/v1/health") {
        sendJson(response, 200, { data: { status: "ok", version: "v1" }, requestId });
      } else if (path.startsWith("/api/v1/")) {
        await routeApi(request, response, path, method, requestId);
      } else {
        throw new AppError(404, "NOT_FOUND", "The requested resource was not found.");
      }
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : error instanceof JsonStorageError
          ? new AppError(503, error.code, "The data store is temporarily unavailable.")
          : new AppError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
      if (!(error instanceof AppError)) logger.error("Request failed", { requestId, error: error instanceof Error ? error.message : "unknown" });
      sendJson(response, appError.statusCode, {
        error: {
          code: appError.code,
          message: appError.message,
          requestId,
          ...(appError.fields ? { fields: appError.fields } : {}),
        },
      });
    } finally {
      logger.info("HTTP request", { requestId, method, path: logPath, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
    }
  }

  async function routeApi(request: IncomingMessage, response: ServerResponse, path: string, method: string, requestId: string) {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (path === "/api/v1/me" && method === "GET") {
      const principal = await requireAuthenticatedPrincipal(dependencies.authenticator, request);
      const organisationId = url.searchParams.get("organisationId") ?? undefined;
      const result = await identity.currentUser(principal.userId, organisationId);
      sendJson(response, 200, { data: {
        user: { id: result.user.id, email: result.user.email, displayName: result.user.displayName, status: result.user.status },
        organisations: result.organisations.map((organisation) => ({
          ...organisation,
          permissions: [...permissionPolicy.permissionsFor(organisation.roles)].sort(),
        })),
      }, requestId });
      return;
    }

    if (path === "/api/v1/roles" && method === "GET") {
      const principal = await requireAuthenticatedPrincipal(dependencies.authenticator, request);
      const tenant = await tenantFromRequest(request, principal.userId, url);
      requirePermission(permissionPolicy, tenant, "users.manage");
      sendJson(response, 200, { data: describeRoleCapabilities(permissionPolicy), requestId });
      return;
    }

    if (path === "/api/v1/organisations" && method === "GET") {
      const principal = await requireAuthenticatedPrincipal(dependencies.authenticator, request);
      await identity.currentUser(principal.userId);
      const result = await organisation.listForUser(principal.userId);
      sendPage(response, result, requestId, url);
      return;
    }

    if (path === "/api/v1/organisations" && method === "POST") {
      const principal = await requireAuthenticatedPrincipal(dependencies.authenticator, request);
      const tenant = await tenantFromRequest(request, principal.userId, url);
      requirePermission(permissionPolicy, tenant, "organisations.create");
      const body = await readJson(request);
      rejectUnknown(body, ["name"]);
      const name = requireString(body, "name");
      sendJson(response, 201, {
        data: await organisation.create({ name }, { userId: tenant.userId, role: ROLE_IDS.organisationAdmin }),
        requestId,
      });
      return;
    }

    const organisationMatch = path.match(/^\/api\/v1\/organisations\/([^/]+)$/);
    if (organisationMatch && (method === "GET" || method === "PATCH")) {
      const principal = await requireAuthenticatedPrincipal(dependencies.authenticator, request);
      if (method === "GET") {
        const tenant = await resolveTenant(principal.userId, organisationMatch[1]!);
        requirePermission(permissionPolicy, tenant, "organisation.read");
        const result = await organisation.get(tenant, organisationMatch[1]!);
        sendJson(response, 200, { data: result, requestId });
      } else {
        const tenant = await resolveOrganisationManagementTenant(principal.userId, organisationMatch[1]!);
        requirePermission(permissionPolicy, tenant, "organisation.update");
        const body = await readJson(request);
        const changes = validateOrganisationPatch(body);
        const result = await organisation.update(tenant, changes);
        sendJson(response, 200, { data: result, requestId });
      }
      return;
    }

    if (["/api/v1/users", "/api/v1/departments", "/api/v1/teams"].includes(path) && (method === "GET" || method === "POST")) {
      const principal = await requireAuthenticatedPrincipal(dependencies.authenticator, request);
      const tenant = await tenantFromRequest(request, principal.userId, url);
      if (path === "/api/v1/users" && method === "GET") {
        requirePermission(permissionPolicy, tenant, "users.read");
        const result = await identity.listUsers(tenant);
        sendPage(response, result.map(({ user, roles }) => ({
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          status: user.status,
          roles,
          permissions: [...permissionPolicy.permissionsFor(roles)].sort(),
        })), requestId, url);
      } else if (path === "/api/v1/users" && method === "POST") {
        requirePermission(permissionPolicy, tenant, "users.manage");
        const body = await readJson(request);
        rejectUnknown(body, ["email", "displayName", "roles"]);
        const email = requireString(body, "email").toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
          throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", [{ field: "email", message: "Provide a valid email address." }]);
        }
        const displayName = requireString(body, "displayName");
        const roles = requireRoleArray(body, "roles");
        const invited = await identity.inviteUser(tenant, email, displayName, roles);
        sendJson(response, 201, { data: {
          user: { id: invited.user.id, email: invited.user.email, displayName: invited.user.displayName, status: invited.user.status },
          membership: invited.membership,
          permissions: [...permissionPolicy.permissionsFor(invited.membership.roles)].sort(),
        }, requestId });
      } else if (path === "/api/v1/departments" && method === "GET") {
        requirePermission(permissionPolicy, tenant, "teams.read");
        sendPage(response, await teams.listDepartments(tenant), requestId, url);
      } else if (path === "/api/v1/departments" && method === "POST") {
        requirePermission(permissionPolicy, tenant, "teams.manage");
        const body = await readJson(request);
        rejectUnknown(body, ["name"]);
        sendJson(response, 201, { data: await teams.createDepartment(tenant, requireString(body, "name")), requestId });
      } else if (path === "/api/v1/teams" && method === "GET") {
        requirePermission(permissionPolicy, tenant, "teams.read");
        sendPage(response, await teams.listTeams(tenant), requestId, url);
      } else {
        requirePermission(permissionPolicy, tenant, "teams.manage");
        const body = await readJson(request);
        rejectUnknown(body, ["name", "departmentId"]);
        const departmentId = body.departmentId === undefined || body.departmentId === null ? null : requireString(body, "departmentId");
        sendJson(response, 201, { data: await teams.createTeam(tenant, requireString(body, "name"), departmentId), requestId });
      }
      return;
    }

    const userMatch = path.match(/^\/api\/v1\/users\/([^/]+)$/);
    if (userMatch && method === "GET") {
      const principal = await requireAuthenticatedPrincipal(dependencies.authenticator, request);
      const tenant = await tenantFromRequest(request, principal.userId, url);
      requirePermission(permissionPolicy, tenant, "users.read");
      const user = await identity.getUser(tenant, userMatch[1]!);
      const membership = await identity.getMembership(tenant, user.id);
      sendJson(response, 200, { data: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        roles: membership.roles,
        permissions: [...permissionPolicy.permissionsFor(membership.roles)].sort(),
      }, requestId });
      return;
    }
    if (userMatch && method === "PATCH") {
      const principal = await requireAuthenticatedPrincipal(dependencies.authenticator, request);
      const tenant = await tenantFromRequest(request, principal.userId, url);
      requirePermission(permissionPolicy, tenant, "users.manage");
      const body = await readJson(request);
      rejectUnknown(body, ["displayName"]);
      const userChanges: { displayName?: string } = {};
      if (body.displayName !== undefined) userChanges.displayName = requireString(body, "displayName");
      if (!Object.keys(userChanges).length) throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", [{ field: "body", message: "Provide a permitted field." }]);
      const updated = await identity.updateUser(tenant, userMatch[1]!, userChanges);
      sendJson(response, 200, { data: { id: updated.id, email: updated.email, displayName: updated.displayName, status: updated.status }, requestId });
      return;
    }

    const membershipMatch = path.match(/^\/api\/v1\/users\/([^/]+)\/memberships$/);
    if (membershipMatch && method === "PUT") {
      const principal = await requireAuthenticatedPrincipal(dependencies.authenticator, request);
      const tenant = await tenantFromRequest(request, principal.userId, url);
      requirePermission(permissionPolicy, tenant, "users.manage");
      const body = await readJson(request);
      rejectUnknown(body, ["status", "roles"]);
      const status = requireEnum(body, "status", ["active", "inactive", "suspended"] as const);
      const roles = requireRoleArray(body, "roles");
      const membership = await identity.setMembership(tenant, membershipMatch[1]!, status, roles);
      sendJson(response, 200, { data: { ...membership, permissions: [...permissionPolicy.permissionsFor(membership.roles)].sort() }, requestId });
      return;
    }

    const teamMatch = path.match(/^\/api\/v1\/teams\/([^/]+)$/);
    if (teamMatch && method === "PATCH") {
      const principal = await requireAuthenticatedPrincipal(dependencies.authenticator, request);
      const tenant = await tenantFromRequest(request, principal.userId, url);
      requirePermission(permissionPolicy, tenant, "teams.manage");
      const body = await readJson(request);
      rejectUnknown(body, ["name", "departmentId"]);
      const changes: { name?: string; departmentId?: string | null } = {};
      const unknownFields = Object.keys(body).filter((field) => !["name", "departmentId"].includes(field));
      if (unknownFields.length) throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", unknownFields.map((field) => ({ field, message: "This field cannot be updated." })));
      if (body.name !== undefined) changes.name = requireString(body, "name");
      if (body.departmentId !== undefined) changes.departmentId = body.departmentId === null ? null : requireString(body, "departmentId");
      if (!Object.keys(changes).length) throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", [{ field: "body", message: "Provide a permitted field." }]);
      sendJson(response, 200, { data: await teams.updateTeam(tenant, teamMatch[1]!, changes), requestId });
      return;
    }

    const teamMembersMatch = path.match(/^\/api\/v1\/teams\/([^/]+)\/members$/);
    if (teamMembersMatch && method === "GET") {
      const principal = await requireAuthenticatedPrincipal(dependencies.authenticator, request);
      const tenant = await tenantFromRequest(request, principal.userId, url);
      requirePermission(permissionPolicy, tenant, "teams.members.read");
      sendPage(response, await teams.listTeamMemberships(tenant, teamMembersMatch[1]!), requestId, url);
      return;
    }
    if (teamMembersMatch && method === "PUT") {
      const principal = await requireAuthenticatedPrincipal(dependencies.authenticator, request);
      const tenant = await tenantFromRequest(request, principal.userId, url);
      requirePermission(permissionPolicy, tenant, "teams.manage");
      const body = await readJson(request);
      const userId = requireString(body, "userId");
      const role = requireEnum(body, "role", ["support_lead", "support_agent", "requester"] as const);
      const status = requireEnum(body, "status", ["active", "inactive", "suspended"] as const);
      sendJson(response, 200, { data: await teams.setTeamMembership(tenant, teamMembersMatch[1]!, userId, role, status), requestId });
      return;
    }

    throw new AppError(404, "NOT_FOUND", "The requested resource was not found.");
  }

  async function resolveTenant(userId: string, organisationId: string): Promise<TenantContext> {
    const resolver = dependencies.tenantResolver ?? identity;
    return requireTenantContext(resolver, userId, organisationId);
  }

  async function resolveOrganisationManagementTenant(userId: string, organisationId: string): Promise<TenantContext> {
    const resolver = dependencies.tenantResolver ?? identity;
    const tenant = resolver.resolveForOrganisationManagement
      ? await resolver.resolveForOrganisationManagement(userId, organisationId)
      : await resolver.resolve(userId, organisationId);
    if (!tenant) throw new AppError(403, "ORGANISATION_ACCESS_DENIED", "You do not have access to this organisation.");
    return tenant;
  }

  async function tenantFromRequest(request: IncomingMessage, userId: string, url: URL): Promise<TenantContext> {
    const selected = url.searchParams.get("organisationId") ?? request.headers["x-organisation-id"];
    if (typeof selected !== "string" || selected.trim().length === 0) {
      throw new AppError(400, "ORGANISATION_REQUIRED", "Select an organisation to continue.");
    }
    return resolveTenant(userId, selected);
  }

  async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1024 * 1024) throw new AppError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
      chunks.push(buffer);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AppError(400, "VALIDATION_ERROR", "The request body must be valid JSON.", [{ field: "body", message: "Provide a valid JSON object." }]);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new AppError(400, "VALIDATION_ERROR", "The request body must be a JSON object.", [{ field: "body", message: "Provide a JSON object." }]);
    }
    return body as Record<string, unknown>;
  }

  function requireString(body: Record<string, unknown>, field: string): string {
    return requireNonEmptyString(body[field], field);
  }

  function requireEnum<const T extends readonly string[]>(body: Record<string, unknown>, field: string, values: T): T[number] {
    const value = body[field];
    if (typeof value !== "string" || !values.includes(value)) {
      throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", [{ field, message: `${field} must be one of: ${values.join(", ")}.` }]);
    }
    return value as T[number];
  }

  function requireStringArray(body: Record<string, unknown>, field: string): string[] {
    const value = body[field];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
      throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", [{ field, message: `${field} must be an array of non-empty strings.` }]);
    }
    return [...new Set(value.map((item) => item.trim()))];
  }

  function rejectUnknown(body: Record<string, unknown>, allowed: readonly string[]) {
    rejectUnknownFields(body, allowed);
  }

  function requireRoleArray(body: Record<string, unknown>, field: string): string[] {
    const values = requireStringArray(body, field);
    if (values.length === 0) {
      throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", [{ field, message: "Assign at least one role." }]);
    }
    const allowed = new Set<string>(Object.values(ROLE_IDS));
    if (values.some((role) => !allowed.has(role))) {
      throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", [{ field, message: "One or more role identifiers are not supported." }]);
    }
    return values;
  }

  function validateOrganisationPatch(body: Record<string, unknown>) {
    const allowed = new Set(["name", "settings", "status"]);
    const unexpected = Object.keys(body).filter((key) => !allowed.has(key));
    if (unexpected.length) throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", unexpected.map((field) => ({ field, message: "This field cannot be updated." })));
    const changes: { name?: string; settings?: Record<string, unknown>; status?: "active" | "inactive" | "suspended" } = {};
    if (body.name !== undefined) changes.name = requireString(body, "name");
    if (body.status !== undefined) changes.status = requireEnum(body, "status", ["active", "inactive", "suspended"] as const);
    if (body.settings !== undefined) {
      if (typeof body.settings !== "object" || body.settings === null || Array.isArray(body.settings)) {
        throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", [{ field: "settings", message: "Settings must be an object." }]);
      }
      changes.settings = body.settings as Record<string, unknown>;
    }
    if (!Object.keys(changes).length) throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", [{ field: "body", message: "Provide at least one permitted field." }]);
    return changes;
  }

  return createServer((request, response) => { void handle(request, response); });
}

function isTicketModulePath(path: string): boolean {
  return [
    "/api/v1/ai",
    "/api/v1/tickets",
    "/api/v1/documents",
    "/api/v1/extracted-rules",
    "/api/v1/sla-policies",
    "/api/v1/sla",
    "/api/v1/reports",
    "/api/v1/ticket-workflows",
  ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
