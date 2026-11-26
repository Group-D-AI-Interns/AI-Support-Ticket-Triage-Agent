import { MongoDatabase, mongoCollectionName } from './mongo-database.js';
import { isTicketRecord, JsonTicketStore, TicketStoreError } from '../../../modules/tickets/repositories/json-ticket.store.js';
import { isWorkflowRecord, JsonTicketWorkflowStore, TicketWorkflowStoreError } from '../../../modules/tickets/repositories/json-ticket-workflow.store.js';
import type { TicketRecord } from '../../../modules/tickets/domain/ticket.js';
import type { TicketWorkflowRecord } from '../../../modules/tickets/domain/ticket-workflow.js';
import type { TenantContext } from '../../../shared/tenant.js';
import { isDeepStrictEqual } from 'node:util';
import type { ClientSession, Document, Filter } from 'mongodb';
import type { TicketListFilters, TicketReadScope } from '../../../modules/tickets/application/ticket-read.service.js';
import { normalizeTicketPriority } from '../../../modules/tickets/domain/priority.js';

type MongoStoredRecord = Document & { _id: string; id: string };

export class MongoTicketStore extends JsonTicketStore {
  private readonly snapshots = new WeakMap<ClientSession, TicketRecord[]>();
  private readonly tenantScope = new WeakMap<ClientSession, string>();

  constructor(private readonly database: MongoDatabase) { super('.'); }

  async initialize(): Promise<void> {
    const tickets = this.database.db.collection(mongoCollectionName('tickets'));
    await tickets.createIndex({ organisationId: 1, createdAt: -1 }, { name: 'tenant_ticket_queue' });
    await tickets.createIndex({ organisationId: 1, teamId: 1, createdAt: -1 }, { name: 'tenant_team_ticket_queue' });
    await tickets.createIndex({ organisationId: 1, requesterId: 1, createdAt: -1 }, { name: 'tenant_requester_ticket_queue' });
    await tickets.createIndex(
      { organisationId: 1, 'escalations.status': 1, teamId: 1, createdAt: -1 },
      { name: 'tenant_open_escalations_queue' },
    );
    await this.database.db.collection(mongoCollectionName('ticket-workflows'))
      .createIndex({ organisationId: 1, status: 1 }, {
        name: 'one_active_workflow_per_tenant',
        unique: true,
        partialFilterExpression: { status: 'active' },
      });
  }

  /** Read only the active tenant's tickets; do not materialize other tenants' records. */
  override async listTickets(tenant: TenantContext): Promise<TicketRecord[]> {
    try {
      await this.database.connect();
      const session = this.database.currentSession();
      const records = await this.database.db.collection<MongoStoredRecord>(mongoCollectionName('tickets'))
        .find({ organisationId: tenant.organisationId }, session ? { session } : {})
        .toArray();
      return validateTicketDocuments(records);
    } catch (error) {
      if (error instanceof TicketStoreError) throw error;
      throw new TicketStoreError('Ticket storage could not be accessed.', { cause: error });
    }
  }

  async listTicketsPage(
    tenant: TenantContext,
    filters: TicketListFilters,
    scope: TicketReadScope,
    limit: number,
    offset: number,
  ): Promise<{ data: TicketRecord[]; total: number } | null> {
    if (!scope.readAll && !scope.requesterId && !scope.includeUnassigned && scope.teamIds.length === 0) {
      return { data: [], total: 0 };
    }
    try {
      await this.database.connect();
      const session = this.database.currentSession();
      const query = ticketPageQuery(tenant, filters, scope);
      const collection = this.database.db.collection<MongoStoredRecord>(mongoCollectionName('tickets'));
      const total = await collection.countDocuments(query, session ? { session } : {});
      const records = await collection.find(query, {
        ...(session ? { session } : {}),
        projection: {
          _id: 1, id: 1, organisationId: 1, requesterId: 1, teamId: 1, title: 1,
          description: 1, product: 1, affectedService: 1, affectedUsers: 1,
          businessImpact: 1, urgency: 1, status: 1, priority: 1,
          source: 1, createdAt: 1, updatedAt: 1,
        },
        sort: { createdAt: -1, _id: -1 },
        skip: offset,
        limit,
      }).toArray();
      return { data: validateTicketDocuments(records), total };
    } catch (error) {
      if (error instanceof TicketStoreError) throw error;
      throw new TicketStoreError('Ticket storage could not be accessed.', { cause: error });
    }
  }

