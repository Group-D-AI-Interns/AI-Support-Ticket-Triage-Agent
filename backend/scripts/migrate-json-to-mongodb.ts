import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { MongoDatabase } from '../src/infrastructure/persistence/mongodb/mongo-database.ts';
import { MongoFileStore } from '../src/infrastructure/persistence/mongodb/mongo-file-store.ts';
import { assertEmptyApplicationDatabase, importAndVerifyCollections, normalizeMigrationRecords, validateMigrationCollection } from './migration-support.ts';

const supportedCollections = new Set([
  'organisations', 'users', 'memberships', 'departments', 'teams', 'team-memberships',
  'tickets', 'ticket-workflows', 'documents', 'documentVersions', 'policies',
  'policyVersions', 'extractedRules', 'policyApprovals', 'auditLogs', 'extractionJobs',
  'documentExtractions', 'slaEvaluations', 'ai-analyses', 'ai-workflow-runs', 'ai-operations',
]);

const apply = process.argv.includes('--apply');
const sourceArgument = process.argv.indexOf('--source');
const sourceDirectory = resolve(sourceArgument >= 0 ? process.argv[sourceArgument + 1] ?? '' : process.env.DATA_DIRECTORY ?? './.local-data');
const files = (await readdir(sourceDirectory, { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.json') && supportedCollections.has(entry.name.slice(0, -5)))
  .sort((left, right) => left.name.localeCompare(right.name));
if (files.length === 0) throw new Error('No supported application collections were found; refusing an empty migration.');

const sources: Array<{ name: string; records: Record<string, unknown>[] }> = [];
for (const file of files) {
  const parsed: unknown = JSON.parse(await readFile(join(sourceDirectory, file.name), 'utf8'));
  const records = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && (parsed as { schemaVersion?: unknown }).schemaVersion === 1 && Array.isArray((parsed as { records?: unknown }).records)
      ? (parsed as { records: unknown[] }).records
      : null;
  const collectionName = file.name.slice(0, -5);
  if (!validateMigrationCollection(collectionName, records)) {
    throw new Error(`Source collection ${file.name} is invalid; migration stopped without changing it.`);
  }
  sources.push({ name: collectionName, records: normalizeMigrationRecords(collectionName, records) });
}

for (const source of sources) console.log(`${source.name}: ${source.records.length} records`);
console.log(`Read ${sources.length} supported collections from the source directory.`);
if (!apply) {
  console.log('Dry run only. Records were validated against supported schemas. Review a protected source backup, then pass --apply to import into an empty MongoDB database.');
} else {
  const uri = process.env.MONGODB_URI?.trim();
  const databaseName = process.env.MONGODB_DATABASE?.trim();
  if (!uri || !databaseName) throw new Error('MONGODB_URI and MONGODB_DATABASE are required for --apply.');
  const database = new MongoDatabase(uri, databaseName);
  try {
    await database.connect();
    await assertEmptyApplicationDatabase(database);
    const store = new MongoFileStore(database, sourceDirectory);
    await store.initialize();
    await importAndVerifyCollections(database, store, sources);
    console.log('Import completed and per-collection counts were verified. Source files were left unchanged. Verify application behavior before switching production traffic.');
  } finally {
    await database.close();
  }
}
