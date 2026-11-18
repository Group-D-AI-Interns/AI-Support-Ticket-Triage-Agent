import json

import pytest
from fastapi.testclient import TestClient

from src.modules.tickets.api import create_app
from src.modules.tickets.config import JiraSettings, OrganisationJiraConfig
from src.modules.tickets.store import TicketJsonStore


SECRET = "local-test-secret-with-at-least-32-characters"
WEBHOOK_PATH = f"/api/v1/tickets/ingest/jira/{SECRET}"


@pytest.fixture
def client(tmp_path):
    settings = JiraSettings(
        data_directory=tmp_path,
        project_mappings={"SUP": "org_support"},
        organisations={
            "org_support": OrganisationJiraConfig(
                webhook_secret=SECRET,
                reporter_mappings={"jira-account-1": "user_requester_1"},
            )
        },
    )
    return TestClient(create_app(settings, TicketJsonStore(tmp_path)))


def jira_payload(event="jira:issue_created", issue_id="10042", issue_key="SUP-42"):
    return {
        "webhookEvent": event,
        "issue": {
            "id": issue_id,
            "key": issue_key,
            "fields": {
                "project": {"key": "SUP"},
                "summary": "Unable to access billing portal",
                "description": {
                    "type": "doc",
                    "content": [{"type": "paragraph", "text": "Access is denied."}],
                },
                "reporter": {"accountId": "jira-account-1"},
                "status": {"name": "Open"},
                "priority": {"name": "Highest"},
            },
        },
    }


def test_ingests_jira_ticket_and_keeps_source_status_and_priority(client, tmp_path):
    payload = jira_payload()
    payload["organisationId"] = "org_attacker"
    response = client.post(WEBHOOK_PATH, json=payload)

    assert response.status_code == 201
    data = response.json()["data"]
    assert data["sourceIssueKey"] == "SUP-42"
    assert data["outcome"] == "created"
    assert response.headers["X-Request-ID"] == response.json()["requestId"]

    saved = json.loads((tmp_path / "tickets.json").read_text(encoding="utf-8"))["records"][0]
    assert saved["organisationId"] == "org_support"
    assert saved["requesterId"] == "user_requester_1"
    assert saved["source"]["status"] == "Open"
    assert saved["source"]["priority"] == "Highest"
    assert "status" not in saved
    assert "priority" not in saved


def test_repeated_delivery_is_idempotent_and_issue_updates_upsert(client, tmp_path):
    created = client.post(WEBHOOK_PATH, json=jira_payload())
    duplicate = client.post(WEBHOOK_PATH, json=jira_payload())
    updated_payload = jira_payload(event="jira:issue_updated")
    updated_payload["issue"]["fields"]["summary"] = "Billing portal access denied"
    updated_payload["issue"]["fields"]["status"] = {"name": "In Progress"}
    updated = client.post(WEBHOOK_PATH, json=updated_payload)

    assert created.status_code == 201
    assert duplicate.status_code == 200
    assert duplicate.json()["data"]["outcome"] == "duplicate"
    assert updated.status_code == 200
    assert updated.json()["data"]["outcome"] == "updated"
    assert updated.json()["data"]["id"] == created.json()["data"]["id"]

    records = json.loads((tmp_path / "tickets.json").read_text(encoding="utf-8"))["records"]
    assert len(records) == 1
    assert records[0]["title"] == "Billing portal access denied"
    assert records[0]["source"]["status"] == "In Progress"


def test_rejects_bad_secret_and_unmapped_reporter_without_writing(client, tmp_path):
    unauthorised = client.post(
        f"/api/v1/tickets/ingest/jira/{'x' * len(SECRET)}",
        json=jira_payload(),
    )
    unmapped_payload = jira_payload()
    unmapped_payload["issue"]["fields"]["reporter"]["accountId"] = "unknown-account"
    unmapped = client.post(WEBHOOK_PATH, json=unmapped_payload)

    assert unauthorised.status_code == 401
    assert unauthorised.json()["error"]["code"] == "JIRA_WEBHOOK_UNAUTHORIZED"
    assert unmapped.status_code == 403
    assert unmapped.json()["error"]["code"] == "JIRA_REPORTER_UNMAPPED"
    assert not (tmp_path / "tickets.json").exists()


def test_rejects_project_key_mismatch_and_unsupported_event(client, tmp_path):
    mismatched_payload = jira_payload(issue_key="OTHER-42")
    mismatch = client.post(WEBHOOK_PATH, json=mismatched_payload)
    unsupported_payload = jira_payload(event="jira:issue_deleted")
    unsupported = client.post(WEBHOOK_PATH, json=unsupported_payload)

    assert mismatch.status_code == 400
    assert unsupported.status_code == 400
    assert unsupported.json()["error"]["code"] == "UNSUPPORTED_JIRA_EVENT"
    assert not (tmp_path / "tickets.json").exists()


def test_malformed_ticket_file_returns_storage_error_without_resetting(client, tmp_path):
    malformed_data = '{"schemaVersion":1,"records":'
    (tmp_path / "tickets.json").write_text(malformed_data, encoding="utf-8")

    response = client.post(WEBHOOK_PATH, json=jira_payload())

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "STORAGE_ERROR"
    assert (tmp_path / "tickets.json").read_text(encoding="utf-8") == malformed_data
