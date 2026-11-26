import type { AffectedUserScope, BusinessImpact, TicketUrgency } from "@/lib/api";

export function parseAffectedUserCount(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Number of users affected must be a positive whole number, or left empty if unknown.");
  }
  return count;
}

export function requiredTicketImpactFields(
  scope: AffectedUserScope | "",
  impact: BusinessImpact | "",
  urgency: TicketUrgency | "",
): { scope: AffectedUserScope; businessImpact: BusinessImpact; urgency: TicketUrgency } | null {
  return scope && impact && urgency ? { scope, businessImpact: impact, urgency } : null;
}
