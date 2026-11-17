export class JiraConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraConfigurationError';
  }
}

export type JiraOrganisationConfiguration = {
  webhookSecret: string;
  reporterMappings: ReadonlyMap<string, string>;
};

export type JiraSettings = {
  projectMappings: ReadonlyMap<string, string>;
  organisations: ReadonlyMap<string, JiraOrganisationConfiguration>;
};

export function loadJiraSettings(
  environment: Record<string, string | undefined>,
): JiraSettings {
  const rawConfig = environment.JIRA_TENANT_CONFIG;
  if (!rawConfig) {
    throw new JiraConfigurationError('JIRA_TENANT_CONFIG is required.');
  }

  let value: unknown;
  try {
    value = JSON.parse(rawConfig);
  } catch {
    throw new JiraConfigurationError('JIRA_TENANT_CONFIG must contain valid JSON.');
  }
  if (!isRecord(value)) {
    throw new JiraConfigurationError('JIRA_TENANT_CONFIG must be a JSON object.');
  }

  const rawProjects = value.projectMappings;
  const rawOrganisations = value.organisations;
  if (!isNonEmptyRecord(rawProjects)) {
    throw new JiraConfigurationError(
      'JIRA_TENANT_CONFIG.projectMappings must be a non-empty object.',
    );
  }
  if (!isNonEmptyRecord(rawOrganisations)) {
    throw new JiraConfigurationError(
      'JIRA_TENANT_CONFIG.organisations must be a non-empty object.',
    );
  }

  const organisations = new Map<string, JiraOrganisationConfiguration>();
  for (const [organisationId, rawOrganisation] of Object.entries(rawOrganisations)) {
    if (!organisationId || !isRecord(rawOrganisation)) {
      throw new JiraConfigurationError('Each organisation Jira configuration must be an object.');
    }

    const secret = rawOrganisation.webhookSecret;
    const rawMappings = rawOrganisation.reporterMappings;
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new JiraConfigurationError(
        'Each Jira webhook secret must contain at least 32 characters.',
      );
    }
    if (!isNonEmptyRecord(rawMappings)) {
      throw new JiraConfigurationError(
        'Each organisation must configure a non-empty reporterMappings object.',
      );
    }

    const reporterMappings = new Map<string, string>();
    for (const [accountId, userId] of Object.entries(rawMappings)) {
      if (!accountId || typeof userId !== 'string' || !userId) {
        throw new JiraConfigurationError(
          'Jira reporter mappings must map non-empty strings.',
        );
      }
      reporterMappings.set(accountId, userId);
    }
    organisations.set(organisationId, {
      webhookSecret: secret,
      reporterMappings,
    });
  }

  const projectMappings = new Map<string, string>();
  for (const [projectKey, organisationId] of Object.entries(rawProjects)) {
    if (
      !projectKey
      || typeof organisationId !== 'string'
      || !organisations.has(organisationId)
    ) {
      throw new JiraConfigurationError(
        'Each Jira project mapping must reference a configured organisation.',
      );
    }
    projectMappings.set(projectKey, organisationId);
  }

  return { projectMappings, organisations };
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