  /** Read open escalations from the active tenant and only within the caller's ticket scope. */
  async listOpenEscalatedTickets(
    tenant: TenantContext,
    scope: TicketReadScope,
  ): Promise<TicketRecord[]> {
    if (!scope.readAll && !scope.requesterId && !scope.includeUnassigned && scope.teamIds.length === 0) return [];
    try {
      await this.database.connect();
      const session = this.database.currentSession();
      const clauses: Filter<MongoStoredRecord>[] = [
        { organisationId: tenant.organisationId },
        { 'escalations.status': 'open' },
      ];
      if (!scope.readAll) {
        const access: Filter<MongoStoredRecord>[] = [];
        if (scope.requesterId) access.push({ requesterId: scope.requesterId });
        if (scope.includeUnassigned) access.push({ teamId: null });
        if (scope.teamIds.length) access.push({ teamId: { $in: [...scope.teamIds] } });
        clauses.push({ $or: access });
      }
      const records = await this.database.db.collection<MongoStoredRecord>(mongoCollectionName('tickets'))
        .find({ $and: clauses }, session ? { session } : {})
        .toArray();
      return validateTicketDocuments(records);
    } catch (error) {
      if (error instanceof TicketStoreError) throw error;
      throw new TicketStoreError('Ticket storage could not be accessed.', { cause: error });
    }
  }

  /** Include tenant scope in the lookup so a foreign ticket is indistinguishable from a missing one. */
  override async findTicket(tenant: TenantContext, ticketId: string): Promise<TicketRecord | null> {
    try {
      await this.database.connect();
      const session = this.database.currentSession();
      const record = await this.database.db.collection<MongoStoredRecord>(mongoCollectionName('tickets'))
        .findOne({ _id: ticketId, organisationId: tenant.organisationId }, session ? { session } : {});
      if (!record) return null;
      return validateTicketDocuments([record])[0] ?? null;
    } catch (error) {
      if (error instanceof TicketStoreError) throw error;
      throw new TicketStoreError('Ticket storage could not be accessed.', { cause: error });
    }
  }

  protected override async withLock<T>(organisationId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(async session => {
        this.tenantScope.set(session, organisationId);
        return operation();
      });
    } catch (error) {
      if (error instanceof TicketStoreError) throw error;
      throw new TicketStoreError('Ticket storage could not be accessed.', { cause: error });
    }
  }

  protected override async readRecords(): Promise<TicketRecord[]> {
    const session = this.database.currentSession();
    const organisationId = session ? this.tenantScope.get(session) : undefined;
    if (!session || !organisationId) throw new TicketStoreError('Tenant-scoped ticket access is required.');
    const records = await this.database.db.collection<MongoStoredRecord>(mongoCollectionName('tickets'))
      .find({ organisationId }, { session })
      .toArray();
    const normalized = validateTicketDocuments(records);
    if (session) this.snapshots.set(session, normalized.map(record => structuredClone(record)));
    return normalized;
  }

  protected override async writeRecords(records: TicketRecord[]): Promise<void> {
    const collection = this.database.db.collection<MongoStoredRecord>(mongoCollectionName('tickets'));
    const session = this.database.currentSession();
    if (!session) throw new TicketStoreError('Ticket update must run inside a database transaction.');
    const organisationId = this.tenantScope.get(session);
    if (!organisationId || records.some(record => record.organisationId !== organisationId)) {
      throw new TicketStoreError('Tenant-scoped ticket update is required.');
    }
    const previous = this.snapshots.get(session);
    if (!previous) throw new TicketStoreError('Ticket update is missing its transactional snapshot.');
    const previousById = new Map(previous.map(record => [record.id, record]));
    const nextById = new Map(records.map(record => [record.id, record]));
    const changed = records
      .filter(record => !isDeepStrictEqual(previousById.get(record.id), record))
      .map(record => ({ replaceOne: { filter: { _id: record.id, organisationId }, replacement: { ...record, _id: record.id }, upsert: true } }));
    const removed = previous.filter(record => !nextById.has(record.id));
    if (changed.length) await collection.bulkWrite(changed, { session, ordered: true });
    if (removed.length) {
      await collection.bulkWrite(removed.map(record => ({
        deleteOne: { filter: { _id: record.id, organisationId } },
      })), { session, ordered: true });
    }
    this.snapshots.set(session, records.map(record => structuredClone(record)));
  }
}

function validateTicketDocuments(records: Document[]): TicketRecord[] {
  const normalized = records.map(record => stripId(record));
  if (!normalized.every(isTicketRecord)) {
    throw new TicketStoreError('MongoDB ticket records do not match the supported schema.');
  }
  return normalized as unknown as TicketRecord[];
}

