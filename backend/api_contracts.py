"""Public JSON shapes for the local conversation API.

The raw HTTP server intentionally has no framework-generated OpenAPI document.
These TypedDicts are the small source of truth shared by tests and future client
generation. Fields use snake_case on the wire.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict


API_CONTRACT_VERSION = "2026-07-10"


class Usage(TypedDict, total=False):
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cached_tokens: int
    reasoning_tokens: int
    image_tokens: int
    session_total_tokens: int
    context_window: int | None
    context_ratio: float | None


class Conversation(TypedDict):
    id: str
    title: str
    provider: str
    model: str
    reasoning_mode: Literal["fast", "auto", "deep"]
    canvas_revision: int
    canvas_state: Any
    previous_response_id: str | None
    summary: str
    created_at: str
    updated_at: str


class ToolOutput(TypedDict):
    tool_call_id: str
    content: str


class TurnResponse(TypedDict, total=False):
    turn_id: str
    conversation_id: str
    canvas_revision: int
    status: Literal["running", "requires_action", "completed", "stopped", "error"]
    provider: str
    model: str
    protocol: Literal["pending", "responses", "chat_completions"]
    assistant_message: dict[str, Any] | None
    tool_calls: list[dict[str, Any]]
    messages: list[dict[str, Any]]
    usage: Usage
    reasoning_summary: str
    reasoning_degraded: bool
    clear_allowed: bool
    stop_reason: str | None
    events: list[dict[str, Any]]


StreamEventName = Literal[
    "turn.started",
    "reasoning.summary.delta",
    "assistant.text.delta",
    "tool.call",
    "tool.result",
    "usage.updated",
    "step.completed",
    "turn.completed",
    "turn.stopped",
    "turn.error",
]


class StreamEvent(TypedDict):
    id: int | None
    conversation_id: str
    turn_id: str
    type: StreamEventName
    payload: dict[str, Any]
    created_at: str | None


ROUTES = {
    "conversations": "GET|POST /api/conversations",
    "conversation": "GET|PATCH|DELETE /api/conversations/{conversation_id}",
    "canvas": "PUT /api/conversations/{conversation_id}/canvas",
    "events": "GET /api/conversations/{conversation_id}/events",
    "start_turn": "POST /api/conversations/{conversation_id}/turns",
    "continue_turn": "POST /api/turns/{turn_id}/continue",
    "cancel_turn": "POST /api/turns/{turn_id}/cancel",
    "asset": "POST /api/assets",
}
