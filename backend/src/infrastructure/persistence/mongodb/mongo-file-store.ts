import type { ClientSession, Document } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import {
  JsonStorageError,
  type JsonEnvelope,
  type JsonEnvelopeMigration,
  type JsonFileStorePort,
  type RecordQuery,
} from '../json/json-file-store.js';
import { MongoDatabase, mongoCollectionName } from './mongo-database.js';
import { MongoTicketStore } from './mongo-ticket-stores.js';

const indexedCollections = [
  'organisations', 'users', 'memberships', 'departments', 'teams', 'team-memberships',
  'documents', 'documentVersions', 'policies', 'policyVersions', 'extractedRules',
  'policyApprovals', 'auditLogs', 'extractionJobs', 'documentExtractions',
  'slaEvaluations', 'ai-analyses', 'ai-workflow-runs', 'ai-operations',
  'ticket-workflows',
];
type StoredMongoDocument = Document & { _id: string };

/** MongoDB implementation of the existing envelope persistence port. */
export class MongoFileStore implements JsonFileStorePort {
  constructor(readonly database: MongoDatabase, readonly rootDir: string) {}

  async initialize(): Promise<void> {
    await this.database.connect();
    for (const name of indexedCollections) {
      await this.database.db.collection(mongoCollectionName(name)).createIndex(
        { organisationId: 1 },
        { name: 'tenant_organisationId', sparse: true },
      );
    }
    await this.database.db.collection(mongoCollectionName('users')).createIndex(
      { email: 1 },
      { name: 'user_email_unique_case_insensitive', unique: true, collation: { locale: 'en', strength: 2 } },
    );
    await this.database.db.collection(mongoCollectionName('organisations')).createIndex(
      { name: 1 },
      { name: 'organisation_name_unique_case_insensitive', unique: true, collation: { locale: 'en', strength: 2 } },
    );
    await this.database.db.collection(mongoCollectionName('memberships')).createIndex(
      { organisationId: 1, userId: 1 },
      { name: 'tenant_user_membership', unique: true },
    );
    await this.database.db.collection(mongoCollectionName('memberships')).createIndex(
      { organisationId: 1, status: 1, userId: 1 },
      { name: 'tenant_active_memberships' },
    );
    await this.database.db.collection(mongoCollectionName('memberships')).createIndex(
      { userId: 1, status: 1, organisationId: 1 },
      { name: 'user_active_memberships' },
    );
    await this.database.db.collection(mongoCollectionName('team-memberships')).createIndex(
      { organisationId: 1, teamId: 1, userId: 1 },
      { name: 'tenant_team_user_membership', unique: true },
    );
    await this.database.db.collection(mongoCollectionName('documentVersions')).createIndex(
      { organisationId: 1, documentId: 1, version: 1 },
      { name: 'tenant_document_version', unique: true },
    );
    await this.database.db.collection(mongoCollectionName('documents')).createIndex(
      { organisationId: 1, status: 1, createdAt: -1 },
      { name: 'tenant_document_status_created' },
    );
    await this.database.db.collection(mongoCollectionName('extractionJobs')).createIndex(
      { organisationId: 1, documentId: 1, documentVersionId: 1, policyVersionId: 1, createdAt: -1 },
      { name: 'tenant_document_extraction_jobs' },
    );
    await this.database.db.collection(mongoCollectionName('documentExtractions')).createIndex(
      { organisationId: 1, documentId: 1, createdAt: -1 },
      { name: 'tenant_document_extraction_history' },
    );
    await this.database.db.collection(mongoCollectionName('policyApprovals')).createIndex(
      { organisationId: 1, decision: 1, policyVersionId: 1 },
      { name: 'tenant_policy_approval_lookup' },
    );
    await this.database.db.collection(mongoCollectionName('policies')).createIndex(
      { organisationId: 1, policyType: 1, status: 1 },
      { name: 'tenant_policy_type_status' },
    );
    await this.database.db.collection(mongoCollectionName('policyVersions')).createIndex(
      { organisationId: 1, policyId: 1, version: 1 },
      { name: 'tenant_policy_version', unique: true },
    );
    await this.database.db.collection(mongoCollectionName('extractedRules')).createIndex(
      { organisationId: 1, policyVersionId: 1 },
      { name: 'tenant_extracted_policy_rules' },
    );
    await this.database.db.collection(mongoCollectionName('slaEvaluations')).createIndex(
      { organisationId: 1, ticketId: 1, evaluatedAt: -1 },
      { name: 'tenant_ticket_sla_history' },
    );
    await this.database.db.collection(mongoCollectionName('ai-analyses')).createIndex(
      { organisationId: 1, ticketId: 1, createdAt: -1 },
      { name: 'tenant_ticket_ai_analyses' },
    );
    await this.database.db.collection(mongoCollectionName('ai-workflow-runs')).createIndex(
      { organisationId: 1, ticketId: 1, startedAt: -1 },
      { name: 'tenant_ticket_ai_workflow_runs' },
    );
    await this.database.db.collection(mongoCollectionName('ai-operations')).createIndex(
      { organisationId: 1, kind: 1, createdAt: -1 },
      { name: 'tenant_ai_operation_history' },
    );
    await this.database.db.collection(mongoCollectionName('auditLogs')).createIndex(
      { organisationId: 1, createdAt: -1 },
      { name: 'tenant_audit_log_history' },
    );
    await this.database.db.collection(mongoCollectionName('ai-operations')).createIndex(
      { kind: 1, 'data.status': 1, 'data.availableAt': 1 },
      { name: 'ai_job_polling' },
    );
    await new MongoTicketStore(this.database).initialize();
  }

