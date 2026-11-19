import { JsonFileStore, type JsonEnvelope } from './json-file-store.js';

export type JsonCollectionName =
  | 'documents'
  | 'documentVersions'
  | 'policies'
  | 'policyVersions'
  | 'extractedRules'
  | 'policyApprovals'
  | 'auditLogs'
  | 'extractionJobs'
  | 'documentExtractions'
  | 'slaEvaluations';

export interface JsonTenantStore {
  readCollection<T>(collection: JsonCollectionName): Promise<T[]>;
  writeCollection<T>(collection: JsonCollectionName, records: T[]): Promise<void>;
  withCollectionLock<R>(collection: JsonCollectionName, operation: () => Promise<R>): Promise<R>;
  rootDir: string;
}

function isCollection(value: unknown): value is JsonEnvelope<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as { schemaVersion?: unknown; records?: unknown };
  return envelope.schemaVersion === 1 && Array.isArray(envelope.records) && envelope.records.every(
    (record: unknown) => record !== null && typeof record === 'object' && !Array.isArray(record) &&
      'id' in record && typeof record.id === 'string' && record.id.trim().length > 0,
  );
}

/** Compatibility boundary preserving existing filenames, backed by the shared safe store. */
export function createJsonTenantStore(rootDir: string): JsonTenantStore {
  const files = new JsonFileStore(rootDir);
  return {
    rootDir,
    async readCollection<T>(collection: JsonCollectionName): Promise<T[]> {
      return (await files.read(`${collection}.json`, isCollection)).records as T[];
    },
    async writeCollection<T>(collection: JsonCollectionName, records: T[]): Promise<void> {
      if (!isCollection({ schemaVersion: 1, records })) {
        throw new Error('Collection records must have non-empty string IDs.');
      }
      await files.write(`${collection}.json`, { schemaVersion: 1, records });
    },
    async withCollectionLock<R>(collection: JsonCollectionName, operation: () => Promise<R>): Promise<R> {
      return files.runExclusive(`${collection}-operation.json`, operation);
    },
  };
}
