import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadDevelopmentPrincipal } from './development-auth.js';
import { loadJiraSettings } from './jira-config.js';
import { createTicketApi } from './ticket-api.js';
import { TicketJsonStore } from './ticket-json-store.js';

export function startTicketServer(
  environment: Record<string, string | undefined> = process.env,
): void {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const backendDirectory = resolve(moduleDirectory, '../../..');
  const configuredDataDirectory = environment.DATA_DIRECTORY ?? '.local-data';
  const dataDirectory = resolve(backendDirectory, configuredDataDirectory);
  const port = parsePort(environment.PORT);
  const store = new TicketJsonStore(dataDirectory);
  const jiraSettings = loadJiraSettings(environment);
  const developmentPrincipal = loadDevelopmentPrincipal(environment);

  const server = createServer(createTicketApi({
    store,
    jiraSettings,
    developmentPrincipal,
  }));
  server.listen(port, '127.0.0.1');
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 8000;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  startTicketServer();
}
