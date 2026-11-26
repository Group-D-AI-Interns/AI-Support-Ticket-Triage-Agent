import type { TenantContext } from '../../../shared/tenant.js';
import type { TicketRecord } from '../domain/ticket.js';
import { JsonTicketStore } from '../repositories/json-ticket.store.js';

export type TicketReadModel = Pick<
  TicketRecord,
  | 'id'
  | 'organisationId'
  | 'requesterId'
  | 'teamId'
  | 'title'
  | 'description'
  | 'product'
  | 'affectedService'
  | 'affectedUsers'
  | 'businessImpact'
  | 'urgency'
  | 'status'
  | 'priority'
  | 'source'
  | 'createdAt'
  | 'updatedAt'
>;

export type TicketListFilters = {
  status?: string;
  priority?: string;
  teamId?: string;
  requesterId?: string;
};

export type TicketReadScope = {
  readAll: boolean;
  requesterId?: string;
  includeUnassigned: boolean;
  teamIds: readonly string[];
};

export type TicketReadPage = { data: TicketReadModel[]; total: number };

export interface TicketReadService {
  getTicket(
    tenant: TenantContext,
    ticketId: string,
  ): Promise<TicketReadModel | null>;

  listTickets(tenant: TenantContext): Promise<TicketReadModel[]>;

  /** Optional database-side filtering and pagination for repositories that support it. */
  listTicketsPage?(
    tenant: TenantContext,
    filters: TicketListFilters,
    scope: TicketReadScope,
    limit: number,
    offset: number,
  ): Promise<TicketReadPage | null>;
}

export class JsonTicketReadService implements TicketReadService {
  constructor(private readonly store: JsonTicketStore) {}

  async getTicket(
    tenant: TenantContext,
    ticketId: string,
  ): Promise<TicketReadModel | null> {
    const ticket = await this.store.findTicket(tenant, ticketId);
    return ticket ? toTicketReadModel(ticket) : null;
  }

  async listTickets(tenant: TenantContext): Promise<TicketReadModel[]> {
    const tickets = await this.store.listTickets(tenant);
    return tickets.map(toTicketReadModel);
  }

  async listTicketsPage(
    tenant: TenantContext,
    filters: TicketListFilters,
    scope: TicketReadScope,
    limit: number,
    offset: number,
  ): Promise<TicketReadPage | null> {
    const pagedStore = this.store as JsonTicketStore & {
      listTicketsPage?: (tenant: TenantContext, filters: TicketListFilters, scope: TicketReadScope, limit: number, offset: number) => Promise<{ data: TicketRecord[]; total: number }>;
    };
    if (!pagedStore.listTicketsPage) return null;
    const page = await pagedStore.listTicketsPage(tenant, filters, scope, limit, offset);
    return page ? { data: page.data.map(toTicketReadModel), total: page.total } : null;
  }
}

function toTicketReadModel(ticket: TicketRecord): TicketReadModel {
  const {
    id,
    organisationId,
    requesterId,
    teamId,
    title,
    description,
    product,
    affectedService,
    affectedUsers,
    businessImpact,
    urgency,
    status,
    priority,
    source,
    createdAt,
    updatedAt,
  } = ticket;
  return {
    id,
    organisationId,
    requesterId,
    ...(teamId === undefined ? {} : { teamId }),
    title,
    ...(description === undefined ? {} : { description }),
    ...(product === undefined ? {} : { product }),
    ...(affectedService === undefined ? {} : { affectedService }),
    ...(affectedUsers === undefined ? {} : { affectedUsers }),
    ...(businessImpact === undefined ? {} : { businessImpact }),
    ...(urgency === undefined ? {} : { urgency }),
    ...(status === undefined ? {} : { status }),
    ...(priority === undefined ? {} : { priority }),
    ...(source === undefined ? {} : { source }),
    createdAt,
    updatedAt,
  };
}
