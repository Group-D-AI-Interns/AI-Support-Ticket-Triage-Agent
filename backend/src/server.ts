import type { Server } from "node:http";
import { createIntegratedApp } from "./integrated-app.js";
import { loadEnvironment, type Environment } from "./config/env.ts";
import { KeycloakAuthenticationProvider } from "./infrastructure/auth/keycloak-authentication.ts";
import { KeycloakUserProvisioningProvider } from "./infrastructure/auth/keycloak-user-provisioning.ts";
import { JsonFileStore } from "./infrastructure/persistence/json/json-file-store.ts";
import { createLogger } from "./config/logger.ts";
import { JsonOrganisationRepository } from "./modules/organisations/repositories.ts";
import { MongoDatabase } from "./infrastructure/persistence/mongodb/mongo-database.ts";
import { MongoFileStore } from "./infrastructure/persistence/mongodb/mongo-file-store.ts";
import { MongoTicketStore, MongoTicketWorkflowStore } from "./infrastructure/persistence/mongodb/mongo-ticket-stores.ts";
import { createJsonTenantStore } from "./infrastructure/persistence/json/json-store.ts";
import { JsonAiAnalysisRepository } from "./modules/ai/json-ai-analysis.repository.ts";

/** Creates the single HTTP server for foundation and Express domain modules. */
export async function createConfiguredServer(environment: Environment = loadEnvironment()): Promise<Server> {
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
  const mongoDatabase = environment.databaseProvider === "mongodb"
    ? new MongoDatabase(environment.mongodbUri!, environment.mongodbDatabase!)
    : undefined;
  const store = mongoDatabase
    ? new MongoFileStore(mongoDatabase, environment.dataDirectory)
    : undefined;
  if (store) {
    try {
      await store.initialize();
    } catch {
      await mongoDatabase?.close();
      throw new Error('MongoDB initialization failed; verify Atlas connectivity, credentials, and database permissions.');
    }
  }
  if (!store && environment.nodeEnv !== "test") {
    throw new Error("MongoDB is required for the application server. JSON persistence is permitted only in tests.");
  }
  const applicationStore = store ?? new JsonFileStore(
    environment.dataDirectory,
    environment.jsonWriteLockTimeoutMs,
  );
  const organisations = new JsonOrganisationRepository(applicationStore);
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
  let server: Server;
  try {
    server = createIntegratedApp(environment, {
      ...(authenticator ? { authenticator } : {}),
      ...(userProvisioner ? { userProvisioner } : {}),
      ...(store ? { fileStore: store } : {}),
    }, {
      ...moduleOptions,
      ...(store && mongoDatabase ? {
        fileStore: store,
        tenantStore: createJsonTenantStore(store),
        ticketStore: new MongoTicketStore(mongoDatabase),
        ticketWorkflowStore: new MongoTicketWorkflowStore(mongoDatabase),
        analysisRepository: new JsonAiAnalysisRepository(store),
      } : {}),
    });
  } catch (error) {
    await mongoDatabase?.close();
    throw error;
  }
  if (mongoDatabase) {
    const closeApplicationServer = server.close.bind(server);
    server.close = ((callback?: (error?: Error) => void) => {
      closeApplicationServer(error => {
        if (error) {
          callback?.(error);
          return;
        }
        void mongoDatabase.close().then(() => callback?.()).catch(error => {
          callback?.(error instanceof Error ? error : new Error('MongoDB client did not close cleanly.'));
        });
      });
      return server;
    }) as typeof server.close;
  }
  return server;
}
