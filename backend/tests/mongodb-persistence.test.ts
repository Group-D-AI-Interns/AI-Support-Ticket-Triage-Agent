import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import { MongoDatabase, mongoCollectionName } from '../src/infrastructure/persistence/mongodb/mongo-database.js';
import { MongoFileStore } from '../src/infrastructure/persistence/mongodb/mongo-file-store.js';
import { MongoTicketStore, MongoTicketWorkflowStore } from '../src/infrastructure/persistence/mongodb/mongo-ticket-stores.js';
import { createJsonTenantStore } from '../src/infrastructure/persistence/json/json-store.js';
import { updateTenantRecords } from '../src/infrastructure/persistence/json/json-file-store.js';
import { assertEmptyApplicationDatabase, importAndVerifyCollections, normalizeMigrationRecords, validateMigrationCollection } from '../scripts/migration-support.js';
import type { JsonEnvelope } from '../src/infrastructure/persistence/json/json-file-store.js';
import type { TicketRecord } from '../src/modules/tickets/domain/ticket.js';
import type { TicketWorkflowRecord } from '../src/modules/tickets/domain/ticket-workflow.js';

describe('MongoDB persistence configuration', () => {
  it('uses the tenant mutation port instead of collection snapshots when available', async () => {
    type Record = { id: string; organisationId: string; value: number };
    const records: Record[] = [
      { id: 'team-a', organisationId: 'org-a', value: 1 },
      { id: 'team-b', organisationId: 'org-b', value: 2 },
    ];
    const calls: string[] = [];
    const store = {
      rootDir: '.',
      update: async () => { throw new Error('collection snapshot path must not be used'); },
      updateTenant: async (_name: string, organisationId: string, _validate: (value: unknown) => value is Record, mutate: (selected: Record[]) => Record[]) => {
        calls.push(organisationId);
        const selected = records.filter(record => record.organisationId === organisationId);
        const result = mutate(selected);
        for (let index = records.length - 1; index >= 0; index -= 1) {
          if (records[index]!.organisationId === organisationId) records.splice(index, 1);
        }
        records.push(...selected);
        return result;
      },
    } as unknown as import('../src/infrastructure/persistence/json/json-file-store.js').JsonFileStorePort;
    const valid = (value: unknown): value is Record => !!value && typeof value === 'object' &&
      typeof (value as Record).id === 'string' && typeof (value as Record).organisationId === 'string' &&
      typeof (value as Record).value === 'number';

    await updateTenantRecords<Record, void>(store, 'teams.json', 'org-a', valid, selected => {
      selected[0]!.value = 10;
    });

    assert.deepEqual(calls, ['org-a']);
    assert.deepEqual(records, [
      { id: 'team-b', organisationId: 'org-b', value: 2 },
      { id: 'team-a', organisationId: 'org-a', value: 10 },
    ]);
  });

  it('rejects malformed and ownerless migration records before database access', () => {
    const document = {
      id: 'doc-1', organisationId: 'org-1', title: 'Policy source', status: 'uploaded',
      fileName: 'policy.pdf', mimeType: 'application/pdf', storageKey: 'org-1/doc-1',
      checksumSha256: 'a'.repeat(64), createdBy: 'user-1', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', version: 1, fileSizeBytes: 10,
      provider: 'private-storage', processingStatus: 'queued',
    };
    assert.equal(validateMigrationCollection('documents', [document]), true);
    assert.equal(validateMigrationCollection('documents', [{ id: 'doc-1', organisationId: 'org-1' }]), false);
    assert.equal(validateMigrationCollection('documents', [{ ...document, checksumSha256: 'bad' }]), false);
    assert.equal(validateMigrationCollection('documents', [{ id: 'doc-1' }]), false);
    assert.equal(validateMigrationCollection('users', [{ id: 'user-1', email: 'bad' }]), false);
    assert.equal(validateMigrationCollection('policyVersions', [{
      id: 'version-1', organisationId: 'org-1', policyId: 'policy-1', version: 1,
      status: 'active', effectiveFrom: null, effectiveTo: null, payload: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }]), false);
    assert.equal(validateMigrationCollection('documents', [{ id: 'duplicate' }, { id: 'duplicate' }]), false);
    assert.equal(validateMigrationCollection('unsupported', [{ id: 'record-1' }]), false);
  });

  it('validates workflow-run domain IDs and maps runId to Mongo storage id during migration', () => {
    const run = {
      engine: 'langgraph', version: 'ticket-analysis-v1', runId: 'run-1', status: 'failed',
      snapshotHash: 'a'.repeat(64), configurationHash: 'b'.repeat(64),
      startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z',
      trace: [], warnings: [], organisationId: 'org-1', ticketId: 'ticket-1', initiatedBy: 'user-1',
      executions: [], failure: { code: 'PROVIDER_FAILURE', executionId: 'execution-1', task: 'ticket_classification' },
    };
    assert.equal(validateMigrationCollection('ai-workflow-runs', [run]), true);
    assert.equal(validateMigrationCollection('ai-workflow-runs', [{ ...run, runId: '' }]), false);
    assert.deepEqual(normalizeMigrationRecords('ai-workflow-runs', [run])[0], { ...run, id: 'run-1' });
    assert.deepEqual(normalizeMigrationRecords('tickets', [{ ...run }])[0], run);
  });

  it('permits empty pre-indexed migration targets but refuses application data', async () => {
    let recordCount = 0;
    const database = {
      db: {
        listCollections: () => ({ toArray: async () => [{ name: 'app_documents' }] }),
        collection: () => ({ countDocuments: async () => recordCount }),
      },
    } as unknown as MongoDatabase;

    await assertEmptyApplicationDatabase(database);
    recordCount = 1;
    await assert.rejects(assertEmptyApplicationDatabase(database), /contains application records/);
  });

  it('verifies migration collection counts before transaction commit', async () => {
    const imported = new Map<string, Record<string, unknown>[]>();
    let committed = false;
    const database = {
      db: { collection: (name: string) => ({ countDocuments: async () => imported.get(name)?.length ?? 0 }) },
      transaction: async (operation: (session: object) => Promise<void>) => {
        await operation({});
        committed = true;
      },
    } as unknown as MongoDatabase;
    const store = {
      importCollection: async (name: string, records: Record<string, unknown>[]) => { imported.set(`app_${name}`, records); },
    } as unknown as MongoFileStore;
    const source = [{ name: 'documents', records: [{ id: 'doc-1' }] }];

    await importAndVerifyCollections(database, store, source);
    assert.equal(committed, true);

    imported.clear();
    committed = false;
    const mismatchedStore = { importCollection: async () => undefined } as unknown as MongoFileStore;
    await assert.rejects(importAndVerifyCollections(database, mismatchedStore, source), /count did not match/);
    assert.equal(committed, false);
  });

  it('runs work inside the driver-managed transaction session, including nested operations', async () => {
    const database = new MongoDatabase('mongodb://127.0.0.1:27017', 'unit-test');
    const events: string[] = [];
    const session = {
      withTransaction: async <T>(operation: () => Promise<T>) => {
        events.push('withTransaction');
        return operation();
      },
      endSession: async () => { events.push('endSession'); },
    };
    (database as unknown as { connected: boolean }).connected = true;
    database.client.startSession = (() => session as never) as typeof database.client.startSession;

    const result = await database.transaction(async outerSession => {
      assert.equal(database.currentSession(), outerSession);
      return database.transaction(async nestedSession => {
        assert.equal(nestedSession, outerSession);
        events.push('operation');
        return 'committed';
      });
    });

    assert.equal(result, 'committed');
    assert.deepEqual(events, ['withTransaction', 'operation', 'endSession']);
    await database.close();
  });

  it('preserves other tenants in the JSON fallback for scoped mutations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tenant-scoped-update-'));
    try {
      const store = createJsonTenantStore(root);
      type Record = { id: string; organisationId: string; value: number };
      await store.writeCollection<Record>('documents', [
        { id: 'record-a', organisationId: 'org-a', value: 1 },
        { id: 'record-b', organisationId: 'org-b', value: 2 },
      ]);
      await store.updateTenantCollection<Record, void>('documents', 'org-a', records => {
        records[0]!.value = 10;
      });
      assert.deepEqual(await store.readCollection<Record>('documents'), [
        { id: 'record-a', organisationId: 'org-a', value: 10 },
        { id: 'record-b', organisationId: 'org-b', value: 2 },
      ]);
      await assert.rejects(store.updateTenantCollection<Record, void>('documents', 'org-a', records => {
        records[0]!.organisationId = 'org-b';
      }), /changed tenant ownership/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses a separate application collection namespace and rejects unsafe collection names', () => {
    assert.equal(mongoCollectionName('memberships.json'), 'app_memberships');
    assert.equal(mongoCollectionName('ai-workflow-runs'), 'app_ai-workflow-runs');
    assert.throws(() => mongoCollectionName('../tickets.json'), /Invalid MongoDB collection name/);
  });

  it('scopes ticket list and detail queries to the active organisation', async () => {
    const ticket = {
      _id: 'ticket-a', id: 'ticket-a', organisationId: 'org-a', requesterId: 'requester-a',
      title: 'Synthetic ticket', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      affectedUsers: { scope: 'multiple_departments', count: 150 }, businessImpact: 'critical', urgency: 'immediate',
    };
    let listFilter: Record<string, unknown> | undefined;
    let detailFilter: Record<string, unknown> | undefined;
    const database = {
      connect: async () => undefined,
      currentSession: () => undefined,
      db: { collection: () => ({
        find: (filter: Record<string, unknown>) => {
          listFilter = filter;
          return { toArray: async () => [ticket] };
        },
        findOne: async (filter: Record<string, unknown>) => {
          detailFilter = filter;
          return filter.organisationId === ticket.organisationId ? ticket : null;
        },
      }) },
    } as unknown as MongoDatabase;
    const store = new MongoTicketStore(database);
    const tenant = { organisationId: 'org-a', userId: 'user-a', roles: [] };

    assert.deepEqual((await store.listTickets(tenant)).map(record => record.id), ['ticket-a']);
    assert.deepEqual(listFilter, { organisationId: 'org-a' });
    assert.deepEqual((await store.findTicket(tenant, 'ticket-a'))?.affectedUsers, { scope: 'multiple_departments', count: 150 });
    assert.equal((await store.findTicket(tenant, 'ticket-a'))?.businessImpact, 'critical');
    assert.equal((await store.findTicket(tenant, 'ticket-a'))?.urgency, 'immediate');
    assert.deepEqual(detailFilter, { _id: 'ticket-a', organisationId: 'org-a' });
    assert.equal(await store.findTicket({ ...tenant, organisationId: 'org-b' }, 'ticket-a'), null);
  });

  it('filters and paginates ticket lists in MongoDB while preserving team scope and totals', async () => {
    const ticket = {
      _id: 'ticket-a', id: 'ticket-a', organisationId: 'org-a', requesterId: 'requester-a',
      teamId: 'team-a', title: 'Synthetic ticket', status: 'OPEN', priority: 'high',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    let filter: Record<string, unknown> | undefined;
    let countFilter: Record<string, unknown> | undefined;
    let options: Record<string, unknown> | undefined;
    const database = {
      connect: async () => undefined,
      currentSession: () => undefined,
      db: { collection: () => ({
        find: (query: Record<string, unknown>, findOptions: Record<string, unknown>) => {
          filter = query;
          options = findOptions;
          return { toArray: async () => [ticket] };
        },
        countDocuments: async (query: Record<string, unknown>) => {
          countFilter = query;
          return 27;
        },
      }) },
    } as unknown as MongoDatabase;
    const store = new MongoTicketStore(database);
    const page = await store.listTicketsPage(
      { organisationId: 'org-a', userId: 'lead-a', roles: ['support_lead'] },
      { status: 'open', priority: 'P2', teamId: 'team-a', requesterId: 'requester-a' },
      { readAll: false, includeUnassigned: true, teamIds: ['team-a'] },
      10,
      20,
    );

    assert.equal(page?.total, 27);
    assert.equal(page?.data[0]?.id, 'ticket-a');
    assert.deepEqual(countFilter, filter);
    assert.deepEqual((filter?.$and as unknown[])[0], { organisationId: 'org-a' });
    assert.deepEqual((filter?.$and as unknown[])[1], { $or: [
      { teamId: null },
      { teamId: { $in: ['team-a'] } },
    ] });
    const clauses = filter?.$and as Array<Record<string, unknown>>;
    const statusClauses = (clauses[2]?.$or as Array<Record<string, unknown>>);
    const priorityClauses = (clauses[3]?.$or as Array<Record<string, unknown>>);
    assert.equal(((statusClauses[0]?.status) as RegExp).test('OPEN'), true);
    const fallbackStatus = (statusClauses[1]?.$and as Array<Record<string, unknown>>)[1];
    assert.equal(((fallbackStatus?.['source.status']) as RegExp).test('open'), true);
    assert.equal(((priorityClauses[0]?.priority) as RegExp).test('high'), true);
    assert.equal(((priorityClauses[0]?.priority) as RegExp).test('P2'), true);
    assert.deepEqual(options?.sort, { createdAt: -1, _id: -1 });
    assert.equal(options?.skip, 20);
    assert.equal(options?.limit, 10);
    assert.deepEqual(options?.projection, {
      _id: 1, id: 1, organisationId: 1, requesterId: 1, teamId: 1, title: 1,
      description: 1, product: 1, affectedService: 1, affectedUsers: 1, businessImpact: 1, urgency: 1, status: 1, priority: 1,
      source: 1, createdAt: 1, updatedAt: 1,
    });
  });

  it('queries open escalations in MongoDB with tenant and support-team scope', async () => {
    const ticket = {
      _id: 'ticket-a', id: 'ticket-a', organisationId: 'org-a', requesterId: 'requester-a',
      teamId: 'team-a', title: 'Synthetic escalation', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      escalations: [{
        id: 'escalation-a', status: 'open', reasonCode: 'P1_CRITICAL', handoverNotes: 'Synthetic test',
        escalatedBy: 'agent-a', escalatedAt: '2026-01-01T00:00:00.000Z', automatic: true,
      }],
    };
    let filter: Record<string, unknown> | undefined;
    const database = {
      connect: async () => undefined,
      currentSession: () => undefined,
      db: { collection: () => ({
        find: (query: Record<string, unknown>) => {
          filter = query;
          return { toArray: async () => [ticket] };
        },
      }) },
    } as unknown as MongoDatabase;
    const store = new MongoTicketStore(database);
    const records = await store.listOpenEscalatedTickets(
      { organisationId: 'org-a', userId: 'lead-a', roles: ['support_lead'] },
      { readAll: false, includeUnassigned: false, teamIds: ['team-a', 'team-b'] },
    );

    assert.deepEqual(records.map(record => record.id), ['ticket-a']);
    assert.deepEqual(filter, { $and: [
      { organisationId: 'org-a' },
      { 'escalations.status': 'open' },
      { $or: [{ teamId: { $in: ['team-a', 'team-b'] } }] },
    ] });
  });

  it('writes only changed ticket records inside the transaction', async () => {
    const original = [
      { _id: 'ticket-a', id: 'ticket-a', organisationId: 'org-a', requesterId: 'requester-a', title: 'Before', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { _id: 'ticket-b', id: 'ticket-b', organisationId: 'org-b', requesterId: 'requester-b', title: 'Unchanged', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const session = {};
    const writes: unknown[][] = [];
    let ticketReadQuery: Record<string, unknown> | undefined;
    const database = {
      transaction: async (operation: (session: object) => Promise<unknown>) => operation(session),
      currentSession: () => session,
      db: { collection: () => ({
        find: (query: Record<string, unknown>) => {
          ticketReadQuery = query;
          return { toArray: async () => original.filter(record => record.organisationId === query.organisationId) };
        },
        bulkWrite: async (operations: unknown[]) => { writes.push(operations); },
        deleteMany: async () => { throw new Error('whole-collection deletion must not be used'); },
      }) },
    } as unknown as MongoDatabase;
    class TestableMongoTicketStore extends MongoTicketStore {
      load() { return this.readRecords(); }
      save(records: TicketRecord[]) { return this.writeRecords(records); }
      inTenant<T>(operation: () => Promise<T>) { return this.withLock('org-a', operation); }
    }
    const store = new TestableMongoTicketStore(database);
    await store.inTenant(async () => {
      const records = await store.load();
      records[0] = { ...records[0]!, title: 'After' };
      await store.save(records);
    });

    assert.deepEqual(ticketReadQuery, { organisationId: 'org-a' });
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.length, 1);
    assert.deepEqual(writes[0]?.[0], {
      replaceOne: { filter: { _id: 'ticket-a', organisationId: 'org-a' }, replacement: { id: 'ticket-a', organisationId: 'org-a', requesterId: 'requester-a', title: 'After', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', _id: 'ticket-a' }, upsert: true },
    });
  });

  it('updates only changed records in the compatibility collection adapter', async () => {
    const original = [
      { _id: 'record-a', id: 'record-a', organisationId: 'org-a', value: 1 },
      { _id: 'record-b', id: 'record-b', organisationId: 'org-b', value: 2 },
    ];
    const session = {};
    const writes: unknown[][] = [];
    const collection = {
      find: () => ({ map: (transform: (record: typeof original[number]) => unknown) => ({
        toArray: async () => original.map(transform),
      }) }),
      bulkWrite: async (operations: unknown[]) => { writes.push(operations); },
      deleteMany: async () => { throw new Error('whole-collection deletion must not be used'); },
    };
    const database = {
      connect: async () => undefined,
      currentSession: () => session,
      transaction: async (operation: (session: object) => Promise<unknown>) => operation(session),
      db: { collection: () => collection },
    } as unknown as MongoDatabase;
    const store = new MongoFileStore(database, '.');
    const valid = (value: unknown): value is JsonEnvelope<{ id: string; organisationId: string; value: number }> => {
      if (!value || typeof value !== 'object') return false;
      const envelope = value as { schemaVersion?: unknown; records?: unknown };
      return envelope.schemaVersion === 1 && Array.isArray(envelope.records) && envelope.records.every(record =>
        !!record && typeof record === 'object' && typeof (record as { id?: unknown }).id === 'string' &&
        typeof (record as { organisationId?: unknown }).organisationId === 'string' &&
        typeof (record as { value?: unknown }).value === 'number');
    };

    await store.update('mongo-unit.json', valid, envelope => {
      envelope.records[0]!.value = 10;
    });

    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.length, 1);
    assert.deepEqual(writes[0]?.[0], {
      replaceOne: {
        filter: { _id: 'record-a' },
        replacement: { id: 'record-a', organisationId: 'org-a', value: 10, _id: 'record-a' },
        upsert: true,
      },
    });
  });

  it('replaces a compatibility snapshot with record deltas instead of deleting the collection', async () => {
    const original = [
      { _id: 'record-a', id: 'record-a', organisationId: 'org-a', value: 1 },
      { _id: 'record-b', id: 'record-b', organisationId: 'org-b', value: 2 },
    ];
    const session = {};
    const writes: unknown[][] = [];
    let collectionWideDeleteUsed = false;
    const collection = {
      find: () => ({ map: (transform: (record: typeof original[number]) => unknown) => ({
        toArray: async () => original.map(transform),
      }) }),
      bulkWrite: async (operations: unknown[]) => { writes.push(operations); },
      deleteMany: async () => { collectionWideDeleteUsed = true; },
    };
    const database = {
      connect: async () => undefined,
      transaction: async (operation: (session: object) => Promise<unknown>) => operation(session),
      db: { collection: () => collection },
    } as unknown as MongoDatabase;
    const store = new MongoFileStore(database, '.');

    await store.write('mongo-unit.json', { schemaVersion: 1, records: [
      { id: 'record-a', organisationId: 'org-a', value: 10 },
      { id: 'record-c', organisationId: 'org-c', value: 3 },
    ] });

    assert.equal(collectionWideDeleteUsed, false);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], [
      { replaceOne: { filter: { _id: 'record-a' }, replacement: { id: 'record-a', organisationId: 'org-a', value: 10, _id: 'record-a' }, upsert: true } },
      { replaceOne: { filter: { _id: 'record-c' }, replacement: { id: 'record-c', organisationId: 'org-c', value: 3, _id: 'record-c' }, upsert: true } },
    ]);
    assert.deepEqual(writes[1], [
      { deleteOne: { filter: { _id: 'record-b', organisationId: 'org-b' } } },
    ]);
  });

  it('mutates only the selected tenant records in the MongoDB adapter', async () => {
    const original = [
      { _id: 'document-a', id: 'document-a', organisationId: 'org-a', value: 1 },
      { _id: 'document-b', id: 'document-b', organisationId: 'org-a', value: 2 },
    ];
    const session = {};
    const writes: unknown[][] = [];
    let query: Record<string, unknown> | undefined;
    const database = {
      connect: async () => undefined,
      transaction: async (operation: (session: object) => Promise<unknown>) => operation(session),
      db: { collection: () => ({
        find: (filter: Record<string, unknown>) => {
          query = filter;
          return { map: (transform: (record: typeof original[number]) => unknown) => ({
            toArray: async () => original.filter(record => record.organisationId === filter.organisationId).map(transform),
          }) };
        },
        bulkWrite: async (operations: unknown[]) => { writes.push(operations); },
      }) },
    } as unknown as MongoDatabase;
    const store = new MongoFileStore(database, '.');
    const isRecord = (value: unknown): value is { id: string; organisationId: string; value: number } =>
      !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { organisationId?: unknown }).organisationId === 'string' &&
      typeof (value as { value?: unknown }).value === 'number';

    await store.updateTenant('documents.json', 'org-a', isRecord, records => {
      records[0]!.value = 10;
      records.pop();
    });

    assert.deepEqual(query, { organisationId: 'org-a' });
    assert.deepEqual(writes, [
      [{ replaceOne: { filter: { _id: 'document-a' }, replacement: { id: 'document-a', organisationId: 'org-a', value: 10, _id: 'document-a' }, upsert: true } }],
      [{ deleteOne: { filter: { _id: 'document-b', organisationId: 'org-a' } } }],
    ]);
  });

  it('translates identity lookups into indexed MongoDB id and membership filters', async () => {
    let userFilter: Record<string, unknown> | undefined;
    const database = {
      connect: async () => undefined,
      currentSession: () => undefined,
      db: { collection: () => ({
        find: (filter: Record<string, unknown>) => {
          userFilter = filter;
          return { map: (transform: (record: Record<string, unknown>) => unknown) => ({
            toArray: async () => [transform({ _id: 'user-a', email: 'user-a@example.test', status: 'active' })],
          }) };
        },
      }) },
    } as unknown as MongoDatabase;
    const store = new MongoFileStore(database, '.');
    const validUser = (value: unknown): value is { id: string; email: string; status: string } =>
      !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { email?: unknown }).email === 'string' && typeof (value as { status?: unknown }).status === 'string';

    assert.deepEqual(await store.findRecords('users.json', validUser, {
      id: { $in: ['user-a', 'user-b'] }, status: 'active',
    }), [{ id: 'user-a', email: 'user-a@example.test', status: 'active' }]);
    assert.deepEqual(userFilter, { _id: { $in: ['user-a', 'user-b'] }, status: 'active' });
    await assert.rejects(store.findRecords('users.json', validUser, { id: { $ne: 'user-a' } }), /supports only the \$in field operator/);
  });

  it('provisions tenant-scoped indexes for AI history, jobs and document policy lookups', async () => {
    const indexes: Array<{ collection: string; keys: Record<string, number>; name?: string; unique?: boolean; collation?: { locale: string; strength: number } }> = [];
    const database = {
      connect: async () => undefined,
      db: { collection: (collection: string) => ({
        createIndex: async (keys: Record<string, number>, options?: { name?: string; unique?: boolean; collation?: { locale: string; strength: number } }) => {
          indexes.push({ collection, keys, ...(options?.name ? { name: options.name } : {}),
            ...(options?.unique !== undefined ? { unique: options.unique } : {}),
            ...(options?.collation ? { collation: options.collation } : {}) });
        },
      }) },
    } as unknown as MongoDatabase;
    await new MongoFileStore(database, '.').initialize();

    assert.ok(indexes.some(index => index.collection === 'app_ai-analyses' && index.name === 'tenant_ticket_ai_analyses' &&
      index.keys.organisationId === 1 && index.keys.ticketId === 1));
    assert.ok(indexes.some(index => index.collection === 'app_users' && index.name === 'user_email_unique_case_insensitive' &&
      index.keys.email === 1 && index.unique === true && index.collation?.locale === 'en' && index.collation.strength === 2));
    assert.ok(indexes.some(index => index.collection === 'app_organisations' && index.name === 'organisation_name_unique_case_insensitive' &&
      index.keys.name === 1 && index.unique === true && index.collation?.locale === 'en' && index.collation.strength === 2));
    assert.ok(indexes.some(index => index.collection === 'app_ai-workflow-runs' && index.name === 'tenant_ticket_ai_workflow_runs' &&
      index.keys.organisationId === 1 && index.keys.ticketId === 1));
    assert.ok(indexes.some(index => index.collection === 'app_ai-operations' && index.name === 'tenant_ai_operation_history' &&
      index.keys.organisationId === 1 && index.keys.kind === 1));
    assert.ok(indexes.some(index => index.collection === 'app_auditLogs' && index.name === 'tenant_audit_log_history' &&
      index.keys.organisationId === 1 && index.keys.createdAt === -1));
    assert.ok(indexes.some(index => index.collection === 'app_ai-operations' && index.name === 'ai_job_polling' &&
      index.keys.kind === 1 && index.keys['data.status'] === 1));
    assert.ok(indexes.some(index => index.collection === 'app_extractionJobs' && index.name === 'tenant_document_extraction_jobs' &&
      index.keys.organisationId === 1 && index.keys.documentId === 1));
    assert.ok(indexes.some(index => index.collection === 'app_documentExtractions' && index.name === 'tenant_document_extraction_history' &&
      index.keys.organisationId === 1 && index.keys.documentId === 1));
    assert.ok(indexes.some(index => index.collection === 'app_policyApprovals' && index.name === 'tenant_policy_approval_lookup' &&
      index.keys.organisationId === 1 && index.keys.policyVersionId === 1));
    assert.ok(indexes.some(index => index.collection === 'app_tickets' && index.name === 'tenant_team_ticket_queue' &&
      index.keys.organisationId === 1 && index.keys.teamId === 1));
    assert.ok(indexes.some(index => index.collection === 'app_tickets' && index.name === 'tenant_requester_ticket_queue' &&
      index.keys.organisationId === 1 && index.keys.requesterId === 1));
    assert.ok(indexes.some(index => index.collection === 'app_tickets' && index.name === 'tenant_open_escalations_queue' &&
      index.keys.organisationId === 1 && index.keys['escalations.status'] === 1 && index.keys.teamId === 1));
  });

  it('inserts and mutates global identity records by ID instead of reading collection snapshots', async () => {
    let inserted: Record<string, unknown> | undefined;
    let foundFilter: Record<string, unknown> | undefined;
    let replaced: Record<string, unknown> | undefined;
    const database = {
      connect: async () => undefined,
      currentSession: () => undefined,
      transaction: async (operation: (session: object) => Promise<unknown>) => operation({}),
      db: { collection: () => ({
        insertOne: async (record: Record<string, unknown>) => { inserted = record; },
        findOne: async (filter: Record<string, unknown>) => {
          foundFilter = filter;
          return { _id: 'user-1', id: 'user-1', organisationId: 'org-1', displayName: 'Before' };
        },
        replaceOne: async (_filter: Record<string, unknown>, record: Record<string, unknown>) => { replaced = record; },
      }) },
    } as unknown as MongoDatabase;
    const store = new MongoFileStore(database, '.');
    type UserRecord = { id: string; organisationId: string; displayName: string };
    const isUserRecord = (value: unknown): value is UserRecord => !!value && typeof value === 'object' &&
      typeof (value as UserRecord).id === 'string' && typeof (value as UserRecord).organisationId === 'string' &&
      typeof (value as UserRecord).displayName === 'string';
    await store.insertRecord('users.json', isUserRecord, { id: 'user-1', organisationId: 'org-1', displayName: 'Before' });
    const updated = await store.mutateRecord('users.json', 'user-1', isUserRecord, current => {
      const record = { ...current!, displayName: 'After' };
      return { record, result: record };
    });

    assert.equal(inserted?._id, 'user-1');
    assert.deepEqual(foundFilter, { _id: 'user-1' });
    assert.equal(replaced?.displayName, 'After');
    assert.deepEqual(updated, { id: 'user-1', organisationId: 'org-1', displayName: 'After' });
  });

  it('archives an active workflow before activating its replacement', async () => {
    const config = {
      sourceReference: 'Synthetic workflow policy', initialStatus: 'NEW', reopenStatus: 'REOPENED',
      statuses: ['NEW', 'RESOLVED', 'REOPENED'],
      transitions: { NEW: ['RESOLVED'], RESOLVED: ['REOPENED'], REOPENED: ['NEW'] },
      requestableReopenFrom: ['RESOLVED'], restrictedReopenFrom: [],
      permissions: {
        directStatusChangeRoles: ['support_agent'], closedReopenRoles: ['organisation_admin'],
        reopenRequestRoles: ['requester'], reopenApprovalRoles: ['support_lead'],
        administratorOverrideRoles: ['organisation_admin'],
      },
    };
    const draft: TicketWorkflowRecord = {
      id: 'workflow-draft', organisationId: 'org-a', config, status: 'draft', createdBy: 'admin',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const active: TicketWorkflowRecord = {
      id: 'workflow-active', organisationId: 'org-a', config, status: 'active', createdBy: 'admin',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      approvedBy: 'admin', approvedAt: '2026-01-01T00:00:00.000Z',
    };
    const session = {};
    const writes: unknown[][] = [];
    let workflowReadQuery: Record<string, unknown> | undefined;
    const database = {
      transaction: async (operation: (session: object) => Promise<unknown>) => operation(session),
      currentSession: () => session,
      db: { collection: () => ({
        find: (query: Record<string, unknown>) => {
          workflowReadQuery = query;
          return { toArray: async () => [
            { ...draft, _id: draft.id }, { ...active, _id: active.id },
          ].filter(record => record.organisationId === query.organisationId) };
        },
        bulkWrite: async (operations: unknown[]) => { writes.push(operations); },
      }) },
    } as unknown as MongoDatabase;
    class TestableWorkflowStore extends MongoTicketWorkflowStore {
      load() { return this.readRecords(); }
      save(records: TicketWorkflowRecord[]) { return this.writeRecords(records); }
      inTenant<T>(operation: () => Promise<T>) { return this.withLock('org-a', operation); }
    }
    const store = new TestableWorkflowStore(database);
    const now = '2026-01-02T00:00:00.000Z';
    await store.inTenant(async () => {
      const previous = await store.load();
      const next = [
        { ...previous[0]!, status: 'active' as const, approvedBy: 'reviewer', approvedAt: now, updatedAt: now },
        { ...previous[1]!, status: 'archived' as const, updatedAt: now },
      ];
      await store.save(next);
    });

    assert.deepEqual(workflowReadQuery, { organisationId: 'org-a' });
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.map(operation => (operation as { replaceOne: { filter: { _id: string; organisationId: string } } }).replaceOne.filter), [
      { _id: 'workflow-active', organisationId: 'org-a' },
      { _id: 'workflow-draft', organisationId: 'org-a' },
    ]);
  });
});

