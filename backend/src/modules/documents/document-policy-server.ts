import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createJsonTenantStore } from '../../infrastructure/persistence/json/json-store.js';
import { createLocalPrivateStorageAdapter } from './storage/document-storage.js';
import {
  createDocumentPolicyApi,
  loadDocumentPolicyDevelopmentPrincipal,
} from './document-policy-api.js';

export function startDocumentPolicyServer(
  environment: Record<string, string | undefined> = process.env,
): void {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const backendDirectory = resolve(moduleDirectory, '../../..');
  const dataDirectory = resolve(backendDirectory, environment.DATA_DIRECTORY ?? '.local-data');
  const port = parsePort(environment.DOCUMENT_POLICY_PORT ?? environment.PORT);
  const store = createJsonTenantStore(dataDirectory);

  const server = createServer(createDocumentPolicyApi({
    store,
    storage: createLocalPrivateStorageAdapter(dataDirectory),
    developmentPrincipal: loadDocumentPolicyDevelopmentPrincipal(environment),
  }));
  server.listen(port, '127.0.0.1');
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8001;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DOCUMENT_POLICY_PORT must be an integer between 1 and 65535.');
  }
  return port;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startDocumentPolicyServer();
}
