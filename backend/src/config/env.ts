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
  databaseProvider: "json" | "mongodb";
  mongodbUri?: string;
  mongodbDatabase?: string;
  jsonWriteLockTimeoutMs: number;
  slaEvaluationIntervalMs: number;
};

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const nodeEnv = source.NODE_ENV ?? "development";
  const logLevel = source.LOG_LEVEL ?? "info";
  const authMode = source.AUTH_MODE ?? "disabled";
  const port = Number(source.PORT ?? "3000");
  const jsonWriteLockTimeoutMs = Number(source.JSON_WRITE_LOCK_TIMEOUT_MS ?? "5000");
  const slaEvaluationIntervalMs = Number(source.SLA_EVALUATION_INTERVAL_MS ?? "300000");
  // The application uses MongoDB in development and production. JSON is an
  // explicit test-fixture adapter only; local demos use isolated test data.
  const databaseProvider = source.DATABASE_PROVIDER ?? (nodeEnv === "test" ? "json" : "mongodb");
  const mongodbUri = source.MONGODB_URI?.trim();
  const mongodbDatabase = source.MONGODB_DATABASE?.trim();

  if (!["development", "test", "production"].includes(nodeEnv)) throw new Error("NODE_ENV must be development, test, or production");
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  if (!["disabled", "keycloak"].includes(authMode)) throw new Error("AUTH_MODE must be disabled or keycloak");
  if (!["json", "mongodb"].includes(databaseProvider)) throw new Error("DATABASE_PROVIDER must be json or mongodb");
  if (nodeEnv !== "test" && databaseProvider !== "mongodb") throw new Error("DATABASE_PROVIDER=mongodb is required outside the test environment; JSON persistence is test-only");
  if (nodeEnv === "production" && authMode !== "keycloak") throw new Error("AUTH_MODE=keycloak is required in production");
  if (databaseProvider === "mongodb") {
    if (!mongodbUri || !mongodbDatabase) throw new Error("MONGODB_URI and MONGODB_DATABASE are required when DATABASE_PROVIDER=mongodb");
    let parsed: URL;
    try { parsed = new URL(mongodbUri); } catch { throw new Error("MONGODB_URI must be a valid MongoDB connection URI"); }
    if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) throw new Error("MONGODB_URI must use mongodb:// or mongodb+srv://");
    if (nodeEnv === "production" && parsed.protocol !== "mongodb+srv:") throw new Error("MONGODB_URI must use MongoDB Atlas SRV (mongodb+srv://) in production");
    if (nodeEnv === "production" && ["localhost", "127.0.0.1"].includes(parsed.hostname)) throw new Error("A local MongoDB address cannot be used in production");
    if (!/^[a-zA-Z0-9_-]{1,63}$/.test(mongodbDatabase)) throw new Error("MONGODB_DATABASE must be a valid database name");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer between 0 and 65535");
  if (!Number.isInteger(jsonWriteLockTimeoutMs) || jsonWriteLockTimeoutMs < 1 || jsonWriteLockTimeoutMs > 60000) throw new Error("JSON_WRITE_LOCK_TIMEOUT_MS must be an integer between 1 and 60000");
  if (!Number.isInteger(slaEvaluationIntervalMs) || slaEvaluationIntervalMs < 1000 || slaEvaluationIntervalMs > 86400000) throw new Error("SLA_EVALUATION_INTERVAL_MS must be an integer between 1000 and 86400000");
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
    databaseProvider: databaseProvider as Environment["databaseProvider"],
    ...(mongodbUri ? { mongodbUri } : {}),
    ...(mongodbDatabase ? { mongodbDatabase } : {}),
    jsonWriteLockTimeoutMs,
    slaEvaluationIntervalMs,
  };
}