const mongoUri = process.env.MONGODB_TEST_URI;
describe('MongoDB persistence integration', { skip: !mongoUri ? 'Set MONGODB_TEST_URI to run isolated Atlas/replica-set checks.' : false }, () => {
  it('persists tenant collections and rolls back multi-collection transactions', async () => {
    const databaseName = `ai_support_test_${Date.now()}`;
    const database = new MongoDatabase(mongoUri!, databaseName);
    const store = new MongoFileStore(database, '.');
    const valid = (value: unknown): value is JsonEnvelope<{ id: string; organisationId: string; value: number }> => {
      if (!value || typeof value !== 'object') return false;
      const envelope = value as { schemaVersion?: unknown; records?: unknown };
      return envelope.schemaVersion === 1 && Array.isArray(envelope.records) && envelope.records.every(record =>
        !!record && typeof record === 'object' && typeof (record as { id?: unknown }).id === 'string' &&
        typeof (record as { organisationId?: unknown }).organisationId === 'string' &&
        typeof (record as { value?: unknown }).value === 'number');
    };
    try {
      await store.initialize();
      await store.update('mongo-test.json', valid, envelope => {
        envelope.records.push({ id: 'r1', organisationId: 'org-a', value: 1 });
      });
      assert.deepEqual((await store.read('mongo-test.json', valid)).records, [
        { id: 'r1', organisationId: 'org-a', value: 1 },
      ]);
      await assert.rejects(store.runExclusive('rollback', async () => {
        await store.update('mongo-test.json', valid, envelope => {
          envelope.records.push({ id: 'r2', organisationId: 'org-a', value: 2 });
        });
        throw new Error('rollback fixture');
      }), /rollback fixture/);
      assert.equal((await store.read('mongo-test.json', valid)).records.length, 1);

      const tickets = new MongoTicketStore(database);
      const workflows = new MongoTicketWorkflowStore(database);
      await tickets.initialize();
      await database.db.collection('app_tickets').insertMany([
        { _id: new ObjectId('650000000000000000000001'), id: 'ticket-org-a', organisationId: 'org-a', requesterId: 'requester-a', title: 'Tenant A', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { _id: new ObjectId('650000000000000000000002'), id: 'ticket-org-b', organisationId: 'org-b', requesterId: 'requester-b', title: 'Tenant B', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ]);
      const tenant = { organisationId: 'org-a', userId: 'user-a', roles: [] };
      assert.deepEqual((await tickets.listTickets(tenant)).map(ticket => ticket.id), ['ticket-org-a']);
      assert.equal(await tickets.findTicket(tenant, 'ticket-org-a') !== null, true);
      assert.equal(await tickets.findTicket(tenant, 'ticket-org-b'), null);
      const created = await tickets.createTicket({
        organisationId: tenant.organisationId, requesterId: tenant.userId, title: 'Impact persistence check',
        description: 'Synthetic isolated MongoDB integration fixture.',
        affectedUsers: { scope: 'multiple_departments', count: 150 }, businessImpact: 'critical', urgency: 'immediate',
      }, tenant);
      const retrieved = await new MongoTicketStore(database).findTicket(tenant, created.id);
      assert.deepEqual(retrieved?.affectedUsers, { scope: 'multiple_departments', count: 150 });
      assert.equal(retrieved?.businessImpact, 'critical');
      assert.equal(retrieved?.urgency, 'immediate');
      const legacy = await tickets.findTicket(tenant, 'ticket-org-a');
      assert.equal(legacy?.affectedUsers, undefined);
      assert.equal(legacy?.businessImpact, undefined);
      assert.equal(legacy?.urgency, undefined);
      assert.deepEqual(await workflows.list(tenant), []);
    } finally {
      await database.db.dropDatabase().catch(() => undefined);
      await database.close();
    }
  });
});
