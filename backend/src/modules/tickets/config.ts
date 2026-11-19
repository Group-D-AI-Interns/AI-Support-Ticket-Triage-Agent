import { resolve } from 'node:path';

export class ConfigurationError extends Error {}

export type OrganisationJiraConfig = {
  webhookSecret: string;
  reporterMappings: Record<string, string>;
};

export type JiraSettings = {
  dataDirectory: string;
  projectMappings: Record<string, string>;
  organisations: Record<string, OrganisationJiraConfig>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function jiraSettingsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): JiraSettings {
  const rawConfig = environment.JIRA_TENANT_CONFIG;
  if (!rawConfig) {
    throw new ConfigurationError('JIRA_TENANT_CONFIG is required.');
  }

  let config: unknown;
  try {
    config = JSON.parse(rawConfig);
  } catch {
    throw new ConfigurationError('JIRA_TENANT_CONFIG must contain valid JSON.');
  }
  if (!isRecord(config)) {
    throw new ConfigurationError('JIRA_TENANT_CONFIG must be a JSON object.');
  }

  const rawProjects = config.projectMappings;
  const rawOrganisations = config.organisations;
  if (!isRecord(rawProjects) || Object.keys(rawProjects).length === 0) {
    throw new ConfigurationError(
      'JIRA_TENANT_CONFIG.projectMappings must be a non-empty object.',
    );
  }
  if (!isRecord(rawOrganisations) || Object.keys(rawOrganisations).length === 0) {
    throw new ConfigurationError(
      'JIRA_TENANT_CONFIG.organisations must be a non-empty object.',
    );
  }

  const organisations: Record<string, OrganisationJiraConfig> = {};
  for (const [organisationId, rawValue] of Object.entries(rawOrganisations)) {
    if (!organisationId || !isRecord(rawValue)) {
      throw new ConfigurationError(
        'Each organisation Jira configuration must have a valid ID and object value.',
      );
    }

    const secret = rawValue.webhookSecret;
    const reporters = rawValue.reporterMappings;
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new ConfigurationError(
        'Each Jira webhook secret must contain at least 32 characters.',
      );
    }
    if (!isRecord(reporters) || Object.keys(reporters).length === 0) {
      throw new ConfigurationError(
        'Each organisation must configure a non-empty reporterMappings object.',
      );
    }

    const reporterMappings: Record<string, string> = {};
    for (const [accountId, userId] of Object.entries(reporters)) {
      if (!accountId || typeof userId !== 'string' || !userId) {
        throw new ConfigurationError(
          'Jira reporter mappings must map non-empty strings.',
        );
      }
      reporterMappings[accountId] = userId;
    }

    organisations[organisationId] = { webhookSecret: secret, reporterMappings };
  }

  const projectMappings: Record<string, string> = {};
  for (const [projectKey, organisationId] of Object.entries(rawProjects)) {
    if (
      !projectKey ||
      typeof organisationId !== 'string' ||
      !organisations[organisationId]
    ) {
      throw new ConfigurationError(
        'Each Jira project mapping must reference a configured organisation.',
      );
    }
    projectMappings[projectKey] = organisationId;
  }

  const configuredDirectory = environment.DATA_DIRECTORY || '.local-data';
  return {
    dataDirectory: resolve(process.cwd(), configuredDirectory),
    projectMappings,
    organisations,
  };
}
