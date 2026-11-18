import hmac
import json
import os
from dataclasses import dataclass
from typing import Any


class DevelopmentAuthConfigurationError(Exception):
    pass


SUPPORTED_ROLES = {"requester", "support_agent", "support_lead"}


@dataclass(frozen=True)
class DevelopmentPrincipal:
    bearer_token: str
    organisation_id: str
    user_id: str
    roles: frozenset[str]
    team_ids: frozenset[str]

    def matches_token(self, token: str) -> bool:
        return hmac.compare_digest(self.bearer_token, token)

    @classmethod
    def from_environment(cls) -> "DevelopmentPrincipal | None":
        raw_config = os.environ.get("TICKET_DEV_PRINCIPAL")
        if not raw_config:
            return None

        if os.environ.get("APP_ENV") != "development":
            raise DevelopmentAuthConfigurationError(
                "TICKET_DEV_PRINCIPAL is permitted only when APP_ENV=development."
            )

        try:
            config: Any = json.loads(raw_config)
        except json.JSONDecodeError as error:
            raise DevelopmentAuthConfigurationError(
                "TICKET_DEV_PRINCIPAL must contain valid JSON."
            ) from error

        if not isinstance(config, dict):
            raise DevelopmentAuthConfigurationError("TICKET_DEV_PRINCIPAL must be a JSON object.")

        bearer_token = config.get("bearerToken")
        organisation_id = config.get("organisationId")
        user_id = config.get("userId")
        roles = config.get("roles")
        team_ids = config.get("teamIds", [])
        if not isinstance(bearer_token, str) or len(bearer_token) < 32:
            raise DevelopmentAuthConfigurationError(
                "The development bearer token must contain at least 32 characters."
            )
        if not isinstance(organisation_id, str) or not organisation_id:
            raise DevelopmentAuthConfigurationError("A development organisationId is required.")
        if not isinstance(user_id, str) or not user_id:
            raise DevelopmentAuthConfigurationError("A development userId is required.")
        if (
            not isinstance(roles, list)
            or not roles
            or any(not isinstance(role, str) or role not in SUPPORTED_ROLES for role in roles)
        ):
            raise DevelopmentAuthConfigurationError(
                "Development roles must be selected from requester, support_agent, and support_lead."
            )
        if not isinstance(team_ids, list) or any(
            not isinstance(team_id, str) or not team_id for team_id in team_ids
        ):
            raise DevelopmentAuthConfigurationError(
                "Development teamIds must be an array of non-empty strings."
            )
        if len(set(roles)) != len(roles) or len(set(team_ids)) != len(team_ids):
            raise DevelopmentAuthConfigurationError(
                "Development roles and teamIds must not contain duplicates."
            )
        unexpected_fields = set(config) - {
            "bearerToken",
            "organisationId",
            "userId",
            "roles",
            "teamIds",
        }
        if unexpected_fields:
            raise DevelopmentAuthConfigurationError(
                "TICKET_DEV_PRINCIPAL contains unsupported fields."
            )

        return cls(
            bearer_token=bearer_token,
            organisation_id=organisation_id,
            user_id=user_id,
            roles=frozenset(roles),
            team_ids=frozenset(team_ids),
        )
