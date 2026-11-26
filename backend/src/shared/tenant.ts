import type { TenantContext } from './auth/authentication.js';
export type { TenantContext } from './auth/authentication.js';

export function assertTenantAccess<T extends { organisationId: string }>(
  tenant: TenantContext,
  record: T | null | undefined,
): T | null {
  if (!record) {
    return null;
  }

  if (record.organisationId !== tenant.organisationId) {
    return null;
  }

  return record;
}
