from __future__ import annotations

import copy
import json
import os
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Callable


ContextObserver = Callable[[dict[str, Any]], None]


@dataclass(frozen=True)
class ResponsesCompatibility:
    """Provider gaps relative to the canonical OpenAI Responses request."""

    unsupported_request_fields: tuple[str, ...] = ()


@dataclass(frozen=True)
class ProviderCapabilities:
    responses: bool
    previous_response_id: bool
    files: bool
    reasoning_modes: tuple[str, ...] = ("fast", "auto", "deep")
    context_window: int | None = None

    def as_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["reasoning_modes"] = list(self.reasoning_modes)
        return value


def _optional_positive_int(name: str) -> int | None:
    raw = os.getenv(name, "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def provider_capabilities(provider_id: str) -> ProviderCapabilities:
    if provider_id == "doubao":
        return ProviderCapabilities(
            responses=_env_flag("DOUBAO_RESPONSES_ENABLED", True),
            previous_response_id=True,
            files=True,
            context_window=_optional_positive_int("DOUBAO_CONTEXT_WINDOW"),
        )
    if provider_id == "bailian":
        return ProviderCapabilities(
            responses=_env_flag("BAILIAN_RESPONSES_ENABLED", True),
            previous_response_id=True,
            # Bailian exposes a model-bound 48-hour temporary OSS upload
            # channel rather than an OpenAI-style Files endpoint.
            files=True,
            context_window=_optional_positive_int("BAILIAN_CONTEXT_WINDOW"),
        )
    return ProviderCapabilities(responses=False, previous_response_id=False, files=False, reasoning_modes=())


def responses_compatibility(provider_id: str) -> ResponsesCompatibility:
    # Both providers implement the main OpenAI Responses lifecycle, but their
    # current request schemas do not accept OpenAI's optional
    # `reasoning.summary` selector. They can still return reasoning summary
    # output items, which are parsed normally below.
    if provider_id in {"bailian", "doubao"}:
        return ResponsesCompatibility(unsupported_request_fields=("reasoning.summary",))
    return ResponsesCompatibility()


def _dump(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool, list, dict)):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return model_dump()
    if hasattr(value, "__dict__"):
        return {
            key: _dump(item)
            for key, item in vars(value).items()
            if not key.startswith("_")
        }
    return value


