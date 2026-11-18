import json
import math
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

import portalocker


class TicketStoreError(Exception):
    pass


class TicketConflictError(Exception):
    pass


class TicketJsonStore:
    def __init__(self, data_directory: Path) -> None:
        self._data_directory = data_directory
        self._tickets_path = data_directory / "tickets.json"
        self._lock_path = data_directory / "tickets.lock"

    def upsert_jira_ticket(self, ticket: dict[str, Any]) -> tuple[dict[str, Any], str]:
        try:
            self._data_directory.mkdir(parents=True, exist_ok=True)
            with portalocker.Lock(str(self._lock_path), mode="a+", timeout=10):
                records = self._read_records()
                existing = next(
                    (
                        record
                        for record in records
                        if record["organisationId"] == ticket["organisationId"]
                        and record.get("source", {}).get("system") == "jira"
                        and record.get("source", {}).get("issueId")
                        == ticket["source"]["issueId"]
                    ),
                    None,
                )

                issue_key_collision = any(
                    record["organisationId"] == ticket["organisationId"]
                    and record.get("source", {}).get("system") == "jira"
                    and record.get("source", {}).get("issueKey")
                    == ticket["source"]["issueKey"]
                    and record.get("source", {}).get("issueId")
                    != ticket["source"]["issueId"]
                    for record in records
                )
                if issue_key_collision:
                    raise TicketConflictError("A different Jira issue already uses this issue key.")

                now = _utc_timestamp()
                if existing is not None:
                    if all(existing.get(key) == value for key, value in ticket.items()):
                        return existing, "duplicate"

                    changed_values = {
                        key: {"before": existing.get(key), "after": value}
                        for key, value in ticket.items()
                        if existing.get(key) != value
                    }
                    updated = {
                        **existing,
                        **ticket,
                        "updatedAt": now,
                    }
                    updated.setdefault("comments", [])
                    updated.setdefault("history", [])
                    _append_history(
                        updated,
                        "jira.issue_updated",
                        "jira_webhook",
                        changed_values,
                    )
                    records[records.index(existing)] = updated
                    self._write_records(records)
                    return updated, "updated"

                created = {
                    "id": f"ticket_{uuid4().hex}",
                    **ticket,
                    "createdAt": now,
                    "updatedAt": now,
                    "comments": [],
                    "history": [],
                }
                _append_history(created, "jira.issue_created", "jira_webhook", {})
                records.append(created)
                self._write_records(records)
                return created, "created"
        except TicketConflictError:
            raise
        except (OSError, portalocker.exceptions.LockException) as error:
            raise TicketStoreError("Ticket storage could not be accessed.") from error

    def list_tickets(self, organisation_id: str) -> list[dict[str, Any]]:
        return [
            record
            for record in self._read_records_safely()
            if record["organisationId"] == organisation_id
        ]

    def find_ticket(self, organisation_id: str, ticket_id: str) -> dict[str, Any] | None:
        return next(
            (
                record
                for record in self._read_records_safely()
                if record["organisationId"] == organisation_id and record["id"] == ticket_id
            ),
            None,
        )

    def create_ticket(self, ticket: dict[str, Any], actor_id: str) -> dict[str, Any]:
        try:
            self._data_directory.mkdir(parents=True, exist_ok=True)
            with portalocker.Lock(str(self._lock_path), mode="a+", timeout=10):
                records = self._read_records()
                now = _utc_timestamp()
                created = {
                    "id": f"ticket_{uuid4().hex}",
                    **ticket,
                    "createdAt": now,
                    "updatedAt": now,
                    "comments": [],
                    "history": [],
                }
                _append_history(created, "ticket.created", actor_id, {})
                records.append(created)
                self._write_records(records)
                return created
        except (OSError, portalocker.exceptions.LockException) as error:
            raise TicketStoreError("Ticket storage could not be accessed.") from error

    def update_ticket(
        self,
        organisation_id: str,
        ticket_id: str,
        changes: dict[str, Any],
        actor_id: str,
    ) -> dict[str, Any] | None:
        try:
            self._data_directory.mkdir(parents=True, exist_ok=True)
            with portalocker.Lock(str(self._lock_path), mode="a+", timeout=10):
                records = self._read_records()
                ticket = next(
                    (
                        record
                        for record in records
                        if record["organisationId"] == organisation_id and record["id"] == ticket_id
                    ),
                    None,
                )
                if ticket is None:
                    return None

                changed_values = {
                    key: {"before": ticket.get(key), "after": value}
                    for key, value in changes.items()
                    if ticket.get(key) != value
                }
                if not changed_values:
                    return ticket

                updated = {**ticket, **changes, "updatedAt": _utc_timestamp()}
                updated.setdefault("comments", [])
                updated.setdefault("history", [])
                _append_history(updated, "ticket.updated", actor_id, changed_values)
                records[records.index(ticket)] = updated
                self._write_records(records)
                return updated
        except (OSError, portalocker.exceptions.LockException) as error:
            raise TicketStoreError("Ticket storage could not be accessed.") from error

    def add_comment(
        self,
        organisation_id: str,
        ticket_id: str,
        comment: dict[str, Any],
        actor_id: str,
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        try:
            self._data_directory.mkdir(parents=True, exist_ok=True)
            with portalocker.Lock(str(self._lock_path), mode="a+", timeout=10):
                records = self._read_records()
                ticket = next(
                    (
                        record
                        for record in records
                        if record["organisationId"] == organisation_id and record["id"] == ticket_id
                    ),
                    None,
                )
                if ticket is None:
                    return None

                now = _utc_timestamp()
                stored_comment = {
                    "id": f"comment_{uuid4().hex}",
                    **comment,
                    "createdAt": now,
                }
                updated = {
                    **ticket,
                    "updatedAt": now,
                    "comments": [*ticket.get("comments", []), stored_comment],
                    "history": list(ticket.get("history", [])),
                }
                _append_history(
                    updated,
                    "ticket.comment_added",
                    actor_id,
                    {"commentId": stored_comment["id"], "visibility": comment["visibility"]},
                )
                records[records.index(ticket)] = updated
                self._write_records(records)
                return updated, stored_comment
        except (OSError, portalocker.exceptions.LockException) as error:
            raise TicketStoreError("Ticket storage could not be accessed.") from error

    def _read_records_safely(self) -> list[dict[str, Any]]:
        try:
            if not self._tickets_path.exists():
                return []
            with portalocker.Lock(str(self._lock_path), mode="a+", timeout=10):
                return self._read_records()
        except (OSError, portalocker.exceptions.LockException) as error:
            raise TicketStoreError("Ticket storage could not be accessed.") from error

    def _read_records(self) -> list[dict[str, Any]]:
        if not self._tickets_path.exists():
            return []

        try:
            with self._tickets_path.open("r", encoding="utf-8") as file:
                document = json.load(file)
        except (OSError, json.JSONDecodeError) as error:
            raise TicketStoreError("Ticket storage could not be read as valid JSON.") from error

        if (
            not isinstance(document, dict)
            or document.get("schemaVersion") != 1
            or not isinstance(document.get("records"), list)
        ):
            raise TicketStoreError("Ticket storage does not match the supported schema.")

        records = document["records"]
        if any(not _is_ticket_record(record) for record in records):
            raise TicketStoreError("Ticket storage contains an invalid ticket record.")
        return records

    def _write_records(self, records: list[dict[str, Any]]) -> None:
        temporary_path = self._tickets_path.with_name(
            f"{self._tickets_path.name}.{uuid4().hex}.tmp"
        )
        try:
            with temporary_path.open("w", encoding="utf-8") as file:
                json.dump(
                    {"schemaVersion": 1, "records": records},
                    file,
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary_path, self._tickets_path)
        except (OSError, TypeError, ValueError) as error:
            if temporary_path.exists():
                temporary_path.unlink()
            raise TicketStoreError("Ticket storage could not be written safely.") from error


def _is_ticket_record(record: Any) -> bool:
    if not isinstance(record, dict):
        return False
    if not all(
        isinstance(record.get(field), str) and record[field]
        for field in ("id", "organisationId", "requesterId", "title", "createdAt", "updatedAt")
    ):
        return False

    if "source" in record:
        source = record.get("source")
        if not (
            isinstance(source, dict)
            and source.get("system") == "jira"
            and isinstance(source.get("issueId"), str)
            and bool(source["issueId"])
            and isinstance(source.get("issueKey"), str)
            and bool(source["issueKey"])
            and isinstance(source.get("projectKey"), str)
            and bool(source["projectKey"])
        ):
            return False

    if record.get("description") is not None and not _is_json_value(record["description"]):
        return False
    if record.get("teamId") is not None and not isinstance(record["teamId"], str):
        return False
    if record.get("comments") is not None and not _is_valid_comments(record["comments"]):
        return False
    if record.get("history") is not None and not _is_valid_history(record["history"]):
        return False
    return all(
        record.get(field) is None or isinstance(record[field], str)
        for field in ("status", "product", "affectedService")
    )


def _is_valid_comments(comments: Any) -> bool:
    if not isinstance(comments, list):
        return False
    return all(
        isinstance(comment, dict)
        and all(
            isinstance(comment.get(field), str) and bool(comment[field])
            for field in ("id", "authorId", "body", "visibility", "createdAt")
        )
        and comment["visibility"] in {"internal", "public"}
        for comment in comments
    )


def _is_valid_history(history: Any) -> bool:
    if not isinstance(history, list):
        return False
    return all(
        isinstance(event, dict)
        and all(
            isinstance(event.get(field), str) and bool(event[field])
            for field in ("id", "action", "actorId", "createdAt")
        )
        and _is_json_value(event.get("changes", {}))
        for event in history
    )


def _append_history(
    ticket: dict[str, Any],
    action: str,
    actor_id: str,
    changes: dict[str, Any],
) -> None:
    ticket.setdefault("history", []).append(
        {
            "id": f"history_{uuid4().hex}",
            "action": action,
            "actorId": actor_id,
            "createdAt": _utc_timestamp(),
            "changes": changes,
        }
    )


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


def _utc_timestamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
