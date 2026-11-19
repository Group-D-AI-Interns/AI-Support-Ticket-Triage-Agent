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
  | 'status'
  | 'priority'
  | 'source'
  | 'createdAt'
  | 'updatedAt'
>;

export interface TicketReadService {
  getTicket(
    tenant: TenantContext,
    ticketId: string,
  ): Promise<TicketReadModel | null>;

  listTickets(tenant: TenantContext): Promise<TicketReadModel[]>;
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
    teamId,
    title,
    description,
    product,
    affectedService,
    status,
    priority,
    source,
    createdAt,
    updatedAt,
  };
}