  async checkReady(): Promise<void> {
    try {
      await this.database.checkReady();
    } catch (error) {
      throw new JsonStorageError('STORAGE_IO_ERROR', 'MongoDB persistence is unavailable.', { cause: error });
    }
  }

  async read<T>(
    name: string,
    validate: (value: unknown) => value is JsonEnvelope<T>,
    migrate?: JsonEnvelopeMigration<T>,
  ): Promise<JsonEnvelope<T>> {
    try {
      await this.database.connect();
      const session = this.database.currentSession();
      const records = await this.database.db.collection(mongoCollectionName(name))
        .find({}, session ? { session } : {})
        .map(document => fromMongoDocument(document) as T)
        .toArray();
      const envelope: unknown = { schemaVersion: 1, records };
      const migrated = validate(envelope) ? envelope : migrate?.(envelope);
      if (!migrated || !validate(migrated)) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Collection ${name} does not match the supported schema.`);
      }
      return migrated;
    } catch (error) {
      if (error instanceof JsonStorageError) throw error;
      throw new JsonStorageError('STORAGE_IO_ERROR', `Could not read ${name} from MongoDB.`, { cause: error });
    }
  }

  async findRecords<T>(name: string, validateRecord: (value: unknown) => value is T, query: RecordQuery, _migrate?: JsonEnvelopeMigration<T>): Promise<T[]> {
    try {
      await this.database.connect();
      const session = this.database.currentSession();
      const records = await this.database.db.collection(mongoCollectionName(name))
        .find(toMongoQuery(query), session ? { session } : {})
        .map(document => fromMongoDocument(document))
        .toArray();
      if (!records.every(validateRecord)) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Collection ${name} contains records outside the supported schema.`);
      }
      return records as T[];
    } catch (error) {
      if (error instanceof JsonStorageError) throw error;
      throw new JsonStorageError('STORAGE_IO_ERROR', `Could not query ${name} from MongoDB.`, { cause: error });
    }
  }

  async write<T>(name: string, envelope: JsonEnvelope<T>): Promise<void> {
    await this.withStorageError(name, () => this.database.transaction(async session => this.writeInTransaction(name, envelope, session)));
  }

  async runExclusive<T>(_name: string, action: () => Promise<T>): Promise<T> {
    return this.database.transaction(async () => action());
  }

  async update<T, R>(
    name: string,
    validate: (value: unknown) => value is JsonEnvelope<T>,
    mutate: (envelope: JsonEnvelope<T>) => R | Promise<R>,
    migrate?: JsonEnvelopeMigration<T>,
  ): Promise<R> {
    return this.withStorageError(name, () => this.database.transaction(async session => {
      const envelope = await this.read(name, validate, migrate);
      const originalRecords = structuredClone(envelope.records);
      const result = await mutate(envelope);
      if (!validate(envelope)) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Updated collection ${name} does not match the supported schema.`);
      }
      await this.writeDeltaInTransaction(name, originalRecords, envelope.records, session);
      return result;
    }));
  }

  async updateTenant<T extends { id: string; organisationId: string }, R>(
    name: string,
    organisationId: string,
    validateRecord: (value: unknown) => value is T,
    mutate: (records: T[]) => R | Promise<R>,
  ): Promise<R> {
    return this.withStorageError(name, () => this.database.transaction(async session => {
      const collection = this.database.db.collection<StoredMongoDocument>(mongoCollectionName(name));
      const records = await collection.find({ organisationId }, { session }).map(fromMongoDocument).toArray();
      if (!records.every(record => validateRecord(record) && record.organisationId === organisationId)) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Collection ${name} contains invalid tenant records.`);
      }
      const previous = records as T[];
      const next = structuredClone(previous);
      const result = await mutate(next);
      if (!next.every(record => validateRecord(record) && record.organisationId === organisationId)) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Updated collection ${name} contains invalid tenant records.`);
      }
      indexRecordsById(name, next);
      await this.writeDeltaInTransaction(name, previous, next, session);
      return result;
    }));
  }

  async insertRecord<T extends { id: string }>(name: string, validateRecord: (value: unknown) => value is T, record: T): Promise<void> {
    await this.withStorageError(name, () => this.database.transaction(async session => {
      if (!validateRecord(record)) throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Invalid record for ${name}.`);
      await this.database.db.collection<StoredMongoDocument>(mongoCollectionName(name))
        .insertOne(toMongoDocument(record as Record<string, unknown>), { session });
    }));
  }

  async mutateRecord<T extends { id: string }, R>(
    name: string,
    id: string,
    validateRecord: (value: unknown) => value is T,
    mutate: (record: T | null) => { record: T | null; result: R } | Promise<{ record: T | null; result: R }>,
  ): Promise<R> {
    return this.withStorageError(name, () => this.database.transaction(async session => {
      const collection = this.database.db.collection<StoredMongoDocument>(mongoCollectionName(name));
      const stored = await collection.findOne({ _id: id }, { session });
      const current = stored ? fromMongoDocument(stored) : null;
      if (current && !validateRecord(current)) throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Record in ${name} is invalid.`);
      const outcome = await mutate(current as T | null);
      if (outcome.record !== null && (!validateRecord(outcome.record) || outcome.record.id !== id)) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Updated record in ${name} is invalid or changed its ID.`);
      }
      if (outcome.record === null) {
        if (stored) await collection.deleteOne({ _id: id }, { session });
      } else {
        await collection.replaceOne({ _id: id }, toMongoDocument(outcome.record as Record<string, unknown>), { session, upsert: !stored });
      }
      return outcome.result;
    }));
  }

  async importCollection(name: string, records: Record<string, unknown>[]): Promise<void> {
    const collection = this.database.db.collection<StoredMongoDocument>(mongoCollectionName(name));
    const mapped = records.map(record => toMongoDocument(record));
    await this.database.transaction(async session => {
      const existing = await collection.countDocuments({}, { session });
      if (existing > 0) throw new Error(`Target collection ${name} is not empty; refusing to overwrite it.`);
      if (mapped.length) await collection.insertMany(mapped, { session, ordered: true });
    });
  }

  private async writeInTransaction<T>(name: string, envelope: JsonEnvelope<T>, session: ClientSession): Promise<void> {
    const records = envelope.records as unknown as Record<string, unknown>[];
    const nextById = indexRecordsById(name, records);
    const collection = this.database.db.collection<StoredMongoDocument>(mongoCollectionName(name));
    const existing = await collection.find({}, { session }).map(fromMongoDocument).toArray();
    const existingById = indexRecordsById(name, existing);
    const changed = records.filter(record => !isDeepStrictEqual(existingById.get(recordId(record)), record));
    if (changed.length) {
      await collection.bulkWrite(changed.map(record => ({
        replaceOne: {
          filter: { _id: recordId(record) },
          replacement: toMongoDocument(record),
          upsert: true,
        },
      })), { session, ordered: true });
    }
    const removed = existing.filter(record => !nextById.has(recordId(record)));
    if (removed.length) {
      await collection.bulkWrite(removed.map(record => {
        const filter: Document = { _id: recordId(record) };
        if (typeof record.organisationId === 'string') filter.organisationId = record.organisationId;
        return { deleteOne: { filter } };
      }), { session, ordered: true });
    }
  }

  private async writeDeltaInTransaction<T>(
    name: string,
    previousRecords: T[],
    nextRecords: T[],
    session: ClientSession,
  ): Promise<void> {
    const previousById = indexRecordsById(name, previousRecords);
    const nextById = indexRecordsById(name, nextRecords);
    const collection = this.database.db.collection<StoredMongoDocument>(mongoCollectionName(name));
    const changed = nextRecords.filter(record => !isDeepStrictEqual(previousById.get(recordId(record)), record));
    if (changed.length) {
      await collection.bulkWrite(changed.map(record => ({
        replaceOne: {
          filter: { _id: recordId(record) },
          replacement: toMongoDocument(record as Record<string, unknown>),
          upsert: true,
        },
      })), { session, ordered: true });
    }
    const removed = previousRecords.filter(record => !nextById.has(recordId(record)));
    if (removed.length) {
      const deletions = removed.map(record => {
        const value = record as Record<string, unknown>;
        const filter: Document = { _id: recordId(record) };
        if (typeof value.organisationId === 'string') filter.organisationId = value.organisationId;
        return { deleteOne: { filter } };
      });
      await collection.bulkWrite(deletions, { session, ordered: true });
    }
  }

  private async withStorageError<T>(name: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof JsonStorageError || isApplicationError(error)) throw error;
      throw new JsonStorageError('STORAGE_IO_ERROR', `MongoDB operation failed for ${name}.`, { cause: error });
    }
  }
}

