import type { Server } from "node:http";
import { createIntegratedApp } from "./integrated-app.js";
import { loadEnvironment, type Environment } from "./config/env.ts";
import { KeycloakAuthenticationProvider } from "./infrastructure/auth/keycloak-authentication.ts";
import { KeycloakUserProvisioningProvider } from "./infrastructure/auth/keycloak-user-provisioning.ts";

/** Creates the single HTTP server for foundation and Express domain modules. */
export function createConfiguredServer(environment: Environment = loadEnvironment()): Server {
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
  return createIntegratedApp(environment, {
    ...(authenticator ? { authenticator } : {}),
    ...(userProvisioner ? { userProvisioner } : {}),
  });
}
