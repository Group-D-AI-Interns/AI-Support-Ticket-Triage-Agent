import { createApp, type AppDependencies } from './app.js';
import type { Environment } from './config/env.js';
import { JsonFileStore } from './infrastructure/persistence/json/json-file-store.js';
import { IdentityService } from './modules/identity/service.js';
import { JsonIdentityRepository } from './modules/identity/repositories.js';
import { JsonTeamRepository } from './modules/teams/repositories.js';
import { createTicketApp, type TicketAppOptions } from './modules/tickets/api.js';
import { jiraSettingsFromEnvironment } from './modules/tickets/config.js';
import { JsonAiAnalysisRepository } from './modules/ai/json-ai-analysis.repository.js';

/** One HTTP server; business routes use verified identity and server-side membership. */
export function createIntegratedApp(
  environment: Environment,
  dependencies: AppDependencies = {},
  moduleOptions: Omit<TicketAppOptions, 'authenticateRequest' | 'developmentPrincipal' | 'analysisRepository'> = {},
) {
  const store = new JsonFileStore(environment.dataDirectory, environment.jsonWriteLockTimeoutMs);
  const identity = new IdentityService(new JsonIdentityRepository(store), dependencies.userProvisioner);
  const teams = new JsonTeamRepository(store);
  const resolver = dependencies.tenantResolver ?? identity;
  const settings = moduleOptions.settings ?? (process.env.JIRA_TENANT_CONFIG
    ? jiraSettingsFromEnvironment({ ...process.env, DATA_DIRECTORY: environment.dataDirectory })
    : { dataDirectory: environment.dataDirectory, projectMappings: {}, organisations: {} });
  const modules = createTicketApp({
    ...moduleOptions,
    settings: { ...settings, dataDirectory: environment.dataDirectory },
    developmentPrincipal: null,
    analysisRepository: new JsonAiAnalysisRepository(store),
    ...(dependencies.authenticator ? { authenticator: dependencies.authenticator } : {}),
    tenantResolver: resolver,
    listTeamIdsForUser: (tenant, userId) => teams.listTeamIdsForUser(tenant, userId),
    ...(dependencies.authorization ? { authorization: dependencies.authorization } : {}),
  });
  const server = createApp(environment, { ...dependencies, tenantResolver: resolver, moduleHandler: modules });
  server.on('listening', () => modules.locals.aiWorker.start());
  server.on('close', () => modules.locals.aiWorker.stop());
  return server;
}
