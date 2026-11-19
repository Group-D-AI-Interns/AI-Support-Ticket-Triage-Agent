import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  rootDir: string;
}

export function createJsonTenantStore(rootDir: string): JsonTenantStore {
  const store: JsonTenantStore = {
    rootDir,
    async readCollection<T>(collection: JsonCollectionName): Promise<T[]> {
      const filePath = join(rootDir, `${collection}.json`);
      try {
        const text = await readFile(filePath, 'utf8');
        if (!text.trim()) {
          return [] as T[];
        }
        const parsed = JSON.parse(text) as { records?: T[] } | T[];
        return Array.isArray(parsed) ? parsed : (parsed.records ?? []);
      } catch {
        return [] as T[];
      }
    },
    async writeCollection<T>(collection: JsonCollectionName, records: T[]): Promise<void> {
      await mkdir(rootDir, { recursive: true });
      const filePath = join(rootDir, `${collection}.json`);
      const payload = {
        schemaVersion: 1,
        records,
      };
      await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    },
  };

  return store;
}
