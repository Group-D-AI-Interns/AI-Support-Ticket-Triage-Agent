import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type JsonEnvelope<T> = { schemaVersion: 1; records: T[] };
export type JsonEnvelopeMigration<T> = (value: unknown) => JsonEnvelope<T> | null;

export class JsonStorageError extends Error {
  public readonly code: "STORAGE_IO_ERROR" | "STORAGE_INVALID_JSON" | "STORAGE_INVALID_SCHEMA";

  constructor(code: "STORAGE_IO_ERROR" | "STORAGE_INVALID_JSON" | "STORAGE_INVALID_SCHEMA", message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "JsonStorageError";
  }
}

/** Process-local serialized writes plus same-directory atomic replacement. */
export class JsonFileStore {
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
