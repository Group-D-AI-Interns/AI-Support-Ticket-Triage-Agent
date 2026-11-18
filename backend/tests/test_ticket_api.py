import json

import pytest
from fastapi.testclient import TestClient

from src.modules.tickets.api import create_app
from src.modules.tickets.config import JiraSettings, OrganisationJiraConfig
from src.modules.tickets.development_auth import (
    DevelopmentAuthConfigurationError,
    DevelopmentPrincipal,
)
from src.modules.tickets.store import TicketJsonStore


JIRA_SECRET = "local-test-secret-with-at-least-32-characters"
DEV_TOKEN = "local-development-token-with-at-least-32-characters"
JIRA_PATH = f"/api/v1/tickets/ingest/jira/{JIRA_SECRET}"


@pytest.fixture
def settings(tmp_path):
    return JiraSettings(
        data_directory=tmp_path,
        project_mappings={"SUP": "org_support"},
        organisations={
            "org_support": OrganisationJiraConfig(
                webhook_secret=JIRA_SECRET,
                reporter_mappings={"jira-account-1": "user_requester_1"},
            )
        },
    )


@pytest.fixture
def staff_principal():
    return DevelopmentPrincipal(
        bearer_token=DEV_TOKEN,
        organisation_id="org_support",
        user_id="user_requester_1",
        roles=frozenset({"requester", "support_lead"}),
        team_ids=frozenset({"team_support"}),
    )


@pytest.fixture
def staff_client(settings, staff_principal):
    store = TicketJsonStore(settings.data_directory)
    return TestClient(create_app(settings, store, staff_principal))


def headers(token=DEV_TOKEN):
    return {"Authorization": f"Bearer {token}"}


def jira_payload():
    return {
        "webhookEvent": "jira:issue_created",
        "issue": {
            "id": "10042",
            "key": "SUP-42",
            "fields": {
                "project": {"key": "SUP"},
                "summary": "Jira imported ticket",
                "description": "Imported from Jira",
                "reporter": {"accountId": "jira-account-1"},
                "status": {"name": "Open"},
                "priority": {"name": "High"},
            },
        },
    }


def seed_jira_ticket(client):
    response = client.post(JIRA_PATH, json=jira_payload())
    assert response.status_code == 201
    return response.json()["data"]["id"]


def test_create_ticket_derives_tenant_and_requester_from_principal(staff_client, settings):
    response = staff_client.post(
        "/api/v1/tickets",
        headers=headers(),
        json={
            "title": "Unable to sign in",
            "description": "The sign-in page returns an error.",
            "product": "Customer Portal",
            "affectedService": "Authentication",
        },
    )

    assert response.status_code == 201
    ticket = response.json()["data"]
    assert ticket["organisationId"] == "org_support"
    assert ticket["requesterId"] == "user_requester_1"
    assert ticket["status"] == "new"
    assert ticket["product"] == "Customer Portal"
    assert ticket["createdAt"] == ticket["updatedAt"]
    assert len(json.loads((settings.data_directory / "tickets.json").read_text())["records"]) == 1


def test_jira_ingestion_coexists_with_manually_created_tickets(staff_client):
    manual = staff_client.post(
        "/api/v1/tickets",
        headers=headers(),
        json={"title": "Manual ticket", "description": "Created through the API."},
    )
    imported = staff_client.post(JIRA_PATH, json=jira_payload())

    assert manual.status_code == 201
    assert imported.status_code == 201
    listed = staff_client.get("/api/v1/tickets?limit=10", headers=headers())
    assert listed.status_code == 200
    assert {ticket["title"] for ticket in listed.json()["data"]} == {
        "Manual ticket",
        "Jira imported ticket",
    }


def test_client_cannot_choose_tenant_or_unsupported_status(staff_client):
    tenant_override = staff_client.post(
        "/api/v1/tickets",
        headers=headers(),
        json={
            "title": "Tenant override",
            "description": "Must be rejected.",
            "organisationId": "org_other",
        },
    )
    unsupported_status = staff_client.patch(
        "/api/v1/tickets/ticket_unknown",
        headers=headers(),
        json={"status": "resolved"},
    )

    assert tenant_override.status_code == 400
    assert tenant_override.json()["error"]["code"] == "VALIDATION_ERROR"
    assert unsupported_status.status_code == 400
    assert unsupported_status.json()["error"]["code"] == "VALIDATION_ERROR"


def test_list_search_filter_pagination_and_detail_are_tenant_scoped(staff_client):
    ticket_id = seed_jira_ticket(staff_client)
    created = staff_client.post(
        "/api/v1/tickets",
        headers=headers(),
        json={"title": "Portal password reset", "description": "Reset link expired."},
    )
    assert created.status_code == 201

    page = staff_client.get(
        "/api/v1/tickets?q=password&status=new&limit=1&offset=0",
        headers=headers(),
    )
    detail = staff_client.get(f"/api/v1/tickets/{ticket_id}", headers=headers())
    missing = staff_client.get("/api/v1/tickets/ticket_not_here", headers=headers())

    assert page.status_code == 200
    assert page.json()["pagination"] == {"limit": 1, "offset": 0, "total": 1}
    assert page.json()["data"][0]["title"] == "Portal password reset"
    assert detail.status_code == 200
    assert detail.json()["data"]["source"]["issueKey"] == "SUP-42"
    assert "history" not in detail.json()["data"]
    assert missing.status_code == 404


