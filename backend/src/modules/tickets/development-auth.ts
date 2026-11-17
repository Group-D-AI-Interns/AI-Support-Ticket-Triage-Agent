import { timingSafeEqual } from 'node:crypto';

export class DevelopmentAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevelopmentAuthConfigurationError';
  }
}

export type TicketRole = 'requester' | 'support_agent' | 'support_lead';

const supportedRoles = new Set<TicketRole>([
  'requester',
  'support_agent',
  'support_lead',
]);

export type DevelopmentPrincipal = {
  bearerToken: string;
  organisationId: string;
  userId: string;
  roles: ReadonlySet<TicketRole>;
  teamIds: ReadonlySet<string>;
};

export function loadDevelopmentPrincipal(
  environment: Record<string, string | undefined>,
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

  let value: unknown;
  try {
    value = JSON.parse(rawConfig);
  } catch {
    throw new DevelopmentAuthConfigurationError(
      'TICKET_DEV_PRINCIPAL must contain valid JSON.',
    );
  }
  if (!isRecord(value)) {
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
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new DevelopmentAuthConfigurationError(
      'TICKET_DEV_PRINCIPAL contains unsupported fields.',
    );
  }

  const bearerToken = value.bearerToken;
  const organisationId = value.organisationId;
  const userId = value.userId;
  const roles = value.roles;
  const teamIds = value.teamIds ?? [];

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
    throw new DevelopmentAuthConfigurationError('A development userId is required.');
  }
  if (
    !Array.isArray(roles)
    || roles.length === 0
    || roles.some((role) => typeof role !== 'string' || !supportedRoles.has(role as TicketRole))
    || new Set(roles).size !== roles.length
  ) {
    throw new DevelopmentAuthConfigurationError(
      'Development roles must be unique values selected from requester, support_agent, and support_lead.',
    );
  }
  if (
    !Array.isArray(teamIds)
    || teamIds.some((teamId) => typeof teamId !== 'string' || !teamId)
    || new Set(teamIds).size !== teamIds.length
  ) {
    throw new DevelopmentAuthConfigurationError(
      'Development teamIds must be unique non-empty strings.',
    );
  }

  return {
    bearerToken,
    organisationId,
    userId,
    roles: new Set(roles as TicketRole[]),
    teamIds: new Set(teamIds as string[]),
  };
}

export function matchesBearerToken(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length
    && timingSafeEqual(expectedBytes, providedBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
