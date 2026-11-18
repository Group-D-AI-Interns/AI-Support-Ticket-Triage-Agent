export type Environment = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  authMode: "disabled" | "keycloak";
  authIssuer?: string;
  authAudience?: string;
  authJwksUri?: string;
  keycloakAdminClientId?: string;
  keycloakAdminClientSecret?: string;
  dataDirectory: string;
  jsonWriteLockTimeoutMs: number;
};

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const nodeEnv = source.NODE_ENV ?? "development";
  const logLevel = source.LOG_LEVEL ?? "info";
  const authMode = source.AUTH_MODE ?? "disabled";
  const port = Number(source.PORT ?? "3000");
  const jsonWriteLockTimeoutMs = Number(source.JSON_WRITE_LOCK_TIMEOUT_MS ?? "5000");

  if (!["development", "test", "production"].includes(nodeEnv)) throw new Error("NODE_ENV must be development, test, or production");
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  if (!["disabled", "keycloak"].includes(authMode)) throw new Error("AUTH_MODE must be disabled or keycloak");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer between 0 and 65535");
  if (!Number.isInteger(jsonWriteLockTimeoutMs) || jsonWriteLockTimeoutMs < 1 || jsonWriteLockTimeoutMs > 60000) throw new Error("JSON_WRITE_LOCK_TIMEOUT_MS must be an integer between 1 and 60000");
  const authIssuer = source.AUTH_ISSUER?.trim();
  const authAudience = source.AUTH_AUDIENCE?.trim();
  const authJwksUri = source.AUTH_JWKS_URI?.trim();
  const keycloakAdminClientId = source.KEYCLOAK_ADMIN_CLIENT_ID?.trim();
  const keycloakAdminClientSecret = source.KEYCLOAK_ADMIN_CLIENT_SECRET;
  if (authMode === "keycloak") {
    if (!authIssuer || !authAudience) throw new Error("AUTH_ISSUER and AUTH_AUDIENCE are required when AUTH_MODE=keycloak");
    for (const [key, value] of [["AUTH_ISSUER", authIssuer], ["AUTH_JWKS_URI", authJwksUri]] as const) {
      if (!value) continue;
      let parsed: URL;
      try { parsed = new URL(value); } catch { throw new Error(`${key} must be an absolute URL`); }
      if (parsed.protocol !== "https:" && !(nodeEnv !== "production" && parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
        throw new Error(`${key} must use HTTPS (HTTP is allowed only for local development)`);
      }
    }
  }
  if (Boolean(keycloakAdminClientId) !== Boolean(keycloakAdminClientSecret)) throw new Error("KEYCLOAK_ADMIN_CLIENT_ID and KEYCLOAK_ADMIN_CLIENT_SECRET must be configured together");

  return {
    nodeEnv: nodeEnv as Environment["nodeEnv"],
    host: source.HOST ?? "127.0.0.1",
    port,
    logLevel: logLevel as Environment["logLevel"],
    authMode: authMode as Environment["authMode"],
    ...(authIssuer ? { authIssuer } : {}),
    ...(authAudience ? { authAudience } : {}),
    ...(authJwksUri ? { authJwksUri } : {}),
    ...(keycloakAdminClientId ? { keycloakAdminClientId } : {}),
    ...(keycloakAdminClientSecret ? { keycloakAdminClientSecret } : {}),
    dataDirectory: source.DATA_DIRECTORY ?? "./.local-data",
    jsonWriteLockTimeoutMs,
  };
}
