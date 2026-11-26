export const TICKET_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

const legacyPriorities: Readonly<Record<string, TicketPriority>> = {
  high: 'P2',
  medium: 'P3',
  low: 'P4',
};

export function normalizeTicketPriority(value: string): TicketPriority | null {
  const normalized = value.trim().toUpperCase();
  if (TICKET_PRIORITIES.includes(normalized as TicketPriority)) {
    return normalized as TicketPriority;
  }
  return legacyPriorities[value.trim().toLowerCase()] ?? null;
}

export function normalizeStoredTicketPriority(value: string): string {
  return normalizeTicketPriority(value) ?? value;
}

export function legacySlaPriorityFor(value: string): string | undefined {
  switch (value) {
    case 'P2':
      return 'high';
    case 'P3':
      return 'medium';
    case 'P4':
      return 'low';
    default:
      return undefined;
  }
}
