import type { Server } from "node:http";
import { createIntegratedApp } from "./integrated-app.js";
import { loadEnvironment, type Environment } from "./config/env.ts";
import { KeycloakAuthenticationProvider } from "./infrastructure/auth/keycloak-authentication.ts";
import { KeycloakUserProvisioningProvider } from "./infrastructure/auth/keycloak-user-provisioning.ts";
import { JsonFileStore } from "./infrastructure/persistence/json/json-file-store.ts";
import { createLogger } from "./config/logger.ts";
import { JsonOrganisationRepository } from "./modules/organisations/repositories.ts";

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
  const organisations = new JsonOrganisationRepository(
    new JsonFileStore(
      environment.dataDirectory,
      environment.jsonWriteLockTimeoutMs,
    ),
  );
  const moduleOptions = environment.nodeEnv === "test"
    ? {}
    : {
      slaEvaluationWorker: {
        intervalMs: environment.slaEvaluationIntervalMs,
        listOrganisationIds: async () =>
          (await organisations.listAll())
            .filter((organisation) => organisation.status === "active")
            .map((organisation) => organisation.id),
        logger: createLogger(environment.logLevel),
      },
    };
  return createIntegratedApp(environment, {
    ...(authenticator ? { authenticator } : {}),
    ...(userProvisioner ? { userProvisioner } : {}),
  }, moduleOptions);
}
