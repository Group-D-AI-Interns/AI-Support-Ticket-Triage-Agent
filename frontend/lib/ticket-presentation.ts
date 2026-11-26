import type { SupportTicket } from "@/lib/api";

export function ticketStatusKey(status?: string): string {
  return status?.trim().toLowerCase().replace(/[\s-]+/g, "_") || "open";
}

export function ticketStatusLabel(status?: string): string {
  return ticketStatusKey(status)
    .split("_")
    .filter(Boolean)
    .map(part => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export function requesterTicketCounts(tickets: SupportTicket[]) {
  const keys = tickets.map(ticket => ticketStatusKey(ticket.status));
  return {
    total: tickets.length,
    open: keys.filter(status => ["new", "open", "pending"].includes(status)).length,
    inProgress: keys.filter(status => ["in_progress", "inprogress", "working"].includes(status)).length,
    resolved: keys.filter(status => ["resolved", "closed", "done"].includes(status)).length,
  };
}

export function requesterTicketStatusBreakdown(tickets: SupportTicket[]): { key: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const ticket of tickets) {
    const key = ticketStatusKey(ticket.status);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: ticketStatusLabel(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
