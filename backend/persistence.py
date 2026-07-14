from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


DEFAULT_CANVAS_STATE = {"components": [], "wires": [], "junctions": []}


class StoreError(RuntimeError):
    """Base error for persistence operations."""


class NotFoundError(StoreError):
    pass


class RevisionConflictError(StoreError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_for_storage(value: Any) -> Any:
    """Remove inline data URLs before durable persistence.

    Image bytes belong in the asset store. This guard is deliberately applied at
    the persistence boundary so a caller cannot accidentally put base64 payloads
    into message/event history.
    """

    if isinstance(value, str):
        if value.startswith("data:") and ";base64," in value[:128]:
            return "[omitted:data-url]"
        return value
    if isinstance(value, list):
        return [sanitize_for_storage(item) for item in value]
    if isinstance(value, dict):
        return {str(key): sanitize_for_storage(item) for key, item in value.items()}
    return value


def _json_dump(value: Any) -> str:
    return json.dumps(sanitize_for_storage(value), ensure_ascii=False, separators=(",", ":"))


def _json_load(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


class ConversationStore:
    """Small thread-safe SQLite repository for local demo state.

    Each method opens its own connection. This works with ThreadingHTTPServer and
    avoids sharing sqlite connection objects across request threads.
    """

    def __init__(self, database_path: str | os.PathLike[str], asset_dir: str | os.PathLike[str] | None = None):
        self.database_path = str(database_path)
        self.asset_dir = Path(asset_dir or Path(self.database_path).with_suffix(".assets"))
        self._init_lock = threading.Lock()
        self._initialized = False
        self.initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        with self._init_lock:
            if self._initialized:
                return
            Path(self.database_path).parent.mkdir(parents=True, exist_ok=True)
            self.asset_dir.mkdir(parents=True, exist_ok=True)
            with self._connection() as connection:
                connection.executescript(
                    """
                    PRAGMA journal_mode = WAL;
                    CREATE TABLE IF NOT EXISTS conversations (
                        id TEXT PRIMARY KEY,
                        title TEXT NOT NULL,
                        provider TEXT NOT NULL,
                        model TEXT NOT NULL,
                        reasoning_mode TEXT NOT NULL DEFAULT 'auto',
                        previous_response_id TEXT,
                        summary TEXT NOT NULL DEFAULT '',
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS canvas_snapshots (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                        revision INTEGER NOT NULL,
                        state_json TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        UNIQUE(conversation_id, revision)
                    );
                    CREATE INDEX IF NOT EXISTS idx_canvas_conversation_revision
                        ON canvas_snapshots(conversation_id, revision DESC);
                    CREATE TABLE IF NOT EXISTS turns (
                        id TEXT PRIMARY KEY,
                        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                        status TEXT NOT NULL,
                        provider TEXT NOT NULL,
                        model TEXT NOT NULL,
                        protocol TEXT NOT NULL DEFAULT 'pending',
                        previous_response_id TEXT,
                        clear_allowed INTEGER NOT NULL DEFAULT 0,
                        tool_count INTEGER NOT NULL DEFAULT 0,
                        usage_json TEXT NOT NULL DEFAULT '{}',
                        reasoning_summary TEXT NOT NULL DEFAULT '',
                        stop_reason TEXT,
                        error TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_turns_conversation_created
                        ON turns(conversation_id, created_at DESC);
                    CREATE TABLE IF NOT EXISTS events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                        turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
                        type TEXT NOT NULL,
                        role TEXT,
                        data_json TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_events_conversation_id
                        ON events(conversation_id, id);
                    CREATE INDEX IF NOT EXISTS idx_events_turn_id
                        ON events(turn_id, id);
                    CREATE TABLE IF NOT EXISTS assets (
                        id TEXT PRIMARY KEY,
                        conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
                        sha256 TEXT NOT NULL,
                        filename TEXT NOT NULL,
                        mime_type TEXT NOT NULL,
                        byte_size INTEGER NOT NULL,
                        storage_path TEXT NOT NULL,
                        provider TEXT,
                        provider_model TEXT,
                        provider_file_id TEXT,
                        status TEXT NOT NULL DEFAULT 'local',
                        expires_at TEXT,
                        created_at TEXT NOT NULL,
                        UNIQUE(conversation_id, sha256)
                    );
                    """
                )
                asset_columns = {
                    row["name"] for row in connection.execute("PRAGMA table_info(assets)").fetchall()
                }
                if "provider_model" not in asset_columns:
                    connection.execute("ALTER TABLE assets ADD COLUMN provider_model TEXT")
            self._initialized = True

    def create_conversation(
        self,
        *,
        title: str = "新建电路",
        provider: str = "bailian",
        model: str = "",
        reasoning_mode: str = "auto",
        conversation_id: str | None = None,
        canvas_state: Any | None = None,
    ) -> dict[str, Any]:
        identifier = conversation_id or f"conv_{uuid.uuid4().hex}"
        now = utc_now()
        state = canvas_state if canvas_state is not None else DEFAULT_CANVAS_STATE
        with self._connection() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    """INSERT INTO conversations
                       (id, title, provider, model, reasoning_mode, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (identifier, title.strip() or "新建电路", provider, model, reasoning_mode, now, now),
                )
                connection.execute(
                    """INSERT INTO canvas_snapshots
                       (conversation_id, revision, state_json, created_at) VALUES (?, 0, ?, ?)""",
                    (identifier, _json_dump(state), now),
                )
                connection.commit()
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise StoreError(f"conversation already exists: {identifier}") from error
        return self.get_conversation(identifier)

    def list_conversations(self) -> list[dict[str, Any]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM conversations ORDER BY updated_at DESC, created_at DESC"
            ).fetchall()
            return [self._conversation_from_row(connection, row) for row in rows]

    def get_conversation(self, conversation_id: str) -> dict[str, Any]:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"conversation not found: {conversation_id}")
            return self._conversation_from_row(connection, row)

    def _conversation_from_row(self, connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        canvas = connection.execute(
            """SELECT revision, state_json FROM canvas_snapshots
               WHERE conversation_id = ? ORDER BY revision DESC LIMIT 1""",
            (row["id"],),
        ).fetchone()
        return {
            "id": row["id"],
            "title": row["title"],
            "provider": row["provider"],
            "model": row["model"],
            "reasoning_mode": row["reasoning_mode"],
            "canvas_revision": int(canvas["revision"]) if canvas else 0,
            "canvas_state": _json_load(canvas["state_json"], DEFAULT_CANVAS_STATE) if canvas else DEFAULT_CANVAS_STATE,
            "previous_response_id": row["previous_response_id"],
            "summary": row["summary"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def update_conversation(self, conversation_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        allowed = ("title", "provider", "model", "reasoning_mode", "previous_response_id", "summary")
        updates = {key: changes[key] for key in allowed if key in changes}
        if not updates:
            return self.get_conversation(conversation_id)
        updates["updated_at"] = utc_now()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with self._connection() as connection:
            cursor = connection.execute(
                f"UPDATE conversations SET {assignments} WHERE id = ?",  # columns are allow-listed above
                (*updates.values(), conversation_id),
            )
            if cursor.rowcount == 0:
                raise NotFoundError(f"conversation not found: {conversation_id}")
        return self.get_conversation(conversation_id)

    def delete_conversation(self, conversation_id: str) -> None:
        asset_paths: list[str] = []
        with self._connection() as connection:
            asset_paths = [
                row["storage_path"]
                for row in connection.execute(
                    "SELECT storage_path FROM assets WHERE conversation_id = ?", (conversation_id,)
                ).fetchall()
            ]
            cursor = connection.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
            if cursor.rowcount == 0:
                raise NotFoundError(f"conversation not found: {conversation_id}")
        for raw_path in asset_paths:
            try:
                Path(raw_path).unlink(missing_ok=True)
            except OSError:
                pass

    def put_canvas(
        self,
        conversation_id: str,
        canvas_state: Any,
        *,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        now = utc_now()
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            exists = connection.execute(
                "SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
            if exists is None:
                connection.rollback()
                raise NotFoundError(f"conversation not found: {conversation_id}")
            current_row = connection.execute(
                "SELECT COALESCE(MAX(revision), 0) AS revision FROM canvas_snapshots WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
            current_revision = int(current_row["revision"])
            if expected_revision is not None and expected_revision != current_revision:
                connection.rollback()
                raise RevisionConflictError(
                    f"canvas revision conflict: expected {expected_revision}, current {current_revision}"
                )
            next_revision = current_revision + 1
            connection.execute(
                """INSERT INTO canvas_snapshots
                   (conversation_id, revision, state_json, created_at) VALUES (?, ?, ?, ?)""",
                (conversation_id, next_revision, _json_dump(canvas_state), now),
            )
            connection.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id)
            )
            connection.commit()
        return {"conversation_id": conversation_id, "canvas_revision": next_revision, "canvas_state": sanitize_for_storage(canvas_state)}

    def create_turn(
        self,
        conversation_id: str,
        *,
        provider: str,
        model: str,
        clear_allowed: bool,
        protocol: str = "pending",
        turn_id: str | None = None,
    ) -> dict[str, Any]:
        self.get_conversation(conversation_id)
        identifier = turn_id or f"turn_{uuid.uuid4().hex}"
        now = utc_now()
        with self._connection() as connection:
            connection.execute(
                """INSERT INTO turns
                   (id, conversation_id, status, provider, model, protocol, clear_allowed, created_at, updated_at)
                   VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)""",
                (identifier, conversation_id, provider, model, protocol, int(clear_allowed), now, now),
            )
        return self.get_turn(identifier)

    def get_turn(self, turn_id: str) -> dict[str, Any]:
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM turns WHERE id = ?", (turn_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"turn not found: {turn_id}")
            return self._turn_from_row(row)

    def _turn_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "turn_id": row["id"],
            "conversation_id": row["conversation_id"],
            "status": row["status"],
            "provider": row["provider"],
            "model": row["model"],
            "protocol": row["protocol"],
            "previous_response_id": row["previous_response_id"],
            "clear_allowed": bool(row["clear_allowed"]),
            "tool_count": int(row["tool_count"]),
            "usage": _json_load(row["usage_json"], {}),
            "reasoning_summary": row["reasoning_summary"],
            "stop_reason": row["stop_reason"],
            "error": row["error"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def update_turn(self, turn_id: str, **changes: Any) -> dict[str, Any]:
        allowed = {
            "status",
            "protocol",
            "previous_response_id",
            "tool_count",
            "reasoning_summary",
            "stop_reason",
            "error",
        }
        updates = {key: value for key, value in changes.items() if key in allowed}
        if "usage" in changes:
            updates["usage_json"] = _json_dump(changes["usage"])
        if not updates:
            return self.get_turn(turn_id)
        updates["updated_at"] = utc_now()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with self._connection() as connection:
            cursor = connection.execute(
                f"UPDATE turns SET {assignments} WHERE id = ?",  # columns are allow-listed above
                (*updates.values(), turn_id),
            )
            if cursor.rowcount == 0:
                raise NotFoundError(f"turn not found: {turn_id}")
        return self.get_turn(turn_id)

    def cancel_turn(self, turn_id: str, reason: str = "user_stopped") -> dict[str, Any]:
        with self._connection() as connection:
            row = connection.execute("SELECT status FROM turns WHERE id = ?", (turn_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"turn not found: {turn_id}")
            if row["status"] in {"running", "pending"}:
                connection.execute(
                    "UPDATE turns SET status = 'stopped', stop_reason = ?, updated_at = ? WHERE id = ?",
                    (reason, utc_now(), turn_id),
                )
        return self.get_turn(turn_id)

    def append_event(
        self,
        conversation_id: str,
        event_type: str,
        data: Any,
        *,
        turn_id: str | None = None,
        role: str | None = None,
    ) -> dict[str, Any]:
        now = utc_now()
        with self._connection() as connection:
            cursor = connection.execute(
                """INSERT INTO events (conversation_id, turn_id, type, role, data_json, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (conversation_id, turn_id, event_type, role, _json_dump(data), now),
            )
            event_id = int(cursor.lastrowid)
        return {
            "id": event_id,
            "conversation_id": conversation_id,
            "turn_id": turn_id,
            "type": event_type,
            "role": role,
            "data": sanitize_for_storage(data),
            "created_at": now,
        }

    def list_events(
        self,
        conversation_id: str,
        *,
        turn_id: str | None = None,
        after_id: int = 0,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        self.get_conversation(conversation_id)
        clauses = ["conversation_id = ?", "id > ?"]
        params: list[Any] = [conversation_id, max(0, after_id)]
        if turn_id is not None:
            clauses.append("turn_id = ?")
            params.append(turn_id)
        params.append(max(1, min(limit, 1000)))
        with self._connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM events WHERE {' AND '.join(clauses)} ORDER BY id ASC LIMIT ?",
                params,
            ).fetchall()
        return [
            {
                "id": int(row["id"]),
                "conversation_id": row["conversation_id"],
                "turn_id": row["turn_id"],
                "type": row["type"],
                "role": row["role"],
                "data": _json_load(row["data_json"], {}),
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def save_asset(
        self,
        data: bytes,
        *,
        filename: str,
        mime_type: str,
        conversation_id: str | None = None,
    ) -> dict[str, Any]:
        if conversation_id is not None:
            self.get_conversation(conversation_id)
        digest = hashlib.sha256(data).hexdigest()
        with self._connection() as connection:
            if conversation_id is None:
                existing = connection.execute(
                    "SELECT * FROM assets WHERE conversation_id IS NULL AND sha256 = ? LIMIT 1", (digest,)
                ).fetchone()
            else:
                existing = connection.execute(
                    "SELECT * FROM assets WHERE conversation_id = ? AND sha256 = ? LIMIT 1",
                    (conversation_id, digest),
                ).fetchone()
            if existing is not None:
                return self._asset_from_row(existing)

        identifier = f"asset_{uuid.uuid4().hex}"
        suffix = Path(filename).suffix.lower()[:12]
        storage_path = self.asset_dir / f"{identifier}{suffix}"
        temporary_path = storage_path.with_suffix(storage_path.suffix + ".tmp")
        temporary_path.write_bytes(data)
        os.replace(temporary_path, storage_path)
        now = utc_now()
        with self._connection() as connection:
            connection.execute(
                """INSERT INTO assets
                   (id, conversation_id, sha256, filename, mime_type, byte_size, storage_path, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (identifier, conversation_id, digest, Path(filename).name, mime_type, len(data), str(storage_path), now),
            )
            row = connection.execute("SELECT * FROM assets WHERE id = ?", (identifier,)).fetchone()
        assert row is not None
        return self._asset_from_row(row)

    def get_asset(self, asset_id: str, *, include_storage_path: bool = False) -> dict[str, Any]:
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"asset not found: {asset_id}")
            asset = self._asset_from_row(row)
            if include_storage_path:
                asset["storage_path"] = row["storage_path"]
            return asset

    def update_asset_provider(
        self,
        asset_id: str,
        *,
        provider: str,
        provider_file_id: str,
        status: str,
        provider_model: str | None = None,
        expires_at: str | None = None,
    ) -> dict[str, Any]:
        with self._connection() as connection:
            cursor = connection.execute(
                """UPDATE assets SET provider = ?, provider_model = ?, provider_file_id = ?, status = ?, expires_at = ?
                   WHERE id = ?""",
                (provider, provider_model, provider_file_id, status, expires_at, asset_id),
            )
            if cursor.rowcount == 0:
                raise NotFoundError(f"asset not found: {asset_id}")
        return self.get_asset(asset_id)

    @staticmethod
    def _asset_from_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "conversation_id": row["conversation_id"],
            "sha256": row["sha256"],
            "filename": row["filename"],
            "mime_type": row["mime_type"],
            "byte_size": int(row["byte_size"]),
            "provider": row["provider"],
            "provider_model": row["provider_model"] if "provider_model" in row.keys() else None,
            "provider_file_id": row["provider_file_id"],
            "status": row["status"],
            "expires_at": row["expires_at"],
            "created_at": row["created_at"],
        }


def merge_usage(usages: Iterable[dict[str, Any]]) -> dict[str, Any]:
    result = {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "cached_tokens": 0,
        "reasoning_tokens": 0,
        "image_tokens": 0,
    }
    for usage in usages:
        for key in result:
            value = usage.get(key)
            if isinstance(value, (int, float)):
                result[key] += int(value)
    return result