def test_updates_record_history_and_enforce_team_scope(staff_client):
    ticket_id = seed_jira_ticket(staff_client)
    assigned = staff_client.patch(
        f"/api/v1/tickets/{ticket_id}",
        headers=headers(),
        json={"title": "Updated Jira title", "teamId": "team_support"},
    )
    forbidden_assignment = staff_client.patch(
        f"/api/v1/tickets/{ticket_id}",
        headers=headers(),
        json={"teamId": "team_other"},
    )
    audit = staff_client.get(
        f"/api/v1/tickets/{ticket_id}/audit",
        headers=headers(),
    )

    assert assigned.status_code == 200
    assert assigned.json()["data"]["teamId"] == "team_support"
    assert forbidden_assignment.status_code == 403
    assert forbidden_assignment.json()["error"]["code"] == "TEAM_SCOPE_FORBIDDEN"
    assert audit.status_code == 200
    assert audit.json()["data"][-1]["action"] == "ticket.updated"
    assert audit.json()["data"][-1]["actorId"] == "user_requester_1"


def test_support_agent_access_requires_assigned_team(staff_client, settings):
    ticket_id = seed_jira_ticket(staff_client)
    agent = DevelopmentPrincipal(
        bearer_token="support-agent-token-with-at-least-32-characters",
        organisation_id="org_support",
        user_id="user_agent_1",
        roles=frozenset({"support_agent"}),
        team_ids=frozenset({"team_support"}),
    )
    agent_client = TestClient(
        create_app(settings, TicketJsonStore(settings.data_directory), agent)
    )
    before_assignment = agent_client.get(
        f"/api/v1/tickets/{ticket_id}",
        headers=headers(agent.bearer_token),
    )

    assigned = staff_client.patch(
        f"/api/v1/tickets/{ticket_id}",
        headers=headers(),
        json={"teamId": "team_support"},
    )
    after_assignment = agent_client.get(
        f"/api/v1/tickets/{ticket_id}",
        headers=headers(agent.bearer_token),
    )

    assert before_assignment.status_code == 404
    assert assigned.status_code == 200
    assert after_assignment.status_code == 200


def test_comment_visibility_is_enforced_for_requesters(staff_client, settings):
    ticket_id = seed_jira_ticket(staff_client)
    internal_comment = staff_client.post(
        f"/api/v1/tickets/{ticket_id}/comments",
        headers=headers(),
        json={"body": "Staff-only note", "visibility": "internal"},
    )
    public_comment = staff_client.post(
        f"/api/v1/tickets/{ticket_id}/comments",
        headers=headers(),
        json={"body": "Customer update", "visibility": "public"},
    )
    requester = DevelopmentPrincipal(
        bearer_token="requester-token-with-at-least-32-characters",
        organisation_id="org_support",
        user_id="user_requester_1",
        roles=frozenset({"requester"}),
        team_ids=frozenset(),
    )
    requester_client = TestClient(
        create_app(settings, TicketJsonStore(settings.data_directory), requester)
    )
    visible = requester_client.get(
        f"/api/v1/tickets/{ticket_id}/comments",
        headers=headers(requester.bearer_token),
    )
    internal_attempt = requester_client.post(
        f"/api/v1/tickets/{ticket_id}/comments",
        headers=headers(requester.bearer_token),
        json={"body": "Not allowed", "visibility": "internal"},
    )

    assert internal_comment.status_code == 201
    assert public_comment.status_code == 201
    assert [comment["body"] for comment in visible.json()["data"]] == ["Customer update"]
    assert internal_attempt.status_code == 403


def test_authentication_is_required_and_dev_auth_is_environment_gated(
    staff_client,
    monkeypatch,
):
    unauthenticated = staff_client.get("/api/v1/tickets")
    assert unauthenticated.status_code == 401

    monkeypatch.setenv("TICKET_DEV_PRINCIPAL", json.dumps({
        "bearerToken": DEV_TOKEN,
        "organisationId": "org_support",
        "userId": "user_requester_1",
        "roles": ["requester"],
    }))
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(DevelopmentAuthConfigurationError):
        DevelopmentPrincipal.from_environment()


def test_ticket_api_fails_closed_when_no_identity_adapter_is_configured(
    settings,
    tmp_path,
    monkeypatch,
):
    monkeypatch.delenv("TICKET_DEV_PRINCIPAL", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)
    client = TestClient(create_app(settings, TicketJsonStore(tmp_path)))

    response = client.get("/api/v1/tickets")

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AUTHENTICATION_NOT_CONFIGURED"


def test_requester_cannot_view_staff_audit_or_other_tenant_ticket(staff_client, settings):
    ticket_id = seed_jira_ticket(staff_client)
    requester = DevelopmentPrincipal(
        bearer_token="requester-token-with-at-least-32-characters",
        organisation_id="org_support",
        user_id="user_requester_1",
        roles=frozenset({"requester"}),
        team_ids=frozenset(),
    )
    requester_client = TestClient(
        create_app(settings, TicketJsonStore(settings.data_directory), requester)
    )
    audit = requester_client.get(
        f"/api/v1/tickets/{ticket_id}/audit",
        headers=headers(requester.bearer_token),
    )
    other_tenant = DevelopmentPrincipal(
        bearer_token="other-tenant-token-with-at-least-32-characters",
        organisation_id="org_other",
        user_id="user_other",
        roles=frozenset({"requester"}),
        team_ids=frozenset(),
    )
    other_client = TestClient(
        create_app(settings, TicketJsonStore(settings.data_directory), other_tenant)
    )
    hidden = other_client.get(
        f"/api/v1/tickets/{ticket_id}",
        headers=headers(other_tenant.bearer_token),
    )

    assert audit.status_code == 403
    assert hidden.status_code == 404
