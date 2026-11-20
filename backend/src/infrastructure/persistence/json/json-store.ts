import { JsonFileStore, JsonStorageError, type JsonEnvelope } from './json-file-store.js';

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
  updateCollection<T, R>(collection: JsonCollectionName, mutate: (records: T[]) => R | Promise<R>): Promise<R>;
  withCollectionLock<R>(collection: JsonCollectionName, operation: () => Promise<R>): Promise<R>;
  rootDir: string;
}

type TenantRecord = { id: string; organisationId: string };

function isTenantRecord(value: unknown): value is TenantRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && record.id.length > 0 &&
    typeof record.organisationId === 'string' && record.organisationId.length > 0;
}

function isTenantEnvelope(value: unknown): value is JsonEnvelope<TenantRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const envelope = value as { schemaVersion?: unknown; records?: unknown };
  return envelope.schemaVersion === 1 && Array.isArray(envelope.records) && envelope.records.every(isTenantRecord);
}

function migrateLegacyArray(value: unknown): JsonEnvelope<TenantRecord> | null {
  return Array.isArray(value) && value.every(isTenantRecord)
    ? { schemaVersion: 1, records: value }
    : null;
}

/** Compatibility boundary preserving existing filenames, backed by the shared safe store. */
export function createJsonTenantStore(storeOrRootDir: JsonFileStore | string, lockTimeoutMs = 5000): JsonTenantStore {
  const files = typeof storeOrRootDir === 'string'
    ? new JsonFileStore(storeOrRootDir, lockTimeoutMs)
    : storeOrRootDir;

  return {
    rootDir: files.rootDir,
    async readCollection<T>(collection: JsonCollectionName): Promise<T[]> {
      const envelope = await files.read<TenantRecord>(
        `${collection}.json`,
        isTenantEnvelope,
        migrateLegacyArray,
      );
      return envelope.records as T[];
    },
    async writeCollection<T>(collection: JsonCollectionName, records: T[]): Promise<void> {
      const envelope: JsonEnvelope<T> = { schemaVersion: 1, records };
      if (!isTenantEnvelope(envelope)) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Collection ${collection} contains invalid tenant records.`);
      }
      await files.write(`${collection}.json`, envelope);
    },
    async updateCollection<T, R>(collection: JsonCollectionName, mutate: (records: T[]) => R | Promise<R>): Promise<R> {
      return files.update<TenantRecord, R>(
        `${collection}.json`,
        isTenantEnvelope,
        (envelope) => mutate(envelope.records as T[]),
        migrateLegacyArray,
      );
    },
    async withCollectionLock<R>(collection: JsonCollectionName, operation: () => Promise<R>): Promise<R> {
      return files.runExclusive(`${collection}-operation.json`, operation);
    },
  };
}
