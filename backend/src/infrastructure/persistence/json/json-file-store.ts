import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

export type JsonEnvelope<T> = { schemaVersion: 1; records: T[] };
export type JsonEnvelopeMigration<T> = (value: unknown) => JsonEnvelope<T> | null;
export type RecordQuery = Record<string, unknown>;

/** Persistence contract shared by the local JSON adapter and MongoDB adapter. */
export interface JsonFileStorePort {
  readonly rootDir: string;
  checkReady(): Promise<void>;
  read<T>(name: string, validate: (value: unknown) => value is JsonEnvelope<T>, migrate?: JsonEnvelopeMigration<T>): Promise<JsonEnvelope<T>>;
  findRecords<T>(name: string, validateRecord: (value: unknown) => value is T, query: RecordQuery, migrate?: JsonEnvelopeMigration<T>): Promise<T[]>;
  write<T>(name: string, envelope: JsonEnvelope<T>): Promise<void>;
  runExclusive<R>(name: string, action: () => Promise<R>): Promise<R>;
  update<T, R>(name: string, validate: (value: unknown) => value is JsonEnvelope<T>, mutate: (envelope: JsonEnvelope<T>) => R | Promise<R>, migrate?: JsonEnvelopeMigration<T>): Promise<R>;
  updateTenant?<T extends { id: string; organisationId: string }, R>(name: string, organisationId: string, validateRecord: (value: unknown) => value is T, mutate: (records: T[]) => R | Promise<R>): Promise<R>;
  insertRecord?<T extends { id: string }>(name: string, validateRecord: (value: unknown) => value is T, record: T): Promise<void>;
  mutateRecord?<T extends { id: string }, R>(name: string, id: string, validateRecord: (value: unknown) => value is T, mutate: (record: T | null) => { record: T | null; result: R } | Promise<{ record: T | null; result: R }>): Promise<R>;
}

/** Insert one record atomically in adapters that support record-level writes. */
export async function insertRecord<T extends { id: string }>(store: JsonFileStorePort, name: string, validateRecord: (value: unknown) => value is T, record: T): Promise<void> {
  if (!validateRecord(record) || !record.id.trim()) throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Invalid record for ${name}.`);
  if (store.insertRecord) return store.insertRecord(name, validateRecord, record);
  await store.update<T, void>(name, (value): value is JsonEnvelope<T> => isRecordEnvelope(value, validateRecord), envelope => {
    if (envelope.records.some(item => item.id === record.id)) throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Duplicate record ID in ${name}.`);
    envelope.records.push(structuredClone(record));
  });
}

/** Change or remove one record by ID without loading unrelated records in MongoDB. */
export async function mutateRecordById<T extends { id: string }, R>(
  store: JsonFileStorePort,
  name: string,
  id: string,
  validateRecord: (value: unknown) => value is T,
  mutate: (record: T | null) => { record: T | null; result: R } | Promise<{ record: T | null; result: R }>,
): Promise<R> {
  if (store.mutateRecord) return store.mutateRecord(name, id, validateRecord, mutate);
  return store.update<T, R>(name, (value): value is JsonEnvelope<T> => isRecordEnvelope(value, validateRecord), async envelope => {
    const existing = envelope.records.find(record => record.id === id) ?? null;
    const outcome = await mutate(existing ? structuredClone(existing) : null);
    if (outcome.record !== null && (!validateRecord(outcome.record) || outcome.record.id !== id)) {
      throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Updated record in ${name} is invalid or changed its ID.`);
    }
    if (!existing && outcome.record !== null && envelope.records.some(record => record.id === id)) {
      throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Duplicate record ID in ${name}.`);
    }
    if (existing) {
      const index = envelope.records.indexOf(existing);
      if (outcome.record === null) envelope.records.splice(index, 1);
      else envelope.records[index] = outcome.record;
    } else if (outcome.record !== null) envelope.records.push(outcome.record);
    return outcome.result;
  });
}