def _get(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def _observe(observer: ContextObserver | None, event: dict[str, Any]) -> None:
    if observer is None:
        return
    payload = {"observed_at": datetime.now(timezone.utc).isoformat(), **event}
    try:
        observer(payload)
    except Exception as error:
        print(f"Context observer failed: {error}", file=sys.stderr)


def _drop_nested_field(value: dict[str, Any], path: str) -> bool:
    parts = path.split(".")
    current: Any = value
    for part in parts[:-1]:
        if not isinstance(current, dict) or part not in current:
            return False
        current = current[part]
    if not isinstance(current, dict) or parts[-1] not in current:
        return False
    current.pop(parts[-1], None)
    return True


def adapt_openai_responses_request(
    provider_id: str,
    canonical_request: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    """Produce a provider wire request without changing the OpenAI contract."""

    request = copy.deepcopy(canonical_request)
    omitted_fields = [
        path
        for path in responses_compatibility(provider_id).unsupported_request_fields
        if _drop_nested_field(request, path)
    ]
    return request, omitted_fields


def _error_text(error: Exception) -> str:
    parts = [str(error)]
    body = getattr(error, "body", None)
    if body is not None:
        try:
            parts.append(json.dumps(_dump(body), ensure_ascii=False, sort_keys=True))
        except (TypeError, ValueError):
            parts.append(str(body))
    return " ".join(parts).lower()


def _is_unsupported_parameter_error(error: Exception, *parameter_names: str) -> bool:
    message = _error_text(error)
    unsupported_markers = (
        "unknown field",
        "unknown parameter",
        "unsupported",
        "not supported",
        "unrecognized",
        "unexpected keyword",
        "extra inputs are not permitted",
        "invalidparameter",
    )
    return any(marker in message for marker in unsupported_markers) and any(
        name.lower() in message for name in parameter_names
    )


def _is_responses_endpoint_unsupported(error: Exception) -> bool:
    """Only classify an unavailable Responses endpoint as protocol fallback-safe."""

    message = _error_text(error)
    if "unknown field" in message or "unknown parameter" in message or "invalidparameter" in message:
        return False
    endpoint_markers = (
        "responses endpoint is not supported",
        "responses api is not supported",
        "unsupported endpoint",
        "unknown endpoint",
        "no route",
        "404 not found",
        "method not allowed",
    )
    return any(marker in message for marker in endpoint_markers)


def normalize_usage(raw_usage: Any, context_window: int | None = None) -> dict[str, Any]:
    usage = _dump(raw_usage) or {}
    input_tokens = _get(usage, "input_tokens", _get(usage, "prompt_tokens", 0)) or 0
    output_tokens = _get(usage, "output_tokens", _get(usage, "completion_tokens", 0)) or 0
    total_tokens = _get(usage, "total_tokens", input_tokens + output_tokens) or input_tokens + output_tokens
    input_details = _get(usage, "input_tokens_details", _get(usage, "prompt_tokens_details", {})) or {}
    output_details = _get(usage, "output_tokens_details", _get(usage, "completion_tokens_details", {})) or {}
    cached_tokens = _get(input_details, "cached_tokens", _get(usage, "cached_tokens", 0)) or 0
    reasoning_tokens = _get(output_details, "reasoning_tokens", _get(usage, "reasoning_tokens", 0)) or 0
    image_tokens = _get(input_details, "image_tokens", _get(usage, "image_tokens", 0)) or 0
    normalized: dict[str, Any] = {
        "input_tokens": int(input_tokens),
        "output_tokens": int(output_tokens),
        "total_tokens": int(total_tokens),
        "cached_tokens": int(cached_tokens),
        "reasoning_tokens": int(reasoning_tokens),
        "image_tokens": int(image_tokens),
        "context_window": context_window,
        "context_ratio": round(float(input_tokens) / context_window, 6) if context_window else None,
    }
    return normalized


def _serialize_chat_message(message: Any) -> tuple[dict[str, Any], str]:
    content = _get(message, "content")
    # Never surface raw reasoning_content / hidden chain-of-thought. Only an
    # explicitly provider-labelled summary is eligible for the UI timeline.
    reasoning = _get(message, "reasoning_summary", "") or ""
    model_extra = _get(message, "model_extra", {}) or {}
    if not reasoning:
        reasoning = _get(model_extra, "reasoning_summary", "") or ""
    result: dict[str, Any] = {"role": "assistant", "content": content}
    raw_tool_calls = _get(message, "tool_calls", []) or []
    if raw_tool_calls:
        result["tool_calls"] = [
            {
                "id": _get(call, "id"),
                "type": "function",
                "function": {
                    "name": _get(_get(call, "function", {}), "name"),
                    "arguments": _get(_get(call, "function", {}), "arguments", "{}"),
                },
            }
            for call in raw_tool_calls
        ]
    return result, str(reasoning)


def _responses_message(response: Any) -> tuple[dict[str, Any], str]:
    texts: list[str] = []
    reasoning_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    for item in _get(response, "output", []) or []:
        item_type = _get(item, "type", "")
        if item_type == "message":
            for part in _get(item, "content", []) or []:
                if _get(part, "type") in {"output_text", "text"}:
                    text = _get(part, "text", "")
                    if isinstance(text, str) and text:
                        texts.append(text)
        elif item_type == "function_call":
            call_id = _get(item, "call_id", _get(item, "id", ""))
            tool_calls.append(
                {
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": _get(item, "name", ""),
                        "arguments": _get(item, "arguments", "{}"),
                    },
                }
            )
        elif item_type == "reasoning":
            summary = _get(item, "summary", []) or []
            if isinstance(summary, str):
                reasoning_parts.append(summary)
            else:
                for part in summary:
                    text = _get(part, "text", "")
                    if isinstance(text, str) and text:
                        reasoning_parts.append(text)
    if not texts:
        output_text = _get(response, "output_text", "")
        if isinstance(output_text, str) and output_text:
            texts.append(output_text)
    message: dict[str, Any] = {"role": "assistant", "content": "\n".join(texts) or None}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return message, "\n".join(reasoning_parts)


def _responses_tools(chat_tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in chat_tools:
        function = item.get("function", {})
        if not isinstance(function, dict) or not isinstance(function.get("name"), str):
            continue
        tool = {
            "type": "function",
            "name": function["name"],
            "description": function.get("description", ""),
            "parameters": function.get("parameters", {"type": "object", "properties": {}}),
        }
        result.append(tool)
    return result


def _responses_content(content: Any) -> Any:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return content
    parts: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text" and isinstance(part.get("text"), str):
            parts.append({"type": "input_text", "text": part["text"]})
        elif part.get("type") == "image_url" and isinstance(part.get("image_url"), dict):
            url = part["image_url"].get("url")
            if isinstance(url, str):
                parts.append({"type": "input_image", "image_url": url})
        elif part.get("type") == "input_image" and isinstance(part.get("file_id"), str):
            parts.append({"type": "input_image", "file_id": part["file_id"]})
    return parts


def _initial_responses_input(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]] | None:
    instructions = ""
    input_items: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            content = message.get("content")
            if isinstance(content, str):
                instructions = content
            continue
        if role not in {"user", "assistant"} or message.get("tool_calls"):
            return None
        input_items.append({"role": role, "content": _responses_content(message.get("content"))})
    return instructions, input_items


def build_openai_responses_request(
    *,
    model: str,
    instructions: str,
    input_items: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    require_tool: bool,
    reasoning_mode: str,
    previous_response_id: str | None,
) -> dict[str, Any]:
    """Build the canonical request defined by the OpenAI Responses API."""

    effort = {"fast": "low", "auto": "medium", "deep": "high"}.get(reasoning_mode, "medium")
    request: dict[str, Any] = {
        "model": model,
        "instructions": instructions,
        "input": input_items,
        "tools": _responses_tools(tools),
        "tool_choice": "required" if require_tool else "auto",
        "store": True,
        "reasoning": {"effort": effort, "summary": "auto"},
    }
    if previous_response_id:
        request["previous_response_id"] = previous_response_id
    return request


class ProviderAdapter:
    """Normalize Chat Completions and Responses without owning API credentials."""

    def invoke(
        self,
        *,
        client: Any,
        provider_id: str,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        require_tool: bool,
        reasoning_mode: str = "auto",
        prefer_responses: bool = True,
        previous_response_id: str | None = None,
        tool_outputs: list[dict[str, Any]] | None = None,
        additional_input_items: list[dict[str, Any]] | None = None,
        allow_chat_fallback: bool = False,
        chat_extra_body: dict[str, Any] | None = None,
        observer: ContextObserver | None = None,
    ) -> dict[str, Any]:
        capabilities = provider_capabilities(provider_id)
        can_use_responses = capabilities.responses and prefer_responses and hasattr(client, "responses")
        responses_input: tuple[str, list[dict[str, Any]]] | None = None
        if previous_response_id and tool_outputs is not None:
            instructions = next(
                (item.get("content", "") for item in messages if item.get("role") == "system"), ""
            )
            output_items = [
                {
                    "type": "function_call_output",
                    "call_id": item.get("tool_call_id", item.get("call_id", "")),
                    "output": item.get("content", item.get("output", "")),
                }
                for item in tool_outputs
            ]
            if additional_input_items:
                output_items.extend(additional_input_items)
            responses_input = (instructions if isinstance(instructions, str) else "", output_items)
        elif previous_response_id:
            instructions = next(
                (item.get("content", "") for item in messages if item.get("role") == "system"), ""
            )
            latest_user = next(
                (item for item in reversed(messages) if item.get("role") == "user"), None
            )
            if latest_user is not None:
                responses_input = (
                    instructions if isinstance(instructions, str) else "",
                    [{"role": "user", "content": _responses_content(latest_user.get("content"))}],
                )
            else:
                can_use_responses = False
        elif previous_response_id is None:
            responses_input = _initial_responses_input(messages)

        if can_use_responses and responses_input is not None:
            try:
                return self._invoke_responses(
                    client=client,
                    provider_id=provider_id,
                    model=model,
                    instructions=responses_input[0],
                    input_items=responses_input[1],
                    tools=tools,
                    require_tool=require_tool,
                    reasoning_mode=reasoning_mode,
                    previous_response_id=previous_response_id,
                    observer=observer,
                )
            except Exception as error:
                # A malformed optional field is still a Responses request
                # problem, not evidence that the protocol is unavailable.
                # Protocol fallback is opt-in and safe only before side effects.
                if (
                    not allow_chat_fallback
                    or previous_response_id is not None
                    or tool_outputs
                    or not _is_responses_endpoint_unsupported(error)
                ):
                    raise
                _observe(
                    observer,
                    {
                        "type": "protocol.fallback",
                        "from": "responses",
                        "to": "chat_completions",
                        "error": {
                            "type": error.__class__.__name__,
                            "message": str(error),
                            "repr": repr(error),
                        },
                    },
                )

        return self._invoke_chat(
            client=client,
            provider_id=provider_id,
            model=model,
            messages=messages,
            tools=tools,
            require_tool=require_tool,
            reasoning_mode=reasoning_mode,
            extra_body=chat_extra_body,
            observer=observer,
        )

    def _invoke_responses(
        self,
        *,
        client: Any,
        provider_id: str,
        model: str,
        instructions: str,
        input_items: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        require_tool: bool,
        reasoning_mode: str,
        previous_response_id: str | None,
        observer: ContextObserver | None,
    ) -> dict[str, Any]:
        canonical_request = build_openai_responses_request(
            model=model,
            instructions=instructions,
            input_items=input_items,
            tools=tools,
            require_tool=require_tool,
            reasoning_mode=reasoning_mode,
            previous_response_id=previous_response_id,
        )
        request, omitted_fields = adapt_openai_responses_request(provider_id, canonical_request)
        if omitted_fields:
            _observe(
                observer,
                {
                    "type": "provider.compatibility",
                    "protocol": "responses",
                    "provider": provider_id,
                    "canonical_request": canonical_request,
                    "omitted_request_fields": omitted_fields,
                    "request": request,
                },
            )
        response: Any = None
        reasoning_degraded = False
        for attempt in range(1, 4):
            _observe(
                observer,
                {
                    "type": "provider.request",
                    "protocol": "responses",
                    "attempt": attempt,
                    "request": request,
                },
            )
            try:
                response = client.responses.create(**request)
                _observe(
                    observer,
                    {
                        "type": "provider.response",
                        "protocol": "responses",
                        "attempt": attempt,
                        "response": _dump(response),
                    },
                )
                break
            except Exception as error:
                _observe(
                    observer,
                    {
                        "type": "provider.error",
                        "protocol": "responses",
                        "attempt": attempt,
                        "request": request,
                        "error": {
                            "type": error.__class__.__name__,
                            "message": str(error),
                            "repr": repr(error),
                        },
                    },
                )
                changed = False
                if isinstance(request.get("reasoning"), dict) and _is_unsupported_parameter_error(
                    error, "reasoning", "effort"
                ):
                    request.pop("reasoning", None)
                    reasoning_degraded = True
                    changed = True
                if request.get("tool_choice") == "required" and _is_unsupported_parameter_error(
                    error, "tool_choice"
                ):
                    request["tool_choice"] = "auto"
                    changed = True
                if not changed:
                    raise
        if response is None:
            raise RuntimeError("Responses API request did not complete")
        assistant_message, reasoning_summary = _responses_message(response)
        tool_calls = assistant_message.get("tool_calls", [])
        if require_tool and not tool_calls:
            raise ValueError("model did not return tool_calls")
        usage = normalize_usage(
            _get(response, "usage"), provider_capabilities(provider_id).context_window
        )
        return {
            "protocol": "responses",
            "response_id": _get(response, "id"),
            "assistant_message": assistant_message,
            "tool_calls": tool_calls,
            "usage": usage,
            "reasoning_summary": reasoning_summary,
            "reasoning_degraded": reasoning_degraded,
        }

    def _invoke_chat(
        self,
        *,
        client: Any,
        provider_id: str,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        require_tool: bool,
        reasoning_mode: str,
        extra_body: dict[str, Any] | None,
        observer: ContextObserver | None,
    ) -> dict[str, Any]:
        request: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": 0.1,
            "tools": tools,
            "tool_choice": "required" if require_tool else "auto",
        }
        if extra_body:
            request["extra_body"] = dict(extra_body)
        _observe(
            observer,
            {
                "type": "provider.request",
                "protocol": "chat_completions",
                "attempt": 1,
                "request": request,
            },
        )
        try:
            completion = client.chat.completions.create(**request)
        except Exception as first_error:
            _observe(
                observer,
                {
                    "type": "provider.error",
                    "protocol": "chat_completions",
                    "attempt": 1,
                    "request": request,
                    "error": {
                        "type": first_error.__class__.__name__,
                        "message": str(first_error),
                        "repr": repr(first_error),
                    },
                },
            )
            if "tool_choice" not in str(first_error):
                raise
            request["tool_choice"] = "auto"
            _observe(
                observer,
                {
                    "type": "provider.request",
                    "protocol": "chat_completions",
                    "attempt": 2,
                    "request": request,
                },
            )
            try:
                completion = client.chat.completions.create(**request)
            except Exception as second_error:
                _observe(
                    observer,
                    {
                        "type": "provider.error",
                        "protocol": "chat_completions",
                        "attempt": 2,
                        "request": request,
                        "error": {
                            "type": second_error.__class__.__name__,
                            "message": str(second_error),
                            "repr": repr(second_error),
                        },
                    },
                )
                raise
            attempt = 2
        else:
            attempt = 1
        _observe(
            observer,
            {
                "type": "provider.response",
                "protocol": "chat_completions",
                "attempt": attempt,
                "response": _dump(completion),
            },
        )
        choice = _get(completion, "choices", [])[0]
        assistant_message, reasoning_summary = _serialize_chat_message(_get(choice, "message"))
        tool_calls = assistant_message.get("tool_calls", [])
        if require_tool and not tool_calls:
            raise ValueError("model did not return tool_calls")
        usage = normalize_usage(
            _get(completion, "usage"), provider_capabilities(provider_id).context_window
        )
        return {
            "protocol": "chat_completions",
            "response_id": _get(completion, "id"),
            "assistant_message": assistant_message,
            "tool_calls": tool_calls,
            "usage": usage,
            "reasoning_summary": reasoning_summary,
            "reasoning_degraded": False,
        }


DEFAULT_ADAPTER = ProviderAdapter()
