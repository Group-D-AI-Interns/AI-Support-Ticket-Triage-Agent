import { timingSafeEqual } from 'node:crypto';

import type { TenantContext } from '../../shared/tenant.js';

export class DevelopmentAuthConfigurationError extends Error {}

export const SUPPORTED_ROLES = new Set([
  'requester',
  'support_agent',
  'support_lead',
  'organisation_admin',
]);

export type DevelopmentPrincipal = TenantContext & {
  bearerToken: string;
  roles: string[];
  teamIds: string[];
  permissions?: string[];
};

export function developmentPrincipalFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): DevelopmentPrincipal | null {
  const rawConfig = environment.TICKET_DEV_PRINCIPAL;
  if (!rawConfig) {
    return null;
  }
  if (environment.APP_ENV !== 'development') {
    throw new DevelopmentAuthConfigurationError(
      'TICKET_DEV_PRINCIPAL is permitted only when APP_ENV=development.',
    );
  }

  let config: unknown;
  try {
    config = JSON.parse(rawConfig);
  } catch {
    throw new DevelopmentAuthConfigurationError(
      'TICKET_DEV_PRINCIPAL must contain valid JSON.',
    );
  }
  if (!isRecord(config)) {
    throw new DevelopmentAuthConfigurationError(
      'TICKET_DEV_PRINCIPAL must be a JSON object.',
    );
  }

  const allowedFields = new Set([
    'bearerToken',
    'organisationId',
    'userId',
    'roles',
    'teamIds',
  ]);
  if (Object.keys(config).some((field) => !allowedFields.has(field))) {
    throw new DevelopmentAuthConfigurationError(
      'TICKET_DEV_PRINCIPAL contains unsupported fields.',
    );
  }

  const { bearerToken, organisationId, userId, roles, teamIds = [] } = config;
  if (typeof bearerToken !== 'string' || bearerToken.length < 32) {
    throw new DevelopmentAuthConfigurationError(
      'The development bearer token must contain at least 32 characters.',
    );
  }
  if (typeof organisationId !== 'string' || !organisationId) {
    throw new DevelopmentAuthConfigurationError(
      'A development organisationId is required.',
    );
  }
  if (typeof userId !== 'string' || !userId) {
    throw new DevelopmentAuthConfigurationError(
      'A development userId is required.',
    );
  }
  if (
    !Array.isArray(roles) ||
    roles.length === 0 ||
    roles.some((role) => typeof role !== 'string' || !SUPPORTED_ROLES.has(role))
  ) {
    throw new DevelopmentAuthConfigurationError(
      'Development roles must be selected from requester, support_agent, support_lead, and organisation_admin.',
    );
  }
  if (
    !Array.isArray(teamIds) ||
    teamIds.some((teamId) => typeof teamId !== 'string' || !teamId)
  ) {
    throw new DevelopmentAuthConfigurationError(
      'Development teamIds must be an array of non-empty strings.',
    );
  }
  if (
    new Set(roles).size !== roles.length ||
    new Set(teamIds).size !== teamIds.length
  ) {
    throw new DevelopmentAuthConfigurationError(
      'Development roles and teamIds must not contain duplicates.',
    );
  }

  return {
    bearerToken,
    organisationId,
    userId,
    roles,
    teamIds,
  };
}

export function secureStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