/** Tenant-scoped update on MongoDB, with a compatibility fallback for local JSON files. */
export async function updateTenantRecords<T extends { id: string; organisationId: string }, R>(
  store: JsonFileStorePort,
  name: string,
  organisationId: string,
  validateRecord: (value: unknown) => value is T,
  mutate: (records: T[]) => R | Promise<R>,
  migrate?: JsonEnvelopeMigration<T>,
): Promise<R> {
  if (store.updateTenant) return store.updateTenant(name, organisationId, validateRecord, mutate);

  return store.update<T, R>(name,
    (value): value is JsonEnvelope<T> => isRecordEnvelope(value, validateRecord),
    async envelope => {
      const tenantRecords = envelope.records.filter(record => record.organisationId === organisationId);
      const result = await mutate(tenantRecords);
      if (!tenantRecords.every(record => validateRecord(record) && record.organisationId === organisationId)) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Updated collection ${name} changed tenant ownership.`);
      }
      const nextById = new Map<string, T>();
      for (const record of tenantRecords) {
        if (nextById.has(record.id)) throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Updated collection ${name} contains duplicate tenant record IDs.`);
        nextById.set(record.id, record);
      }
      if (envelope.records.some(record => record.organisationId !== organisationId && nextById.has(record.id))) {
        throw new JsonStorageError('STORAGE_INVALID_SCHEMA', `Updated collection ${name} reused a record ID owned by another tenant.`);
      }
      const remaining = new Map(nextById);
      envelope.records = envelope.records.flatMap(record => {
        if (record.organisationId !== organisationId) return [record];
        const replacement = remaining.get(record.id);
        if (!replacement) return [];
        remaining.delete(record.id);
        return [replacement];
      });
      envelope.records.push(...remaining.values());
      return result;
    },
    migrate,
  );
}

export class JsonStorageError extends Error {
  public readonly code: "STORAGE_IO_ERROR" | "STORAGE_INVALID_JSON" | "STORAGE_INVALID_SCHEMA";

  constructor(code: "STORAGE_IO_ERROR" | "STORAGE_INVALID_JSON" | "STORAGE_INVALID_SCHEMA", message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "JsonStorageError";
  }
}

/** Process-local serialized writes plus same-directory atomic replacement. */
export class JsonFileStore implements JsonFileStorePort {
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly root: string;
  private readonly lockTimeoutMs: number;

  constructor(directory: string, lockTimeoutMs = 5000) {
    this.root = resolve(directory);
    this.lockTimeoutMs = lockTimeoutMs;
  }

  get rootDir(): string {
    return this.root;
  }

  /** Verifies the configured data directory is readable and writable without touching application records. */
  async checkReady(): Promise<void> {
    const probePath = join(this.root, `.readiness-${randomUUID()}.tmp`);
    try {
      await mkdir(this.root, { recursive: true });
      await readdir(this.root);
      const probe = await open(probePath, "wx", 0o600);
      await probe.close();
      await rm(probePath);
    } catch (error) {
      await rm(probePath, { force: true }).catch(() => undefined);
      throw new JsonStorageError("STORAGE_IO_ERROR", "The JSON data directory is not ready.", { cause: error });
    }
  }

  async read<T>(
    name: string,
    validate: (value: unknown) => value is JsonEnvelope<T>,
    migrate?: JsonEnvelopeMigration<T>,
  ): Promise<JsonEnvelope<T>> {
    const path = this.pathFor(name);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, records: [] };
      throw new JsonStorageError("STORAGE_IO_ERROR", `Could not read ${name}.`, { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new JsonStorageError("STORAGE_INVALID_JSON", `Stored file ${name} contains invalid JSON.`, { cause: error });
    }
    const envelope = validate(parsed) ? parsed : migrate?.(parsed);
    if (!envelope || !validate(envelope)) throw new JsonStorageError("STORAGE_INVALID_SCHEMA", `Stored file ${name} does not match its schema.`);
    const records = envelope.records;
    const ids = new Set<string>();
    for (const record of records) {
      if (typeof record !== "object" || record === null || !("id" in record)) continue;
      const id = (record as { id?: unknown }).id;
      if (typeof id !== "string" || id.length === 0 || ids.has(id)) {
        throw new JsonStorageError("STORAGE_INVALID_SCHEMA", `Stored file ${name} contains a missing or duplicate record ID.`);
      }
      ids.add(id);
    }
    return envelope;
  }

  async write<T>(name: string, envelope: JsonEnvelope<T>): Promise<void> {
    await this.withLock(name, async () => {
      assertUniqueRecordIds(name, envelope.records);
      await this.writeUnlocked(name, envelope);
    });
  }

  async findRecords<T>(name: string, validateRecord: (value: unknown) => value is T, query: RecordQuery, migrate?: JsonEnvelopeMigration<T>): Promise<T[]> {
    const envelope = await this.read(name, (value): value is JsonEnvelope<T> =>
      isRecordEnvelope(value, validateRecord), migrate);
    return envelope.records.filter(record => matchesRecordQuery(record, query));
  }

  /** Coordinate a legacy repository's complete read/modify/write operation. */
  async runExclusive<R>(name: string, action: () => Promise<R>): Promise<R> {
    return this.withLock(name, action);
  }