function indexRecordsById<T>(name: string, records: T[]): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const record of records) {
    const id = recordId(record);
    if (!id || indexed.has(id)) {
      throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Collection ${name} contains a missing or duplicate record ID.`);
    }
    indexed.set(id, record);
  }
  return indexed;
}

function recordId(value: unknown): string {
  return value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id
    : '';
}

function toMongoQuery(query: RecordQuery): Document {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'MongoDB query must be an object.');
  }
  return Object.fromEntries(Object.entries(query).map(([field, value]) => {
    if (field === '$or' || field === '$and') {
      if (!Array.isArray(value)) throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'MongoDB query clauses must be arrays.');
      return [field, value.map(clause => toMongoQuery(clause as RecordQuery))];
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(field)) {
      throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'MongoDB query contains an unsupported field name.');
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const condition = value as Record<string, unknown>;
      if (Object.keys(condition).length !== 1 || !Array.isArray(condition.$in)) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'MongoDB query supports only the $in field operator.');
      }
      if (condition.$in.some(item => item && typeof item === 'object')) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'MongoDB $in values must be scalar.');
      }
    }
    return [field === 'id' ? '_id' : field.startsWith('id.') ? `_id${field.slice(2)}` : field, value];
  }));
}

function toMongoDocument(value: Record<string, unknown>): StoredMongoDocument {
  if (typeof value.id !== 'string' || !value.id.trim()) {
    throw new JsonStorageError('STORAGE_INVALID_SCHEMA', 'MongoDB records require a non-empty id.');
  }
  const { _id: _ignored, ...record } = value;
  return { ...record, _id: value.id } as StoredMongoDocument;
}

function fromMongoDocument(value: Document): Record<string, unknown> {
  const { _id, ...record } = value;
  return { ...record, id: typeof record.id === 'string' ? record.id : String(_id) };
}

function isApplicationError(error: unknown): boolean {
  return !!error && typeof error === 'object' &&
    Number.isInteger((error as { statusCode?: unknown }).statusCode) &&
    typeof (error as { code?: unknown }).code === 'string';
}
