import { AppError } from "../errors/app-error.ts";

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", [{ field, message: `${field} is required.` }]);
  }
  return value.trim();
}

export function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((field) => !allowed.includes(field));
  if (unknown.length) throw new AppError(400, "VALIDATION_ERROR", "The request is invalid.", unknown.map((field) => ({ field, message: "This field is not supported." })));
}