  async update<T, R>(
    name: string,
    validate: (value: unknown) => value is JsonEnvelope<T>,
    mutate: (envelope: JsonEnvelope<T>) => R | Promise<R>,
    migrate?: JsonEnvelopeMigration<T>,
  ): Promise<R> {
    return this.withLock(name, async () => {
      const envelope = await this.read(name, validate, migrate);
      const result = await mutate(envelope);
      if (!validate(envelope)) throw new JsonStorageError("STORAGE_INVALID_SCHEMA", `Updated file ${name} does not match its schema.`);
      assertUniqueRecordIds(name, envelope.records);
      await this.writeUnlocked(name, envelope);
      return result;
    });
  }

  private async withLock<R>(name: string, action: () => Promise<R>): Promise<R> {
    const path = this.pathFor(name);
    const pending = this.writeQueues.get(path) ?? Promise.resolve();
    const operation = pending.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const lockPath = `${path}.lock`;
      let lock;
      const deadline = Date.now() + this.lockTimeoutMs;
      while (!lock) {
        try {
          lock = await open(lockPath, "wx", 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw new JsonStorageError("STORAGE_IO_ERROR", `Could not lock ${name}.`, { cause: error });
          }
          if (Date.now() >= deadline) {
            throw new JsonStorageError("STORAGE_IO_ERROR", `Timed out waiting to write ${name}; retry the operation.`, { cause: error });
          }
          await delay(Math.min(25, Math.max(1, deadline - Date.now())));
        }
      }
      try {
        return await action();
      } finally {
        await lock.close();
        await rm(lockPath, { force: true });
      }
    });
    this.writeQueues.set(path, operation);
    try {
      return await operation as R;
    } finally {
      if (this.writeQueues.get(path) === operation) this.writeQueues.delete(path);
    }
  }

  private async writeUnlocked<T>(name: string, envelope: JsonEnvelope<T>): Promise<void> {
    const path = this.pathFor(name);
    const temporaryPath = join(dirname(path), `.${name}.${randomUUID()}.tmp`);
    try {
      await mkdir(dirname(path), { recursive: true });
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      // Windows can briefly deny replacement while a concurrent reader holds the old file.
      // Retry the atomic rename; never delete the existing collection as a workaround.
      const deadline = Date.now() + this.lockTimeoutMs;
      while (true) {
        try {
          await rename(temporaryPath, path);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || Date.now() >= deadline) throw error;
          await delay(Math.min(25, Math.max(1, deadline - Date.now())));
        }
      }
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new JsonStorageError("STORAGE_IO_ERROR", `Could not write ${name}.`, { cause: error });
    }
  }

  private pathFor(name: string): string {
    if (!/^[a-z][a-zA-Z0-9-]*\.json$/.test(name)) throw new Error("Invalid JSON store filename.");
    const path = resolve(this.root, name);
    if (!path.startsWith(`${this.root}/`) && !path.startsWith(`${this.root}\\`)) {
      throw new Error("JSON store path escaped configured directory.");
    }
    return path;
  }
}

function isRecordEnvelope<T>(value: unknown, validateRecord: (record: unknown) => record is T): value is JsonEnvelope<T> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    Array.isArray((value as { records?: unknown }).records) &&
    (value as { records: unknown[] }).records.every(validateRecord);
}

function matchesRecordQuery(record: unknown, query: RecordQuery): boolean {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const row = record as Record<string, unknown>;
  return Object.entries(query).every(([field, expected]) => {
    if (field === "$or") {
      return Array.isArray(expected) && expected.some(clause => matchesRecordQuery(record, clause as RecordQuery));
    }
    if (field === "$and") {
      return Array.isArray(expected) && expected.every(clause => matchesRecordQuery(record, clause as RecordQuery));
    }
    const actual = field.split(".").reduce<unknown>((value, part) =>
      value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, row);
    if (expected && typeof expected === "object" && !Array.isArray(expected) && "$in" in expected) {
      const values = (expected as { $in?: unknown }).$in;
      return Array.isArray(values) && values.some(value => isDeepStrictEqual(value, actual));
    }
    return isDeepStrictEqual(actual, expected);
  });
}

function assertUniqueRecordIds(name: string, records: unknown[]): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (typeof record !== "object" || record === null || !("id" in record)) continue;
    const id = (record as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0 || ids.has(id)) {
      throw new JsonStorageError("STORAGE_INVALID_SCHEMA", `Stored file ${name} contains a missing or duplicate record ID.`);
    }
    ids.add(id);
  }
}
