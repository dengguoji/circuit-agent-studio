from __future__ import annotations

import base64
import json
import os
import re
import tempfile
import threading
from dataclasses import asdict, dataclass, is_dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_ready(value: Any) -> Any:
    """Convert SDK objects to JSON without shortening strings or collections."""

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return {
            "$type": "bytes",
            "encoding": "base64",
            "data": base64.b64encode(value).decode("ascii"),
        }
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): json_ready(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_ready(item) for item in value]
    if is_dataclass(value):
        return json_ready(asdict(value))

    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return json_ready(model_dump(mode="json"))
        except TypeError:
            return json_ready(model_dump())
    if hasattr(value, "__dict__"):
        return {
            str(key): json_ready(item)
            for key, item in vars(value).items()
            if not str(key).startswith("_")
        }
    return repr(value)


@dataclass(frozen=True)
class ContextStepRef:
    conversation_id: str
    turn_id: str
    step_index: int


class ContextHistoryRecorder:
    """Durable, local, unabridged model-context observation files.

    Each turn has one JSON document containing the complete logical context for
    every model step plus every exact provider request attempt, response and
    fallback error. Unlike normal event persistence this recorder deliberately
    does not remove inline image data or shorten large tool results.
    """

    def __init__(self, root: str | os.PathLike[str]):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._ensure_index()

    def start_step(
        self,
        conversation_id: str,
        turn_id: str,
        logical_context: dict[str, Any],
    ) -> ContextStepRef:
        with self._lock:
            document = self._load_document(conversation_id, turn_id)
            step_index = len(document["steps"]) + 1
            document["steps"].append(
                {
                    "step_index": step_index,
                    "started_at": utc_now(),
                    "completed_at": None,
                    "logical_context": json_ready(logical_context),
                    "provider_events": [],
                    "normalized_result": None,
                    "terminal_error": None,
                }
            )
            document["updated_at"] = utc_now()
            self._write_document(document)
            return ContextStepRef(conversation_id, turn_id, step_index)

    def append_provider_event(self, reference: ContextStepRef, event: dict[str, Any]) -> None:
        with self._lock:
            document = self._load_document(reference.conversation_id, reference.turn_id)
            step = self._find_step(document, reference.step_index)
            step["provider_events"].append(json_ready(event))
            document["updated_at"] = utc_now()
            self._write_document(document)

    def complete_step(
        self,
        reference: ContextStepRef,
        *,
        result: dict[str, Any] | None = None,
        error: BaseException | None = None,
    ) -> None:
        with self._lock:
            document = self._load_document(reference.conversation_id, reference.turn_id)
            step = self._find_step(document, reference.step_index)
            step["completed_at"] = utc_now()
            step["normalized_result"] = json_ready(result) if result is not None else None
            step["terminal_error"] = (
                {
                    "type": error.__class__.__name__,
                    "message": str(error),
                    "repr": repr(error),
                }
                if error is not None
                else None
            )
            document["updated_at"] = utc_now()
            self._write_document(document)

    def document_path(self, conversation_id: str, turn_id: str) -> Path:
        return self.root / self._safe_identifier(conversation_id) / f"{self._safe_identifier(turn_id)}.json"

    def _ensure_index(self) -> None:
        path = self.root / "index.json"
        if path.exists():
            return
        self._atomic_write(
            path,
            {
                "schema_version": SCHEMA_VERSION,
                "description": "Unabridged model context and provider request/response history.",
                "no_truncation": True,
                "latest": None,
                "turns": [],
            },
        )

    def _load_document(self, conversation_id: str, turn_id: str) -> dict[str, Any]:
        path = self.document_path(conversation_id, turn_id)
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict) and isinstance(loaded.get("steps"), list):
                    return loaded
            except (OSError, json.JSONDecodeError):
                pass
        now = utc_now()
        return {
            "schema_version": SCHEMA_VERSION,
            "complete": True,
            "conversation_id": conversation_id,
            "turn_id": turn_id,
            "created_at": now,
            "updated_at": now,
            "steps": [],
        }

    def _write_document(self, document: dict[str, Any]) -> None:
        path = self.document_path(document["conversation_id"], document["turn_id"])
        self._atomic_write(path, document)
        self._update_index(document, path)

    def _update_index(self, document: dict[str, Any], path: Path) -> None:
        index_path = self.root / "index.json"
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            index = {
                "schema_version": SCHEMA_VERSION,
                "description": "Unabridged model context and provider request/response history.",
                "no_truncation": True,
                "turns": [],
            }
        relative_path = str(path.relative_to(self.root))
        entry = {
            "conversation_id": document["conversation_id"],
            "turn_id": document["turn_id"],
            "path": relative_path,
            "steps": len(document["steps"]),
            "updated_at": document["updated_at"],
        }
        turns = [
            item
            for item in index.get("turns", [])
            if not (
                isinstance(item, dict)
                and item.get("conversation_id") == entry["conversation_id"]
                and item.get("turn_id") == entry["turn_id"]
            )
        ]
        turns.append(entry)
        turns.sort(key=lambda item: str(item.get("updated_at", "")), reverse=True)
        index["turns"] = turns
        index["latest"] = entry
        self._atomic_write(index_path, index)

    def _atomic_write(self, path: Path, payload: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, delete=False
        ) as handle:
            temporary_path = Path(handle.name)
            json.dump(json_ready(payload), handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary_path, path)

    @staticmethod
    def _find_step(document: dict[str, Any], step_index: int) -> dict[str, Any]:
        for step in document["steps"]:
            if step.get("step_index") == step_index:
                return step
        raise KeyError(f"model context step {step_index} does not exist")

    @staticmethod
    def _safe_identifier(value: str) -> str:
        normalized = re.sub(r"[^A-Za-z0-9_-]+", "_", value).strip("_")
        return normalized or "unknown"
