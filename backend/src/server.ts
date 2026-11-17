import { createApp } from "./app.ts";
import { loadEnvironment } from "./config/env.ts";
import { createLogger } from "./config/logger.ts";
import { KeycloakAuthenticationProvider } from "./infrastructure/auth/keycloak-authentication.ts";
import { KeycloakUserProvisioningProvider } from "./infrastructure/auth/keycloak-user-provisioning.ts";

const environment = loadEnvironment();
const logger = createLogger(environment.logLevel);
const authenticator = environment.authMode === "keycloak"
  ? new KeycloakAuthenticationProvider({
    issuer: environment.authIssuer!,
    audience: environment.authAudience!,
    ...(environment.authJwksUri ? { jwksUri: environment.authJwksUri } : {}),
  })
  : undefined;
const userProvisioner = environment.authIssuer && environment.keycloakAdminClientId && environment.keycloakAdminClientSecret
  ? new KeycloakUserProvisioningProvider({
    issuer: environment.authIssuer,
    clientId: environment.keycloakAdminClientId,
    clientSecret: environment.keycloakAdminClientSecret,
  })
  : undefined;
const server = createApp(environment, {
  ...(authenticator ? { authenticator } : {}),
  ...(userProvisioner ? { userProvisioner } : {}),
});

server.listen(environment.port, environment.host, () => {
  logger.info("API server listening", { host: environment.host, port: environment.port, apiBasePath: "/api/v1", authMode: environment.authMode });
});

function shutdown(signal: string) {
  logger.info("API server shutting down", { signal });
  server.close((error) => {
    if (error) {
      logger.error("API server shutdown failed", { error: error.message });
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
