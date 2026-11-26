import { api, type SupportTicket } from "@/lib/api";

export async function loadVisibleTickets(): Promise<SupportTicket[]> {
  const first = await api.tickets({ limit: 100, offset: 0 });
  const tickets = [...first.data];
  for (let offset = 100; offset < first.pagination.total; offset += 100) {
    tickets.push(...(await api.tickets({ limit: 100, offset })).data);
  }
  return tickets;
}
