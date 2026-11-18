import hmac
import math
import uuid
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, Header, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, field_validator

from .config import ConfigurationError, JiraSettings
from .development_auth import (
    DevelopmentAuthConfigurationError,
    DevelopmentPrincipal,
)
from .store import TicketConflictError, TicketJsonStore, TicketStoreError


class ApiError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        fields: list[dict[str, str]] | None = None,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        self.fields = fields or []


class JiraWebhookBody(BaseModel):
    model_config = ConfigDict(extra="allow")

    webhookEvent: str
    issue: dict[str, Any]


class TicketCreateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    description: str
    product: str | None = None
    affectedService: str | None = None

    @field_validator("title", "description")
    @classmethod
    def require_non_empty_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("This field must not be empty.")
        return value


class TicketPatchBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    description: str | None = None
    product: str | None = None
    affectedService: str | None = None
    teamId: str | None = None

    @field_validator("title", "description")
    @classmethod
    def validate_optional_text(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("This field must not be empty.")
        return value


class TicketCommentBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: str
    visibility: Literal["internal", "public"]

    @field_validator("body")
    @classmethod
    def require_non_empty_body(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Comment body must not be empty.")
        return value


def create_app(
    settings: JiraSettings | None = None,
    ticket_store: TicketJsonStore | None = None,
    development_principal: DevelopmentPrincipal | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if app.state.settings is None:
            app.state.settings = JiraSettings.from_environment()
        if app.state.ticket_store is None:
            app.state.ticket_store = TicketJsonStore(app.state.settings.data_directory)
        if app.state.development_principal is None:
            app.state.development_principal = DevelopmentPrincipal.from_environment()
        yield

    app = FastAPI(
        title="AI Support Ticket Triage Agent API",
        version="1.0.0",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.ticket_store = ticket_store
    app.state.development_principal = development_principal

    @app.middleware("http")
    async def add_request_id(request: Request, call_next):
        request.state.request_id = f"req_{uuid.uuid4().hex}"
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    @app.exception_handler(ApiError)
    async def handle_api_error(request: Request, error: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status_code,
            content={
                "error": {
                    "code": error.code,
                    "message": error.message,
                    "requestId": request.state.request_id,
                    "fields": error.fields,
                }
            },
        )

    @app.exception_handler(RequestValidationError)
    async def handle_request_validation_error(
        request: Request,
        error: RequestValidationError,
    ) -> JSONResponse:
        fields = [
            {
                "field": ".".join(str(part) for part in item["loc"] if part != "body"),
                "message": item["msg"],
            }
            for item in error.errors()
        ]
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "The request is invalid.",
                    "requestId": request.state.request_id,
                    "fields": fields,
                }
            },
        )

    @app.exception_handler(ConfigurationError)
    async def handle_configuration_error(
        request: Request,
        error: ConfigurationError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "CONFIGURATION_ERROR",
                    "message": str(error),
                    "requestId": request.state.request_id,
                    "fields": [],
                }
            },
        )

    @app.exception_handler(DevelopmentAuthConfigurationError)
    async def handle_development_auth_configuration_error(
        request: Request,
        error: DevelopmentAuthConfigurationError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "CONFIGURATION_ERROR",
                    "message": str(error),
                    "requestId": request.state.request_id,
                    "fields": [],
                }
            },
        )

    @app.exception_handler(TicketStoreError)
    async def handle_store_error(request: Request, error: TicketStoreError) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "STORAGE_ERROR",
                    "message": str(error),
                    "requestId": request.state.request_id,
                    "fields": [],
                }
            },
        )

    @app.exception_handler(TicketConflictError)
    async def handle_ticket_conflict(
        request: Request,
        error: TicketConflictError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=409,
            content={
                "error": {
                    "code": "CONFLICT",
                    "message": str(error),
                    "requestId": request.state.request_id,
                    "fields": [],
                }
            },
        )

    @app.post("/api/v1/tickets", status_code=201)
    def create_ticket(
        body: TicketCreateBody,
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        principal = _authenticated_principal(request, authorization)
        ticket_store: TicketJsonStore = request.app.state.ticket_store
        ticket = ticket_store.create_ticket(
            {
                "organisationId": principal.organisation_id,
                "requesterId": principal.user_id,
                "title": body.title.strip(),
                "description": body.description,
                "product": body.product,
                "affectedService": body.affectedService,
                "status": "new",
            },
            principal.user_id,
        )
        return JSONResponse(
            status_code=201,
            content={
                "data": _ticket_response(ticket),
                "requestId": request.state.request_id,
            },
        )

    @app.get("/api/v1/tickets")
    def list_tickets(
        request: Request,
        authorization: str | None = Header(default=None),
        q: str | None = None,
        status: str | None = None,
        priority: str | None = None,
        team_id: str | None = Query(default=None, alias="teamId"),
        requester_id: str | None = Query(default=None, alias="requesterId"),
        limit: int = Query(default=20, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ) -> JSONResponse:
        principal = _authenticated_principal(request, authorization)
        ticket_store: TicketJsonStore = request.app.state.ticket_store
        visible_tickets = [
            ticket
            for ticket in ticket_store.list_tickets(principal.organisation_id)
            if _can_access_ticket(principal, ticket)
        ]
        filtered_tickets = [
            ticket
            for ticket in visible_tickets
            if _matches_ticket_filters(
                ticket,
                q=q,
                status=status,
                priority=priority,
                team_id=team_id,
                requester_id=requester_id,
            )
        ]
        filtered_tickets.sort(
            key=lambda ticket: (ticket["createdAt"], ticket["id"]),
            reverse=True,
        )
        total = len(filtered_tickets)
        page = filtered_tickets[offset : offset + limit]
        return JSONResponse(
            content={
                "data": [_ticket_response(ticket) for ticket in page],
                "pagination": {"limit": limit, "offset": offset, "total": total},
                "requestId": request.state.request_id,
            }
        )

    @app.get("/api/v1/tickets/{ticket_id}")
    def get_ticket(
        ticket_id: str,
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        principal = _authenticated_principal(request, authorization)
        ticket = _find_accessible_ticket(request, principal, ticket_id)
        response_ticket = _ticket_response(ticket)
        response_ticket["comments"] = _visible_comments(principal, ticket)
        return JSONResponse(
            content={"data": response_ticket, "requestId": request.state.request_id}
        )

    @app.patch("/api/v1/tickets/{ticket_id}")
    def update_ticket(
        ticket_id: str,
        body: TicketPatchBody,
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        principal = _authenticated_principal(request, authorization)
        if not principal.roles.intersection({"support_agent", "support_lead"}):
            raise ApiError(403, "FORBIDDEN", "Only support staff can update tickets.")

        ticket = _find_accessible_ticket(request, principal, ticket_id)
        changes = body.model_dump(exclude_unset=True)
        if not changes:
            raise _validation_error("body", "At least one permitted field must be provided.")
        if "teamId" in changes:
            if "support_lead" not in principal.roles:
                raise ApiError(403, "FORBIDDEN", "Only a support lead can assign a ticket team.")
            if changes["teamId"] is not None and changes["teamId"] not in principal.team_ids:
                raise ApiError(
                    403,
                    "TEAM_SCOPE_FORBIDDEN",
                    "The requested team is outside the authenticated user's team scope.",
                )
        if "title" in changes and changes["title"] is not None:
            changes["title"] = changes["title"].strip()
        updated = request.app.state.ticket_store.update_ticket(
            principal.organisation_id,
            ticket["id"],
            changes,
            principal.user_id,
        )
        if updated is None:
            raise _ticket_not_found()
        return JSONResponse(
            content={"data": _ticket_response(updated), "requestId": request.state.request_id}
        )

    @app.post("/api/v1/tickets/{ticket_id}/comments", status_code=201)
    def add_ticket_comment(
        ticket_id: str,
        body: TicketCommentBody,
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        principal = _authenticated_principal(request, authorization)
        ticket = _find_accessible_ticket(request, principal, ticket_id)
        is_support_staff = bool(
            principal.roles.intersection({"support_agent", "support_lead"})
        )
        if body.visibility == "internal" and not is_support_staff:
            raise ApiError(403, "FORBIDDEN", "Requesters cannot add internal comments.")

        result = request.app.state.ticket_store.add_comment(
            principal.organisation_id,
            ticket["id"],
            {
                "authorId": principal.user_id,
                "body": body.body.strip(),
                "visibility": body.visibility,
            },
            principal.user_id,
        )
        if result is None:
            raise _ticket_not_found()
        _, comment = result
        return JSONResponse(
            status_code=201,
            content={"data": comment, "requestId": request.state.request_id},
        )

    @app.get("/api/v1/tickets/{ticket_id}/comments")
    def list_ticket_comments(
        ticket_id: str,
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        principal = _authenticated_principal(request, authorization)
        ticket = _find_accessible_ticket(request, principal, ticket_id)
        return JSONResponse(
            content={
                "data": _visible_comments(principal, ticket),
                "requestId": request.state.request_id,
            }
        )

    @app.get("/api/v1/tickets/{ticket_id}/audit")
    def get_ticket_audit(
        ticket_id: str,
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        principal = _authenticated_principal(request, authorization)
        if not principal.roles.intersection({"support_agent", "support_lead"}):
            raise ApiError(403, "FORBIDDEN", "Ticket audit is restricted to support staff.")
        ticket = _find_accessible_ticket(request, principal, ticket_id)
        return JSONResponse(
            content={
                "data": ticket.get("history", []),
                "requestId": request.state.request_id,
            }
        )

    @app.post(
        "/api/v1/tickets/ingest/jira/{webhook_secret}",
        responses={
            200: {"description": "Existing Jira ticket updated or duplicate delivery ignored."},
            201: {"description": "Jira ticket ingested."},
            400: {"description": "Invalid or unsupported Jira webhook."},
            401: {"description": "Jira webhook authentication failed."},
            403: {"description": "Jira reporter has no configured internal user mapping."},
            409: {"description": "Jira issue key conflicts with an existing issue."},
        },
    )
    def ingest_jira_ticket(
        webhook_secret: str,
        body: JiraWebhookBody,
        request: Request,
    ) -> JSONResponse:
        settings: JiraSettings = request.app.state.settings
        ticket_store: TicketJsonStore = request.app.state.ticket_store
        issue = body.issue
        fields = issue.get("fields")
        project = fields.get("project") if isinstance(fields, dict) else None
        project_key = project.get("key") if isinstance(project, dict) else None
        if not isinstance(project_key, str) or not project_key:
            raise _validation_error("issue.fields.project.key", "Project key is required.")

        organisation_id = settings.project_mappings.get(project_key)
        if organisation_id is None:
            raise _unauthorized()

        organisation_config = settings.organisations[organisation_id]
        if not hmac.compare_digest(webhook_secret, organisation_config.webhook_secret):
            raise _unauthorized()

        ticket = _map_jira_issue(
            body.webhookEvent,
            issue,
            fields,
            project_key,
            organisation_id,
            organisation_config.reporter_mappings,
        )
        stored_ticket, outcome = ticket_store.upsert_jira_ticket(ticket)
        result = {
            "data": {
                "id": stored_ticket["id"],
                "sourceIssueKey": stored_ticket["source"]["issueKey"],
                "outcome": outcome,
                "createdAt": stored_ticket["createdAt"],
                "updatedAt": stored_ticket["updatedAt"],
            },
            "requestId": request.state.request_id,
        }
        return JSONResponse(
            status_code=201 if outcome == "created" else 200,
            content=jsonable_encoder(result),
        )

    return app


def _map_jira_issue(
    webhook_event: str,
    issue: dict[str, Any],
    fields: Any,
    project_key: str,
    organisation_id: str,
    reporter_mappings: dict[str, str],
) -> dict[str, Any]:
    if webhook_event not in {"jira:issue_created", "jira:issue_updated"}:
        raise ApiError(
            400,
            "UNSUPPORTED_JIRA_EVENT",
            "Only Jira issue-created and issue-updated events are supported.",
        )
    if not isinstance(fields, dict):
        raise _validation_error("issue.fields", "Issue fields are required.")

    issue_id = issue.get("id")
    issue_key = issue.get("key")
    if not isinstance(issue_id, str) or not issue_id:
        raise _validation_error("issue.id", "Jira issue ID is required.")
    if (
        not isinstance(issue_key, str)
        or not issue_key.startswith(f"{project_key}-")
        or not issue_key[len(project_key) + 1 :].isdigit()
    ):
        raise _validation_error("issue.key", "Issue key must match the configured Jira project.")

    reporter = fields.get("reporter")
    account_id = reporter.get("accountId") if isinstance(reporter, dict) else None
    if not isinstance(account_id, str) or not account_id:
        raise _validation_error(
            "issue.fields.reporter.accountId",
            "Jira reporter account ID is required.",
        )
    requester_id = reporter_mappings.get(account_id)
    if requester_id is None:
        raise ApiError(
            403,
            "JIRA_REPORTER_UNMAPPED",
            "The Jira reporter has no configured internal user mapping.",
        )

    title = fields.get("summary")
    if not isinstance(title, str) or not title.strip():
        raise _validation_error("issue.fields.summary", "Issue summary is required.")
    description = fields.get("description")
    if description is not None and not _is_json_value(description):
        raise _validation_error("issue.fields.description", "Description must be JSON-compatible.")

    return {
        "organisationId": organisation_id,
        "requesterId": requester_id,
        "title": title,
        "description": description,
        "source": {
            "system": "jira",
            "issueId": issue_id,
            "issueKey": issue_key,
            "projectKey": project_key,
            "status": _optional_name(fields, "status"),
            "priority": _optional_name(fields, "priority"),
        },
    }


def _authenticated_principal(
    request: Request,
    authorization: str | None,
) -> DevelopmentPrincipal:
    principal: DevelopmentPrincipal | None = request.app.state.development_principal
    if principal is None:
        raise ApiError(
            503,
            "AUTHENTICATION_NOT_CONFIGURED",
            "Ticket API authentication is unavailable until an approved identity provider is configured.",
        )
    if authorization is None:
        raise ApiError(401, "UNAUTHENTICATED", "A bearer token is required.")
    scheme, separator, token = authorization.partition(" ")
    if (
        not separator
        or scheme.lower() != "bearer"
        or not token
        or not principal.matches_token(token)
    ):
        raise ApiError(401, "UNAUTHENTICATED", "The bearer token is invalid.")
    return principal


def _can_access_ticket(principal: DevelopmentPrincipal, ticket: dict[str, Any]) -> bool:
    if ticket["organisationId"] != principal.organisation_id:
        return False
    if (
        "requester" in principal.roles
        and ticket.get("requesterId") == principal.user_id
    ):
        return True

    ticket_team = ticket.get("teamId")
    if "support_lead" in principal.roles and ticket_team is None:
        return True
    return (
        bool(principal.roles.intersection({"support_agent", "support_lead"}))
        and ticket_team in principal.team_ids
    )


def _find_accessible_ticket(
    request: Request,
    principal: DevelopmentPrincipal,
    ticket_id: str,
) -> dict[str, Any]:
    ticket = request.app.state.ticket_store.find_ticket(
        principal.organisation_id,
        ticket_id,
    )
    if ticket is None or not _can_access_ticket(principal, ticket):
        raise _ticket_not_found()
    return ticket


def _visible_comments(
    principal: DevelopmentPrincipal,
    ticket: dict[str, Any],
) -> list[dict[str, Any]]:
    comments = ticket.get("comments", [])
    if principal.roles.intersection({"support_agent", "support_lead"}):
        return comments
    return [comment for comment in comments if comment["visibility"] == "public"]


def _matches_ticket_filters(
    ticket: dict[str, Any],
    *,
    q: str | None,
    status: str | None,
    priority: str | None,
    team_id: str | None,
    requester_id: str | None,
) -> bool:
    source = ticket.get("source", {})
    effective_status = ticket.get("status", source.get("status"))
    effective_priority = ticket.get("priority", source.get("priority"))
    if status is not None and (
        not isinstance(effective_status, str)
        or effective_status.casefold() != status.casefold()
    ):
        return False
    if priority is not None and (
        not isinstance(effective_priority, str)
        or effective_priority.casefold() != priority.casefold()
    ):
        return False
    if team_id is not None and ticket.get("teamId") != team_id:
        return False
    if requester_id is not None and ticket.get("requesterId") != requester_id:
        return False
    if q is not None:
        search_text = " ".join(
            str(ticket.get(field, ""))
            for field in ("title", "description", "product", "affectedService")
        )
        if q.casefold() not in search_text.casefold():
            return False
    return True


def _ticket_response(ticket: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in ticket.items()
        if key not in {"comments", "history"}
    }


def _ticket_not_found() -> ApiError:
    return ApiError(404, "NOT_FOUND", "Ticket not found.")


def _optional_name(fields: dict[str, Any], field: str) -> str | None:
    value = fields.get(field)
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("name"), str):
        raise _validation_error(f"issue.fields.{field}", f"{field.title()} must contain a name.")
    return value["name"]


def _is_json_value(value: Any) -> bool:
    if value is None or isinstance(value, (str, int, bool)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_json_value(item) for key, item in value.items())
    return False


def _validation_error(field: str, message: str) -> ApiError:
    return ApiError(
        400,
        "VALIDATION_ERROR",
        "The request is invalid.",
        [{"field": field, "message": message}],
    )


def _unauthorized() -> ApiError:
    return ApiError(
        401,
        "JIRA_WEBHOOK_UNAUTHORIZED",
        "Jira webhook authentication failed.",
    )
