import { createApp, type AppDependencies } from './app.js';
import type { Environment } from './config/env.js';
import { JsonFileStore } from './infrastructure/persistence/json/json-file-store.js';
import { IdentityService } from './modules/identity/service.js';
import { JsonIdentityRepository } from './modules/identity/repositories.js';
import { JsonTeamRepository } from './modules/teams/repositories.js';
import { createTicketApp, stopTicketApp, type TicketAppOptions } from './modules/tickets/api.js';
import { JsonAiAnalysisRepository } from './modules/ai/json-ai-analysis.repository.js';

/** One HTTP server; business routes use verified identity and server-side membership. */
export function createIntegratedApp(
  environment: Environment,
  dependencies: AppDependencies = {},
  moduleOptions: Omit<TicketAppOptions, 'authenticateRequest' | 'developmentPrincipal'> = {},
) {
  if (!dependencies.fileStore && environment.databaseProvider !== 'json') {
    throw new Error('MongoDB persistence must be provided by createConfiguredServer; this factory only uses JSON in the test environment.');
  }
  const store = dependencies.fileStore ?? new JsonFileStore(environment.dataDirectory, environment.jsonWriteLockTimeoutMs);
  const identity = new IdentityService(new JsonIdentityRepository(store), dependencies.userProvisioner);
  const teams = new JsonTeamRepository(store);
  const resolver = dependencies.tenantResolver ?? identity;
  const modules = createTicketApp({
    ...moduleOptions,
    dataDirectory: environment.dataDirectory,
    developmentPrincipal: null,
    analysisRepository: moduleOptions.analysisRepository ?? new JsonAiAnalysisRepository(store),
    ...(dependencies.authenticator ? { authenticator: dependencies.authenticator } : {}),
    tenantResolver: resolver,
    listTeamIdsForUser: (tenant, userId) => teams.listTeamIdsForUser(tenant, userId),
    ...(dependencies.authorization ? { authorization: dependencies.authorization } : {}),
  });
  const server = createApp(environment, {
    ...dependencies,
    tenantResolver: resolver,
    fileStore: store,
    moduleHandler: modules,
  });
  server.once('listening', () => modules.locals.aiWorker.start());
  const closeHttpServer = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    closeHttpServer(error => {
      if (error) {
        callback?.(error);
        return;
      }
      void Promise.all([
        modules.locals.aiWorker.stop(),
        stopTicketApp(modules),
      ]).then(() => callback?.()).catch(error => {
        callback?.(error instanceof Error ? error : new Error('Background workers did not shut down cleanly.'));
      });
    });
    return server;
  }) as typeof server.close;
  return server;
}
