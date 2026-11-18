import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ConfigurationError(Exception):
    pass


@dataclass(frozen=True)
class OrganisationJiraConfig:
    webhook_secret: str
    reporter_mappings: dict[str, str]


@dataclass(frozen=True)
class JiraSettings:
    data_directory: Path
    project_mappings: dict[str, str]
    organisations: dict[str, OrganisationJiraConfig]

    @classmethod
    def from_environment(cls) -> "JiraSettings":
        raw_config = os.environ.get("JIRA_TENANT_CONFIG")
        if not raw_config:
            raise ConfigurationError("JIRA_TENANT_CONFIG is required.")

        try:
            config: Any = json.loads(raw_config)
        except json.JSONDecodeError as error:
            raise ConfigurationError("JIRA_TENANT_CONFIG must contain valid JSON.") from error

        if not isinstance(config, dict):
            raise ConfigurationError("JIRA_TENANT_CONFIG must be a JSON object.")

        project_mappings = config.get("projectMappings")
        organisation_configs = config.get("organisations")
        if not isinstance(project_mappings, dict) or not project_mappings:
            raise ConfigurationError("JIRA_TENANT_CONFIG.projectMappings must be a non-empty object.")
        if not isinstance(organisation_configs, dict) or not organisation_configs:
            raise ConfigurationError("JIRA_TENANT_CONFIG.organisations must be a non-empty object.")

        organisations: dict[str, OrganisationJiraConfig] = {}
        for organisation_id, value in organisation_configs.items():
            if not isinstance(organisation_id, str) or not organisation_id:
                raise ConfigurationError("JIRA_TENANT_CONFIG contains an invalid organisation ID.")
            if not isinstance(value, dict):
                raise ConfigurationError("Each organisation Jira configuration must be an object.")

            secret = value.get("webhookSecret")
            reporter_mappings = value.get("reporterMappings")
            if not isinstance(secret, str) or len(secret) < 32:
                raise ConfigurationError(
                    "Each Jira webhook secret must contain at least 32 characters."
                )
            if not isinstance(reporter_mappings, dict) or not reporter_mappings:
                raise ConfigurationError(
                    "Each organisation must configure a non-empty reporterMappings object."
                )
            if any(
                not isinstance(account_id, str)
                or not account_id
                or not isinstance(user_id, str)
                or not user_id
                for account_id, user_id in reporter_mappings.items()
            ):
                raise ConfigurationError("Jira reporter mappings must map non-empty strings.")

            organisations[organisation_id] = OrganisationJiraConfig(
                webhook_secret=secret,
                reporter_mappings=reporter_mappings,
            )

        validated_projects: dict[str, str] = {}
        for project_key, organisation_id in project_mappings.items():
            if (
                not isinstance(project_key, str)
                or not project_key
                or not isinstance(organisation_id, str)
                or organisation_id not in organisations
            ):
                raise ConfigurationError(
                    "Each Jira project mapping must reference a configured organisation."
                )
            validated_projects[project_key] = organisation_id

        backend_directory = Path(__file__).resolve().parents[3]
        configured_data_directory = os.environ.get("DATA_DIRECTORY", ".local-data")
        data_directory = Path(configured_data_directory)
        if not data_directory.is_absolute():
            data_directory = backend_directory / data_directory

        return cls(
            data_directory=data_directory,
            project_mappings=validated_projects,
            organisations=organisations,
        )