function ticketPageQuery(
  tenant: TenantContext,
  filters: TicketListFilters,
  scope: TicketReadScope,
): Filter<MongoStoredRecord> {
  const clauses: Filter<MongoStoredRecord>[] = [{ organisationId: tenant.organisationId }];
  if (!scope.readAll) {
    const access: Filter<MongoStoredRecord>[] = [];
    if (scope.requesterId) access.push({ requesterId: scope.requesterId });
    if (scope.includeUnassigned) access.push({ teamId: null });
    if (scope.teamIds.length) access.push({ teamId: { $in: [...scope.teamIds] } });
    if (!access.length) return { _id: { $in: [] } };
    clauses.push({ $or: access });
  }
  if (filters.status !== undefined) {
    const status = exactInsensitive(filters.status);
    clauses.push({ $or: [
      { status },
      { $and: [{ $or: [{ status: { $exists: false } }, { status: null }] }, { 'source.status': status }] },
    ] });
  }
  if (filters.priority !== undefined) {
    const canonical = normalizeTicketPriority(filters.priority);
    const internalAliases = canonical === 'P2' ? ['P2', 'high']
      : canonical === 'P3' ? ['P3', 'medium']
        : canonical === 'P4' ? ['P4', 'low']
          : canonical === 'P1' ? ['P1'] : [filters.priority];
    clauses.push({ $or: [
      { priority: insensitiveAlternatives(internalAliases) },
      { 'source.priority': exactInsensitive(filters.priority) },
    ] });
  }
  if (filters.teamId !== undefined) clauses.push({ teamId: filters.teamId });
  if (filters.requesterId !== undefined) clauses.push({ requesterId: filters.requesterId });
  return { $and: clauses };
}

function exactInsensitive(value: string): RegExp {
  return new RegExp(`^${escapeRegularExpression(value)}$`, 'i');
}

function insensitiveAlternatives(values: string[]): RegExp {
  return new RegExp(`^(?:${values.map(escapeRegularExpression).join('|')})$`, 'i');
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class MongoTicketWorkflowStore extends JsonTicketWorkflowStore {
  private readonly snapshots = new WeakMap<ClientSession, TicketWorkflowRecord[]>();
  private readonly tenantScope = new WeakMap<ClientSession, string>();

  constructor(private readonly database: MongoDatabase) { super('.'); }

  protected override async withLock<T>(organisationId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(async session => {
        this.tenantScope.set(session, organisationId);
        return operation();
      });
    } catch (error) {
      if (error instanceof TicketWorkflowStoreError) throw error;
      throw new TicketWorkflowStoreError('Ticket workflow storage could not be accessed.', { cause: error });
    }
  }

  protected override async readRecords(): Promise<TicketWorkflowRecord[]> {
    const session = this.database.currentSession();
    const organisationId = session ? this.tenantScope.get(session) : undefined;
    if (!session || !organisationId) throw new TicketWorkflowStoreError('Tenant-scoped workflow access is required.');
    const records = await this.database.db.collection<MongoStoredRecord>(mongoCollectionName('ticket-workflows'))
      .find({ organisationId }, { session })
      .toArray();
    const normalized = records.map(record => stripId(record));
    if (!normalized.every(isWorkflowRecord)) throw new TicketWorkflowStoreError('MongoDB ticket workflows do not match the supported schema.');
    const workflows = normalized as unknown as TicketWorkflowRecord[];
    if (session) this.snapshots.set(session, workflows.map(record => structuredClone(record)));
    return workflows;
  }

  protected override async writeRecords(records: TicketWorkflowRecord[]): Promise<void> {
    const collection = this.database.db.collection<MongoStoredRecord>(mongoCollectionName('ticket-workflows'));
    const session = this.database.currentSession();
    if (!session) throw new TicketWorkflowStoreError('Ticket workflow update must run inside a database transaction.');
    const organisationId = this.tenantScope.get(session);
    if (!organisationId || records.some(record => record.organisationId !== organisationId)) {
      throw new TicketWorkflowStoreError('Tenant-scoped workflow update is required.');
    }
    const previous = this.snapshots.get(session);
    if (!previous) throw new TicketWorkflowStoreError('Ticket workflow update is missing its transactional snapshot.');
    const previousById = new Map(previous.map(record => [record.id, record]));
    const nextById = new Map(records.map(record => [record.id, record]));
    const changed = records
      .filter(record => !isDeepStrictEqual(previousById.get(record.id), record))
      .sort((left, right) => Number(left.status === 'active') - Number(right.status === 'active'))
      .map(record => ({ replaceOne: { filter: { _id: record.id, organisationId }, replacement: { ...record, _id: record.id }, upsert: true } }));
    const removed = previous.filter(record => !nextById.has(record.id));
    if (changed.length) await collection.bulkWrite(changed, { session, ordered: true });
    if (removed.length) {
      await collection.bulkWrite(removed.map(record => ({
        deleteOne: { filter: { _id: record.id, organisationId } },
      })), { session, ordered: true });
    }
    this.snapshots.set(session, records.map(record => structuredClone(record)));
  }
}

function stripId(record: Document): Document {
  const { _id, ...fields } = record;
  return { ...fields, id: typeof fields.id === 'string' ? fields.id : String(_id) };
}
