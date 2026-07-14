from __future__ import annotations

import base64
import json
import os
import re
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.parser import BytesParser
from email.policy import default as email_policy
from pathlib import Path
from typing import Any, Literal, TypedDict
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

from component_registry import get_component_catalog, get_component_detail, get_registry_summary
from context_observer import ContextHistoryRecorder
from langgraph.graph import END, START, StateGraph
from langsmith import traceable
from openai import OpenAI
from persistence import (
    ConversationStore,
    NotFoundError,
    RevisionConflictError,
    StoreError,
    merge_usage,
    sanitize_for_storage,
)
from prompt_asset import load_prompt_asset, render_prompt_block
from provider_adapter import DEFAULT_ADAPTER, provider_capabilities


PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
DEBUG_MESSAGES_PATH = os.path.join(PROJECT_ROOT, "tmp", "messages.json")
DEFAULT_DATABASE_PATH = os.path.join(PROJECT_ROOT, "tmp", "circuit_agent.sqlite3")
DEFAULT_ASSET_DIR = os.path.join(PROJECT_ROOT, "tmp", "assets")
DEFAULT_CONTEXT_HISTORY_DIR = os.path.join(PROJECT_ROOT, "context_history")
PROMPT_ASSET_PATH = Path(PROJECT_ROOT).parent / "prompts" / "circuit_agent.md"
MAX_ASSET_BYTES = 20 * 1024 * 1024
_STORE_LOCK = threading.Lock()
_STORE: ConversationStore | None = None
_STORE_KEY = ""
_ACTIVE_CLIENTS_LOCK = threading.Lock()
_ACTIVE_PROVIDER_CLIENTS: dict[str, Any] = {}
_CONTEXT_RECORDER_LOCK = threading.Lock()
_CONTEXT_RECORDER: ContextHistoryRecorder | None = None
_CONTEXT_RECORDER_KEY = ""


def load_local_env() -> None:
    env_path = os.path.join(PROJECT_ROOT, ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


load_local_env()

HOST = os.getenv("CIRCUIT_AGENT_HOST", "127.0.0.1")
PORT = int(os.getenv("CIRCUIT_AGENT_PORT", "8787"))
os.environ.setdefault("LANGSMITH_PROJECT", "circuit-agent-studio")
os.environ.setdefault("LANGSMITH_TRACING", "false")
ENABLE_THINKING = os.getenv("BAILIAN_ENABLE_THINKING", "false").strip().lower() in {"1", "true", "yes", "on"}


def get_store() -> ConversationStore:
    global _STORE, _STORE_KEY
    database_path = os.getenv("CIRCUIT_DATABASE_PATH", DEFAULT_DATABASE_PATH)
    asset_dir = os.getenv("CIRCUIT_ASSET_DIR", DEFAULT_ASSET_DIR)
    if not os.path.isabs(database_path):
        database_path = os.path.join(PROJECT_ROOT, database_path)
    if not os.path.isabs(asset_dir):
        asset_dir = os.path.join(PROJECT_ROOT, asset_dir)
    key = f"{database_path}\0{asset_dir}"
    with _STORE_LOCK:
        if _STORE is None or _STORE_KEY != key:
            _STORE = ConversationStore(database_path, asset_dir)
            _STORE_KEY = key
        return _STORE


def context_history_enabled() -> bool:
    return os.getenv("CIRCUIT_CONTEXT_HISTORY_ENABLED", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def get_context_recorder() -> ContextHistoryRecorder | None:
    global _CONTEXT_RECORDER, _CONTEXT_RECORDER_KEY
    if not context_history_enabled():
        return None
    root = os.getenv("CIRCUIT_CONTEXT_HISTORY_DIR", DEFAULT_CONTEXT_HISTORY_DIR)
    if not os.path.isabs(root):
        root = os.path.join(PROJECT_ROOT, root)
    with _CONTEXT_RECORDER_LOCK:
        if _CONTEXT_RECORDER is None or _CONTEXT_RECORDER_KEY != root:
            _CONTEXT_RECORDER = ContextHistoryRecorder(root)
            _CONTEXT_RECORDER_KEY = root
        return _CONTEXT_RECORDER


ProviderId = Literal["bailian", "doubao"]


@dataclass(frozen=True)
class ModelProvider:
    id: ProviderId
    name: str
    base_url: str
    base_url_env: str
    api_key_envs: tuple[str, ...]
    models: tuple[str, ...]
    default_model: str
    enable_thinking: bool = False

    def api_key(self) -> str | None:
        return next((os.getenv(key) for key in self.api_key_envs if os.getenv(key)), None)

    def missing_env(self) -> list[str]:
        return [] if self.api_key() else list(self.api_key_envs)


MODEL_PROVIDERS: dict[ProviderId, ModelProvider] = {
    "bailian": ModelProvider(
        id="bailian",
        name="阿里百炼",
        base_url=os.getenv("BAILIAN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        base_url_env="BAILIAN_BASE_URL",
        api_key_envs=("BAILIAN_API_KEY", "DASHSCOPE_API_KEY", "ALIBABA_CLOUD_API_KEY"),
        models=("qwen3.7-plus", "qwen3.7-max", "qwen3.6-plus", "qwen3.6-flash"),
        default_model=os.getenv("BAILIAN_MODEL", "qwen3.7-plus"),
        enable_thinking=ENABLE_THINKING,
    ),
    "doubao": ModelProvider(
        id="doubao",
        name="火山方舟",
        base_url=os.getenv("DOUBAO_BASE_URL", os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")),
        base_url_env="DOUBAO_BASE_URL",
        api_key_envs=("DOUBAO_API_KEY", "ARK_API_KEY", "VOLCENGINE_API_KEY"),
        models=("doubao-2.0-pro-250515", "doubao-seed-evolving", "doubao-seed-2-1-pro-260628"),
        default_model=os.getenv("DOUBAO_MODEL", "doubao-2.0-pro-250515"),
        enable_thinking=False,
    ),
}

DEFAULT_PROVIDER: ProviderId = "bailian"

PROMPT_ASSET = load_prompt_asset(PROMPT_ASSET_PATH)
SYSTEM_PROMPT = PROMPT_ASSET.blocks["system"]

COMPONENT_POINT_SCHEMA = {
    "type": "array",
    "items": {"type": "number", "multipleOf": 10},
    "minItems": 2,
    "maxItems": 2,
    "description": "A component origin as [x, y]. Both values must be multiples of 10.",
}

CONNECTION_POINT_SCHEMA = {
    "type": "array",
    "items": {"type": "number", "multipleOf": 5},
    "minItems": 2,
    "maxItems": 2,
    "description": "A wire endpoint or junction as [x, y]. Both values must be multiples of 5.",
}

ORIENTATION_SCHEMA = {
    "type": "string",
    "enum": ["h", "v"],
    "description": "Component orientation. Use get_component_detail render_summary.autorotate to determine whether h, v or both are supported.",
}

TOOLS = [
    # 只读检查工具：让模型查看当前画布摘要、校验状态和连接问题，不会修改画布。
    {
        "type": "function",
        "function": {
            "name": "inspect_canvas",
            "description": "Inspect the current canvas without changing it. Use this after drawing or correction passes to review counts, validation and current state before deciding whether more tool calls are needed.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "review_canvas_visual",
            "description": "Request one visual screenshot of the current rendered canvas. Use only when reconstructing an uploaded image or when structured inspect_canvas data cannot determine layout quality. At most two visual reviews are allowed per turn.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    # 清空画布工具：当用户要重新生成一张电路图时，模型应先调用它移除所有元件、导线和连接点。
    {
        "type": "function",
        "function": {
            "name": "clear_canvas",
            "description": "Clear all components, wires and junctions before drawing a new circuit.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    # 元件目录检索工具：让模型按关键词查询可用元件及其配置别名，用于决定后续需要哪些元件详情。
    {
        "type": "function",
        "function": {
            "name": "get_component_catalog",
            "description": "List all available circuit components and configuration aliases. This tool takes no arguments and returns a lightweight catalog.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
    # 元件详情工具：返回指定元件的 XML 解析结果，包括属性、默认值、配置、连接点和渲染摘要。
    {
        "type": "function",
        "function": {
            "name": "get_component_detail",
            "description": "Get XML-derived details before placing or rotating components. The existing render_summary.autorotate field is HorizontalOnly, VerticalOnly, HorizontalToVertical or HorizontalAndVertical.",
            "parameters": {
                "type": "object",
                "properties": {
                    "names": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Component or alias names, for example ['Resistor', 'Lamp', 'Cell'].",
                    }
                },
                "required": ["names"],
                "additionalProperties": False,
            },
        },
    },
    # 放置元件工具：在网格坐标上创建一个元件实例，返回绝对 bounds 和 connection_points 供模型后续连线。
    {
        "type": "function",
        "function": {
            "name": "place_component",
            "description": "Place one component on the grid. Use get_component_detail first. The system generates the component id and returns it in the tool result.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Component or configuration alias name."},
                    "origin": COMPONENT_POINT_SCHEMA,
                    "orientation": ORIENTATION_SCHEMA,
                    "properties": {
                        "type": "object",
                        "description": "Component properties keyed by XML property name. Text is a universal external label supported by every component. Values may be strings, numbers or booleans.",
                    },
                },
                "required": ["name", "origin", "orientation"],
                "additionalProperties": False,
            },
        },
    },
    # 移动元件工具：调整已有元件的位置，并可选地改变水平/垂直朝向。
    {
        "type": "function",
        "function": {
            "name": "move_component",
            "description": "Move an existing component and optionally change orientation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Existing system-generated component id, for example cmp_1."},
                    "origin": COMPONENT_POINT_SCHEMA,
                    "orientation": ORIENTATION_SCHEMA,
                },
                "required": ["id", "origin"],
                "additionalProperties": False,
            },
        },
    },
    # 修改元件属性工具：更新已有元件的动态属性，例如标签、阻值、电压、显示开关或配置相关字段。
    {
        "type": "function",
        "function": {
            "name": "update_component_properties",
            "description": "Update properties for an existing component.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Existing system-generated component id, for example cmp_1."},
                    "properties": {"type": "object", "description": "Properties to update."},
                },
                "required": ["id", "properties"],
                "additionalProperties": False,
            },
        },
    },
    # 删除元件工具：按 id 删除一个已有元件；导线不会被系统自动重布线，模型需要显式修正相关导线。
    {
        "type": "function",
        "function": {
            "name": "remove_component",
            "description": "Remove one existing component by id.",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string", "description": "Existing system-generated component id, for example cmp_1."}},
                "required": ["id"],
                "additionalProperties": False,
            },
        },
    },
    # 绘制导线工具：只允许画一根独立的水平或竖直线段，不支持折线和自动寻路。
    {
        "type": "function",
        "function": {
            "name": "draw_wire_segment",
            "description": "Draw one independent horizontal or vertical wire segment. Never use it for polylines. The system generates the wire id and returns it in the tool result.",
            "parameters": {
                "type": "object",
                "properties": {
                    "start": CONNECTION_POINT_SCHEMA,
                    "end": CONNECTION_POINT_SCHEMA,
                },
                "required": ["start", "end"],
                "additionalProperties": False,
            },
        },
    },
    # 更新导线工具：修改已有导线的起点和/或终点，用于修正线段长度、位置或连接关系。
    {
        "type": "function",
        "function": {
            "name": "update_wire_segment",
            "description": "Update the start and/or end point of an existing wire segment.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Existing system-generated wire id, for example wire_1."},
                    "start": CONNECTION_POINT_SCHEMA,
                    "end": CONNECTION_POINT_SCHEMA,
                },
                "required": ["id"],
                "additionalProperties": False,
            },
        },
    },
    # 删除导线工具：按 id 删除一根已有导线线段，不会自动删除关联 junction。
    {
        "type": "function",
        "function": {
            "name": "delete_wire_segment",
            "description": "Delete one existing wire segment by id.",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string", "description": "Existing system-generated wire id, for example wire_1."}},
                "required": ["id"],
                "additionalProperties": False,
            },
        },
    },
    # 添加连接点工具：在导线端点、分叉点或交叉点放置显式黑点，表达电气连接关系。
    {
        "type": "function",
        "function": {
            "name": "add_junction",
            "description": "Place one explicit black-dot junction on a wire, branch, endpoint, or intersection. The system generates the junction id and returns it in the tool result.",
            "parameters": {
                "type": "object",
                "properties": {
                    "point": CONNECTION_POINT_SCHEMA,
                },
                "required": ["point"],
                "additionalProperties": False,
            },
        },
    },
    # 移动连接点工具：调整已有显式 junction 的坐标；由导线推导出的连接点不通过此工具移动。
    {
        "type": "function",
        "function": {
            "name": "move_junction",
            "description": "Move one existing explicit junction. Inferred junctions are controlled by their connected wires.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Existing system-generated junction id, for example junc_1."},
                    "point": CONNECTION_POINT_SCHEMA,
                },
                "required": ["id", "point"],
                "additionalProperties": False,
            },
        },
    },
    # 删除连接点工具：移除一个显式 junction；删除后只影响视觉/语义连接点，不会删除导线本身。
    {
        "type": "function",
        "function": {
            "name": "remove_junction",
            "description": "Remove one existing junction by id.",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string", "description": "Existing system-generated junction id, for example junc_1."}},
                "required": ["id"],
                "additionalProperties": False,
            },
        },
    },
]

_CLEAR_TOOL_NAME = "clear_canvas"
_CLEAR_PHRASES_ZH = (
    "清空画布",
    "重置画布",
    "新建画布",
    "从头重画",
    "全部重画",
    "重新画一个新图",
)
_CLEAR_PATTERN_EN = re.compile(
    r"\b(clear(?:\s+the)?\s+canvas|start\s+over|redraw\s+from\s+scratch)\b",
    re.IGNORECASE,
)


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        try:
            decoded = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            return content
        if isinstance(decoded, dict) and isinstance(decoded.get("user_request"), str):
            return decoded["user_request"]
        return content
    if isinstance(content, list):
        return "\n".join(
            _message_text(part.get("text"))
            for part in content
            if isinstance(part, dict) and part.get("type") in {"text", "input_text"}
        )
    return ""


def is_explicit_clear_request(text: str) -> bool:
    normalized = re.sub(r"\s+", " ", text.strip()).lower()
    if not normalized:
        return False
    chinese_phrases = "|".join(map(re.escape, _CLEAR_PHRASES_ZH))
    if re.search(rf"(?:不要|不|别|禁止|无需|不需要|不能).{{0,6}}(?:{chinese_phrases})", normalized):
        return False
    if re.search(r"\b(?:do\s+not|don't|never)\s+(?:fully\s+)?(?:clear|reset|redraw)", normalized):
        return False
    if re.search(r"\bwithout\s+(?:clearing|resetting|redrawing)", normalized):
        return False
    return any(phrase in normalized for phrase in _CLEAR_PHRASES_ZH) or bool(_CLEAR_PATTERN_EN.search(normalized))


def clear_canvas_allowed(payload: dict[str, Any]) -> bool:
    message = payload.get("message")
    if isinstance(message, str) and message.strip():
        return is_explicit_clear_request(message)
    messages = payload.get("messages")
    if isinstance(messages, list):
        for item in reversed(messages):
            if isinstance(item, dict) and item.get("role") == "user":
                return is_explicit_clear_request(_message_text(item.get("content")))
    return False


def tools_for_request(allow_clear: bool) -> list[dict[str, Any]]:
    if allow_clear:
        return TOOLS
    return [tool for tool in TOOLS if tool.get("function", {}).get("name") != _CLEAR_TOOL_NAME]


def enforce_tool_policy(tool_calls: list[dict[str, Any]], allow_clear: bool) -> None:
    if allow_clear:
        return
    if any(call.get("function", {}).get("name") == _CLEAR_TOOL_NAME for call in tool_calls):
        raise ValueError("clear_canvas is not allowed for this edit turn")


class AgentGraphState(TypedDict, total=False):
    messages: list[dict[str, Any]]
    provider_id: ProviderId
    model: str
    require_tool: bool
    tools: list[dict[str, Any]]
    reasoning_mode: str
    prefer_responses: bool
    assistant_message: dict[str, Any]
    tool_calls: list[dict[str, Any]]
    usage: dict[str, Any]
    reasoning_summary: str
    protocol: str
    response_id: str | None


def build_client(provider: ModelProvider) -> OpenAI:
    api_key = provider.api_key()
    if not api_key:
        joined = " or ".join(provider.api_key_envs)
        raise RuntimeError(f"Missing {provider.name} API key. Set {joined}.")
    default_headers = (
        {"X-DashScope-OssResourceResolve": "enable"}
        if provider.id == "bailian"
        else None
    )
    return OpenAI(api_key=api_key, base_url=provider.base_url, default_headers=default_headers)


def resolve_provider(payload: dict[str, Any]) -> ModelProvider:
    raw_provider = payload.get("model_provider", payload.get("provider", DEFAULT_PROVIDER))
    if raw_provider not in MODEL_PROVIDERS:
        valid = ", ".join(MODEL_PROVIDERS)
        raise ValueError(f"unknown model_provider {raw_provider!r}; valid providers: {valid}")
    return MODEL_PROVIDERS[raw_provider]  # type: ignore[index]


def resolve_model(provider: ModelProvider, payload: dict[str, Any]) -> str:
    requested = payload.get("model")
    model = requested if isinstance(requested, str) and requested.strip() else provider.default_model
    if model not in provider.models:
        known = ", ".join(provider.models)
        raise ValueError(f"model {model!r} is not configured for {provider.name}; configured models: {known}")
    return model


def normalize_reasoning_mode(value: Any) -> str:
    return value if value in {"fast", "auto", "deep"} else "auto"


def list_model_options() -> dict[str, Any]:
    options: list[dict[str, Any]] = []
    for provider in MODEL_PROVIDERS.values():
        missing_env = provider.missing_env()
        capabilities = provider_capabilities(provider.id).as_dict()
        for model in provider.models:
            options.append(
                {
                    "provider": provider.id,
                    "provider_name": provider.name,
                    "model": model,
                    "label": f"{provider.name} / {model}",
                    "available": not missing_env,
                    "missing_env": missing_env,
                    "base_url_env": provider.base_url_env,
                    "capabilities": capabilities,
                }
            )
    default_provider = MODEL_PROVIDERS[DEFAULT_PROVIDER]
    return {
        "default_provider": DEFAULT_PROVIDER,
        "default_model": default_provider.default_model,
        "langsmith": {
            "project": os.getenv("LANGSMITH_PROJECT", ""),
            "tracing": os.getenv("LANGSMITH_TRACING", ""),
            "has_api_key": bool(os.getenv("LANGSMITH_API_KEY")),
        },
        "options": options,
    }


def make_user_content(message: str, canvas_state: Any, canvas_bounds: Any, image_context: dict[str, Any] | None = None) -> str:
    model_canvas_state = compact_canvas_state_for_prompt(canvas_state)
    task_mode = "image_reconstruction" if image_context else "text_to_circuit"
    task_specific_rules = ""
    if image_context:
        task_rules = PROMPT_ASSET.metadata.get("task_rules", {})
        if isinstance(task_rules, dict):
            configured_rule = task_rules.get("image_reconstruction")
            if isinstance(configured_rule, str):
                task_specific_rules = configured_rule.strip()
        image_metadata = {
            "name": image_context.get("name", ""),
            "mime_type": image_context.get("mime_type", ""),
            "width": image_context.get("width"),
            "height": image_context.get("height"),
        }
        task_specific_rules = (
            f"{task_specific_rules}\n\n图片信息："
            f"{json.dumps(image_metadata, ensure_ascii=False)}"
        ).strip()
    return render_prompt_block(
        PROMPT_ASSET,
        "user",
        {
            "user_request": message,
            "task_mode": task_mode,
            "current_canvas_bounds": canvas_bounds,
            "current_canvas_state": model_canvas_state,
            "task_specific_rules": task_specific_rules,
        },
    )


def make_user_message_content(message: str, canvas_state: Any, canvas_bounds: Any, image: Any) -> str | list[dict[str, Any]]:
    image_part = normalize_image_payload(image)
    text = make_user_content(message, canvas_state, canvas_bounds, image_part)
    if image_part is None:
        return text
    return [
        {"type": "text", "text": text},
        {"type": "image_url", "image_url": {"url": image_part["data_url"]}},
    ]


def normalize_image_payload(image: Any) -> dict[str, Any] | None:
    if image is None:
        return None
    if not isinstance(image, dict):
        raise ValueError("image must be an object")

    width = image.get("width")
    height = image.get("height")
    data_url = image.get("data_url")
    mime_type = image.get("mime_type")
    name = image.get("name", "")

    if not isinstance(width, (int, float)) or not isinstance(height, (int, float)):
        raise ValueError("image width and height are required")
    if width <= 10 or height <= 10:
        raise ValueError("image width and height must both be larger than 10px")
    if not isinstance(data_url, str) or not data_url.startswith("data:image/"):
        raise ValueError("image data_url must be a base64 image data URL")
    if not isinstance(mime_type, str) or not mime_type.startswith("image/"):
        raise ValueError("image mime_type must start with image/")
    return {
        "name": name if isinstance(name, str) else "",
        "mime_type": mime_type,
        "data_url": data_url,
        "width": int(width),
        "height": int(height),
    }


def sanitize_message_content(content: Any) -> str | list[dict[str, Any]] | None:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None

    sanitized: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        part_type = part.get("type")
        if part_type == "text" and isinstance(part.get("text"), str):
            sanitized.append({"type": "text", "text": part["text"]})
        elif part_type == "image_url" and isinstance(part.get("image_url"), dict):
            url = part["image_url"].get("url")
            if isinstance(url, str):
                sanitized.append({"type": "image_url", "image_url": {"url": url}})
    return sanitized or None


def compact_canvas_state_for_prompt(canvas_state: Any) -> Any:
    """Remove editor-only XML/render payloads if an older client sends rich state."""
    if not isinstance(canvas_state, dict):
        return canvas_state

    compact = dict(canvas_state)
    canvas = compact.get("canvas")
    canvas_metadata = dict(canvas) if isinstance(canvas, dict) else {}
    canvas_metadata.update({"component_grid": 10, "connection_grid": 5, "major_grid": 50})
    compact["canvas"] = canvas_metadata
    components = compact.get("components")
    if isinstance(components, list):
        compact["components"] = [compact_component_for_prompt(component) for component in components]
    return compact


def compact_component_for_prompt(component: Any) -> Any:
    if not isinstance(component, dict):
        return component

    omitted_keys = {"detail", "render", "definitions"}
    return {key: value for key, value in component.items() if key not in omitted_keys}


def normalize_messages(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_messages = payload.get("messages")
    messages: list[dict[str, Any]] = []

    if isinstance(raw_messages, list):
        for item in raw_messages:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = sanitize_message_content(item.get("content"))
            if role in {"system", "user"} and content is not None:
                messages.append({"role": role, "content": content})
            elif role == "assistant":
                message: dict[str, Any] = {"role": "assistant", "content": content if isinstance(content, str) else None}
                tool_calls = item.get("tool_calls")
                if isinstance(tool_calls, list):
                    message["tool_calls"] = sanitize_tool_calls(tool_calls)
                messages.append(message)
            elif role == "tool" and isinstance(content, str) and isinstance(item.get("tool_call_id"), str):
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": item["tool_call_id"],
                        "content": content,
                    }
                )

    if not messages or messages[0].get("role") != "system":
        messages.insert(0, {"role": "system", "content": SYSTEM_PROMPT})
    else:
        messages[0] = {"role": "system", "content": SYSTEM_PROMPT}

    if payload.get("append_user_message", True):
        user_message = payload.get("message")
        image = normalize_image_payload(payload.get("image"))
        if (not isinstance(user_message, str) or not user_message.strip()) and image is None:
            raise ValueError("message must be a non-empty string when no image is provided")

        messages.append(
            {
                "role": "user",
                "content": make_user_message_content(
                    user_message.strip() if isinstance(user_message, str) else "",
                    payload.get("model_canvas_state", payload.get("canvas_state", {})),
                    payload.get("canvas_bounds", {"width": 1000, "height": 1000}),
                    image,
                ),
            }
        )
    return messages


@traceable(name="circuit_agent_model_call", run_type="llm")
def call_openai_compatible_model(state: AgentGraphState) -> dict[str, Any]:
    provider = MODEL_PROVIDERS[state["provider_id"]]
    model = state["model"]
    messages = state["messages"]
    require_tool = state.get("require_tool", True)
    client = build_client(provider)
    reasoning_mode = state.get("reasoning_mode", "auto")
    extra_body: dict[str, Any] | None = None
    if provider.id == "bailian":
        enable_thinking = provider.enable_thinking
        if reasoning_mode == "fast":
            enable_thinking = False
        elif reasoning_mode == "deep":
            enable_thinking = True
        extra_body = {"enable_thinking": enable_thinking}
    available_tools = state.get("tools", TOOLS)
    observation_turn_id = f"legacy_{uuid.uuid4().hex}"
    recorder = get_context_recorder()
    context_step = (
        recorder.start_step(
            "legacy",
            observation_turn_id,
            {
                "provider": provider.id,
                "model": model,
                "messages": messages,
                "tools": available_tools,
                "require_tool": require_tool,
                "reasoning_mode": reasoning_mode,
                "prefer_responses": state.get("prefer_responses", False),
                "previous_response_id": None,
                "tool_outputs": None,
                "additional_input_items": None,
                "allow_chat_fallback": False,
            },
        )
        if recorder
        else None
    )
    try:
        result = DEFAULT_ADAPTER.invoke(
            client=client,
            provider_id=provider.id,
            model=model,
            messages=messages,
            tools=available_tools,
            require_tool=require_tool,
            reasoning_mode=reasoning_mode,
            prefer_responses=state.get("prefer_responses", False),
            allow_chat_fallback=False,
            chat_extra_body=extra_body,
            observer=(
                lambda event: recorder.append_provider_event(context_step, event)
            )
            if recorder and context_step
            else None,
        )
    except Exception as error:
        if recorder and context_step:
            recorder.complete_step(context_step, error=error)
        raise
    if recorder and context_step:
        recorder.complete_step(context_step, result=result)
    return result


def model_node(state: AgentGraphState) -> AgentGraphState:
    result = call_openai_compatible_model(state)
    return {
        **state,
        "assistant_message": result["assistant_message"],
        "tool_calls": result["tool_calls"],
        "usage": result["usage"],
        "reasoning_summary": result["reasoning_summary"],
        "protocol": result["protocol"],
        "response_id": result.get("response_id"),
    }


def build_agent_graph():
    graph = StateGraph(AgentGraphState)
    graph.add_node("model", model_node)
    graph.add_edge(START, "model")
    graph.add_edge("model", END)
    return graph.compile()


AGENT_GRAPH = build_agent_graph()


def call_agent(payload: dict[str, Any]) -> dict[str, Any]:
    messages = normalize_messages(payload)
    provider = resolve_provider(payload)
    model = resolve_model(provider, payload)
    require_tool = payload.get("require_tool") is not False
    allow_clear = clear_canvas_allowed(payload)
    reasoning_mode = normalize_reasoning_mode(payload.get("reasoning_mode"))

    result = AGENT_GRAPH.invoke(
        {
            "messages": messages,
            "provider_id": provider.id,
            "model": model,
            "require_tool": require_tool,
            "tools": tools_for_request(allow_clear),
            "reasoning_mode": reasoning_mode,
            # Legacy clients pass a full Chat Completions transcript. Keep that
            # path stable unless they explicitly opt into Responses.
            "prefer_responses": payload.get("prefer_responses") is True,
        },
        config={
            "run_name": "circuit_agent_step",
            "metadata": {"provider": provider.id, "model": model},
        },
    )

    assistant_message = result["assistant_message"]
    openai_tool_calls = result.get("tool_calls", [])
    enforce_tool_policy(openai_tool_calls, allow_clear)
    next_messages = messages + [assistant_message]

    return {
        "provider": provider.id,
        "provider_name": provider.name,
        "model": model,
        "base_url": provider.base_url,
        "enable_thinking": provider.enable_thinking,
        "reasoning_mode": reasoning_mode,
        "reasoning_summary": result.get("reasoning_summary", ""),
        "reasoning_degraded": bool(result.get("reasoning_degraded")),
        "usage": result.get("usage", {}),
        "protocol": result.get("protocol", "chat_completions"),
        "response_id": result.get("response_id"),
        "clear_allowed": allow_clear,
        "langsmith_project": os.getenv("LANGSMITH_PROJECT", ""),
        "raw_response": assistant_message,
        "tool_calls": openai_tool_calls,
        "messages": next_messages,
    }


def serialize_assistant_message(message: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "role": "assistant",
        "content": message.content,
    }
    if message.tool_calls:
        result["tool_calls"] = [
            {
                "id": tool_call.id,
                "type": tool_call.type,
                "function": {
                    "name": tool_call.function.name,
                    "arguments": tool_call.function.arguments,
                },
            }
            for tool_call in message.tool_calls
        ]
    return result


def sanitize_tool_calls(tool_calls: list[Any]) -> list[dict[str, Any]]:
    sanitized: list[dict[str, Any]] = []
    for item in tool_calls:
        if not isinstance(item, dict):
            continue
        function = item.get("function")
        if not isinstance(function, dict):
            continue
        name = function.get("name")
        arguments = function.get("arguments")
        if not isinstance(name, str):
            continue
        if not isinstance(arguments, str):
            arguments = json.dumps(arguments if isinstance(arguments, dict) else {}, ensure_ascii=False)
        sanitized.append(
            {
                "id": item.get("id") if isinstance(item.get("id"), str) else f"call_{len(sanitized) + 1}",
                "type": "function",
                "function": {"name": name, "arguments": arguments},
            }
        )
    return sanitized


def _provider_chat_extra(provider: ModelProvider, reasoning_mode: str) -> dict[str, Any] | None:
    if provider.id != "bailian":
        return None
    enabled = provider.enable_thinking
    if reasoning_mode == "fast":
        enabled = False
    elif reasoning_mode == "deep":
        enabled = True
    return {"enable_thinking": enabled}


def _history_messages(conversation_id: str, *, turn_id: str | None = None) -> list[dict[str, Any]]:
    events = get_store().list_events(conversation_id, turn_id=turn_id, limit=1000)
    user_indexes = [index for index, event in enumerate(events) if event["type"] == "user.message"]
    if turn_id is None and len(user_indexes) > 6:
        events = events[user_indexes[-6]:]

    messages: list[dict[str, Any]] = []
    for event in events:
        data = event.get("data")
        if event["type"] in {"user.message", "assistant.message", "visual.review"} and isinstance(data, dict):
            message = dict(data)
            content = message.get("content")
            if isinstance(content, list):
                message["content"] = [
                    part
                    for part in content
                    if not (
                        isinstance(part, dict)
                        and (
                            (
                                part.get("type") == "image_url"
                                and (
                                    turn_id is None
                                    or "[omitted:data-url]" in json.dumps(part, ensure_ascii=False)
                                )
                            )
                            or part.get("type") == "input_image" and turn_id is None
                        )
                    )
                ]
            messages.append(message)
        elif event["type"] == "tool.result" and isinstance(data, dict):
            tool_call_id = data.get("tool_call_id")
            content = data.get("content")
            if isinstance(tool_call_id, str) and isinstance(content, str):
                messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": content})
    return messages


def _message_summary_text(content: Any) -> str:
    if isinstance(content, list):
        content = "\n".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    if not isinstance(content, str):
        return ""
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        parsed = None
    if isinstance(parsed, dict) and isinstance(parsed.get("user_request"), str):
        content = parsed["user_request"]
    return " ".join(content.split())[:500]


def refresh_conversation_summary(conversation_id: str) -> str:
    store = get_store()
    events = store.list_events(conversation_id, limit=1000)
    user_events = [event for event in events if event["type"] == "user.message"]
    if len(user_events) <= 6:
        store.update_conversation(conversation_id, {"summary": ""})
        return ""
    cutoff_id = int(user_events[-6]["id"])
    lines: list[str] = []
    for event in events:
        if int(event["id"]) >= cutoff_id or event["type"] not in {"user.message", "assistant.message"}:
            continue
        data = event.get("data")
        if not isinstance(data, dict):
            continue
        text = _message_summary_text(data.get("content"))
        if not text:
            continue
        prefix = "User" if event["type"] == "user.message" else "Assistant"
        lines.append(f"{prefix}: {text}")
    summary = "\n".join(lines[-24:])[-3000:]
    store.update_conversation(conversation_id, {"summary": summary})
    return summary


def system_prompt_for_conversation(conversation: dict[str, Any]) -> str:
    summary = conversation.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        return SYSTEM_PROMPT
    return f"{SYSTEM_PROMPT}\n\n较早会话的紧凑摘要（当前画布状态仍以本轮输入为准）：\n{summary.strip()}"


def _responses_rebuild_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep compact text history when a provider-side response chain expires."""

    rebuilt: list[dict[str, Any]] = []
    latest_user_index = max(
        (index for index, item in enumerate(messages) if item.get("role") == "user"),
        default=-1,
    )
    for index, message in enumerate(messages):
        role = message.get("role")
        if role == "system" and isinstance(message.get("content"), str):
            rebuilt = [{"role": "system", "content": message["content"]}]
        elif role == "user":
            content = message.get("content")
            if isinstance(content, list) and index != latest_user_index:
                text = "\n".join(
                    part.get("text", "")
                    for part in content
                    if isinstance(part, dict) and part.get("type") == "text"
                )
                content = text
            if isinstance(content, (str, list)) and content:
                rebuilt.append({"role": "user", "content": content})
        elif role == "assistant" and isinstance(message.get("content"), str) and message["content"]:
            rebuilt.append({"role": "assistant", "content": message["content"]})
    if not rebuilt or rebuilt[0].get("role") != "system":
        rebuilt.insert(0, {"role": "system", "content": SYSTEM_PROMPT})
    return rebuilt


def _invoke_provider(
    *,
    provider: ModelProvider,
    model: str,
    messages: list[dict[str, Any]],
    allow_clear: bool,
    require_tool: bool,
    reasoning_mode: str,
    prefer_responses: bool,
    previous_response_id: str | None = None,
    tool_outputs: list[dict[str, Any]] | None = None,
    additional_input_items: list[dict[str, Any]] | None = None,
    allow_chat_fallback: bool = False,
    turn_id: str | None = None,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    client = build_client(provider)
    available_tools = tools_for_request(allow_clear)
    observation_turn_id = turn_id or f"legacy_{uuid.uuid4().hex}"
    observation_conversation_id = conversation_id or "legacy"
    recorder = get_context_recorder()
    context_step = (
        recorder.start_step(
            observation_conversation_id,
            observation_turn_id,
            {
                "provider": provider.id,
                "model": model,
                "messages": messages,
                "tools": available_tools,
                "allow_clear": allow_clear,
                "require_tool": require_tool,
                "reasoning_mode": reasoning_mode,
                "prefer_responses": prefer_responses,
                "previous_response_id": previous_response_id,
                "tool_outputs": tool_outputs,
                "additional_input_items": additional_input_items,
                "allow_chat_fallback": allow_chat_fallback,
            },
        )
        if recorder
        else None
    )
    if turn_id:
        with _ACTIVE_CLIENTS_LOCK:
            _ACTIVE_PROVIDER_CLIENTS[turn_id] = client
    try:
        result = DEFAULT_ADAPTER.invoke(
            client=client,
            provider_id=provider.id,
            model=model,
            messages=messages,
            tools=available_tools,
            require_tool=require_tool,
            reasoning_mode=reasoning_mode,
            prefer_responses=prefer_responses,
            previous_response_id=previous_response_id,
            tool_outputs=tool_outputs,
            additional_input_items=additional_input_items,
            allow_chat_fallback=allow_chat_fallback,
            chat_extra_body=_provider_chat_extra(provider, reasoning_mode),
            observer=(
                lambda event: recorder.append_provider_event(context_step, event)
            )
            if recorder and context_step
            else None,
        )
    except Exception as error:
        if recorder and context_step:
            recorder.complete_step(context_step, error=error)
        raise
    else:
        if recorder and context_step:
            recorder.complete_step(context_step, result=result)
    finally:
        if turn_id:
            with _ACTIVE_CLIENTS_LOCK:
                if _ACTIVE_PROVIDER_CLIENTS.get(turn_id) is client:
                    _ACTIVE_PROVIDER_CLIENTS.pop(turn_id, None)
        close = getattr(client, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass
    enforce_tool_policy(result.get("tool_calls", []), allow_clear)
    return result


def abort_active_provider_request(turn_id: str) -> bool:
    with _ACTIVE_CLIENTS_LOCK:
        client = _ACTIVE_PROVIDER_CLIENTS.pop(turn_id, None)
    if client is None:
        return False
    close = getattr(client, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass
    return True


def upload_asset_to_provider(
    asset_id: str,
    provider_id: str,
    model: str | None = None,
) -> dict[str, Any]:
    if provider_id not in MODEL_PROVIDERS:
        raise ValueError(f"unknown provider: {provider_id}")
    store = get_store()
    asset = store.get_asset(asset_id, include_storage_path=True)
    provider = MODEL_PROVIDERS[provider_id]
    resolved_model = model if isinstance(model, str) and model else provider.default_model
    if resolved_model not in provider.models:
        raise ValueError(f"model {resolved_model!r} is not configured for {provider.name}")

    if provider_id == "bailian":
        return _upload_bailian_temporary_asset(store, asset, provider, resolved_model)

    capabilities = provider_capabilities(provider_id)
    if not capabilities.files:
        raise ValueError(f"provider {provider_id!r} does not expose a configured Files API")
    ready_statuses = {"active", "processed", "ready"}
    failure_statuses = {"failed", "error", "cancelled", "canceled"}
    if (
        asset.get("provider") == provider_id
        and asset.get("provider_model") in {None, resolved_model}
        and asset.get("provider_file_id")
        and asset.get("status") in ready_statuses
    ):
        asset.pop("storage_path", None)
        return asset
    client = build_client(provider)
    file_id = (
        asset.get("provider_file_id")
        if asset.get("provider") == provider_id and asset.get("provider_model") in {None, resolved_model}
        else None
    )
    uploaded: Any = None
    if not file_id:
        with open(asset["storage_path"], "rb") as handle:
            uploaded = client.files.create(
                file=handle,
                purpose=os.getenv("DOUBAO_FILE_PURPOSE", "user_data"),
            )
        file_id = getattr(uploaded, "id", None)
    if not isinstance(file_id, str) or not file_id:
        raise RuntimeError("provider Files API did not return a file id")

    status = getattr(uploaded, "status", None) if uploaded is not None else asset.get("status")
    attempts = max(1, int(os.getenv("CIRCUIT_FILE_POLL_ATTEMPTS", "20")))
    interval = max(0.0, float(os.getenv("CIRCUIT_FILE_POLL_INTERVAL", "0.25")))
    for attempt in range(attempts):
        if status in ready_statuses or status in failure_statuses:
            break
        remote = client.files.retrieve(file_id)
        status = getattr(remote, "status", None) or status or "processing"
        if status not in ready_statuses and status not in failure_statuses and attempt + 1 < attempts:
            time.sleep(interval)
    normalized_status = status if isinstance(status, str) and status else "processing"
    updated = store.update_asset_provider(
        asset_id,
        provider=provider_id,
        provider_model=resolved_model,
        provider_file_id=file_id,
        status=normalized_status,
    )
    if normalized_status in failure_statuses:
        raise RuntimeError(f"provider file processing failed with status {normalized_status}")
    return updated


def _upload_bailian_temporary_asset(
    store: ConversationStore,
    asset: dict[str, Any],
    provider: ModelProvider,
    model: str,
) -> dict[str, Any]:
    if (
        asset.get("provider") == provider.id
        and asset.get("provider_model") == model
        and isinstance(asset.get("provider_file_id"), str)
        and asset["provider_file_id"].startswith("oss://")
        and _expiry_is_reusable(asset.get("expires_at"))
    ):
        asset.pop("storage_path", None)
        return asset

    api_key = provider.api_key()
    if not api_key:
        raise RuntimeError("Missing 阿里百炼 API key for temporary asset upload")
    timeout = max(1.0, float(os.getenv("CIRCUIT_ASSET_UPLOAD_TIMEOUT", "30")))
    policy_url = "https://dashscope.aliyuncs.com/api/v1/uploads?" + urlencode(
        {"action": "getPolicy", "model": model}
    )
    policy_request = Request(
        policy_url,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="GET",
    )
    with urlopen(policy_request, timeout=timeout) as response:
        policy_payload = json.loads(response.read().decode("utf-8"))
    policy = policy_payload.get("data") if isinstance(policy_payload, dict) else None
    if not isinstance(policy, dict):
        raise RuntimeError("Bailian upload policy response did not include data")

    upload_host = policy.get("upload_host")
    upload_dir = policy.get("upload_dir")
    if not isinstance(upload_host, str) or not upload_host.startswith("https://"):
        raise RuntimeError("Bailian upload policy returned an invalid upload_host")
    if not isinstance(upload_dir, str) or not upload_dir:
        raise RuntimeError("Bailian upload policy returned an invalid upload_dir")

    filename = os.path.basename(asset["filename"])
    object_key = f"{upload_dir.rstrip('/')}/{filename}"
    fields = {
        "OSSAccessKeyId": policy.get("oss_access_key_id"),
        "Signature": policy.get("signature"),
        "policy": policy.get("policy"),
        "x-oss-object-acl": policy.get("x_oss_object_acl"),
        "x-oss-forbid-overwrite": policy.get("x_oss_forbid_overwrite"),
        "key": object_key,
        "success_action_status": "200",
    }
    if any(not isinstance(value, str) or not value for value in fields.values()):
        raise RuntimeError("Bailian upload policy is missing required OSS fields")
    with open(asset["storage_path"], "rb") as handle:
        body, content_type = _multipart_form_body(fields, filename, asset["mime_type"], handle.read())
    upload_request = Request(
        upload_host,
        data=body,
        headers={"Content-Type": content_type, "Content-Length": str(len(body))},
        method="POST",
    )
    with urlopen(upload_request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"Bailian temporary OSS upload failed with status {response.status}")

    expires_at = (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat()
    return store.update_asset_provider(
        asset["id"],
        provider=provider.id,
        provider_model=model,
        provider_file_id=f"oss://{object_key}",
        status="active",
        expires_at=expires_at,
    )


def _multipart_form_body(
    fields: dict[str, str],
    filename: str,
    mime_type: str,
    file_data: bytes,
) -> tuple[bytes, str]:
    boundary = f"----circuit-agent-{os.urandom(12).hex()}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            value.encode("utf-8"),
            b"\r\n",
        ])
    safe_filename = filename.replace('"', "_")
    chunks.extend([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{safe_filename}"\r\n'.encode(),
        f"Content-Type: {mime_type}\r\n\r\n".encode(),
        file_data,
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _expiry_is_reusable(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        expires_at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at > datetime.now(timezone.utc) + timedelta(minutes=5)


def create_conversation(payload: dict[str, Any]) -> dict[str, Any]:
    provider = resolve_provider(payload)
    model = resolve_model(provider, payload)
    reasoning_mode = normalize_reasoning_mode(payload.get("reasoning_mode"))
    canvas_state = payload.get("canvas_state")
    return get_store().create_conversation(
        title=payload.get("title") if isinstance(payload.get("title"), str) else "新建电路",
        provider=provider.id,
        model=model,
        reasoning_mode=reasoning_mode,
        canvas_state=canvas_state,
    )


def update_conversation_settings(conversation_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    store = get_store()
    current = store.get_conversation(conversation_id)
    changes = dict(payload)
    if "model_provider" in changes and "provider" not in changes:
        changes["provider"] = changes.pop("model_provider")
    if "reasoning_mode" in changes:
        changes["reasoning_mode"] = normalize_reasoning_mode(changes["reasoning_mode"])
    if "provider" in changes or "model" in changes:
        provider_id = changes.get("provider", current["provider"])
        if provider_id not in MODEL_PROVIDERS:
            raise ValueError(f"unknown provider: {provider_id}")
        provider = MODEL_PROVIDERS[provider_id]
        requested_model = changes.get("model")
        if not isinstance(requested_model, str) or not requested_model:
            requested_model = current["model"] if provider_id == current["provider"] else provider.default_model
        if requested_model not in provider.models:
            raise ValueError(f"model {requested_model!r} is not configured for {provider.name}")
        changes["provider"] = provider_id
        changes["model"] = requested_model
        if provider_id != current["provider"] or requested_model != current["model"]:
            changes["previous_response_id"] = None
    return store.update_conversation(conversation_id, changes)


def _record_model_result(
    *,
    conversation_id: str,
    turn_id: str,
    messages: list[dict[str, Any]],
    result: dict[str, Any],
    current_usage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    store = get_store()
    latest_turn = store.get_turn(turn_id)
    if latest_turn["status"] == "stopped":
        return turn_response(latest_turn, messages=messages, events=store.list_events(conversation_id, turn_id=turn_id))

    assistant_message = result["assistant_message"]
    tool_calls = result.get("tool_calls", [])
    store.append_event(conversation_id, "assistant.message", assistant_message, turn_id=turn_id, role="assistant")
    if result.get("reasoning_summary"):
        store.append_event(
            conversation_id,
            "reasoning.summary.delta",
            {"text": result["reasoning_summary"]},
            turn_id=turn_id,
        )
    for tool_call in tool_calls:
        store.append_event(conversation_id, "tool.call", tool_call, turn_id=turn_id)

    usage = result.get("usage", {})
    if current_usage:
        totals = merge_usage([current_usage, usage])
        totals["context_window"] = usage.get("context_window")
        totals["context_ratio"] = usage.get("context_ratio")
        usage = totals
    store.append_event(conversation_id, "usage.updated", usage, turn_id=turn_id)
    status = "requires_action" if tool_calls else "completed"
    turn = store.update_turn(
        turn_id,
        status=status,
        protocol=result["protocol"],
        previous_response_id=result.get("response_id"),
        usage=usage,
        reasoning_summary=result.get("reasoning_summary", ""),
    )
    event_type = "step.completed" if tool_calls else "turn.completed"
    store.append_event(conversation_id, event_type, {"status": status}, turn_id=turn_id)
    if status == "completed":
        refresh_conversation_summary(conversation_id)
    messages = messages + [assistant_message]
    return turn_response(
        turn,
        assistant_message=assistant_message,
        tool_calls=tool_calls,
        messages=messages,
        events=store.list_events(conversation_id, turn_id=turn_id),
        reasoning_degraded=bool(result.get("reasoning_degraded")),
    )


def start_conversation_turn(conversation_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    store = get_store()
    conversation = store.get_conversation(conversation_id)
    provider_payload = dict(payload)
    provider_payload.setdefault("model_provider", conversation["provider"])
    provider_payload.setdefault("model", conversation["model"])
    provider = resolve_provider(provider_payload)
    model = resolve_model(provider, provider_payload)
    reasoning_mode = normalize_reasoning_mode(payload.get("reasoning_mode", conversation["reasoning_mode"]))
    raw_message = payload.get("message")
    image = normalize_image_payload(payload.get("image"))
    asset: dict[str, Any] | None = None
    asset_id = payload.get("asset_id")
    if asset_id is not None:
        if not isinstance(asset_id, str) or not asset_id:
            raise ValueError("asset_id must be a non-empty string")
        asset = store.get_asset(asset_id, include_storage_path=True)
        if asset["conversation_id"] not in {None, conversation_id}:
            raise ValueError("asset belongs to another conversation")
    if (not isinstance(raw_message, str) or not raw_message.strip()) and image is None and asset is None:
        raise ValueError("message must be a non-empty string when no image is provided")
    user_text = raw_message.strip() if isinstance(raw_message, str) else ""
    allow_clear = is_explicit_clear_request(user_text)
    requested_turn_id = payload.get("turn_id")
    if requested_turn_id is not None and (
        not isinstance(requested_turn_id, str)
        or re.fullmatch(r"turn_[A-Za-z0-9_-]+", requested_turn_id) is None
    ):
        raise ValueError("turn_id must start with 'turn_' and contain only letters, numbers, '_' or '-'")

    provider_changed = provider.id != conversation["provider"] or model != conversation["model"]
    if provider_changed:
        conversation = store.update_conversation(
            conversation_id,
            {"provider": provider.id, "model": model, "reasoning_mode": reasoning_mode, "previous_response_id": None},
        )
    elif reasoning_mode != conversation["reasoning_mode"]:
        conversation = store.update_conversation(conversation_id, {"reasoning_mode": reasoning_mode})

    turn = store.create_turn(
        conversation_id,
        provider=provider.id,
        model=model,
        clear_allowed=allow_clear,
        turn_id=requested_turn_id,
    )
    turn_id = turn["turn_id"]
    store.append_event(conversation_id, "turn.started", {"status": "running"}, turn_id=turn_id)
    history = _history_messages(conversation_id)
    canvas_state = payload.get("model_canvas_state", payload.get("canvas_state", conversation["canvas_state"]))
    canvas_bounds = payload.get("canvas_bounds", {"width": 1000, "height": 1000})
    prefer_responses = payload.get("prefer_responses") is not False
    asset_is_remote_ready = bool(
        asset
        and asset.get("provider") == provider.id
        and asset.get("provider_model") in {None, model}
        and asset.get("provider_file_id")
        and asset.get("status") in {"active", "processed", "ready"}
    )
    uses_doubao_file = asset_is_remote_ready and provider.id == "doubao" and prefer_responses
    uses_bailian_oss = (
        asset_is_remote_ready
        and provider.id == "bailian"
        and isinstance(asset.get("provider_file_id"), str)
        and asset["provider_file_id"].startswith("oss://")
        and _expiry_is_reusable(asset.get("expires_at"))
    )
    # Bailian's documented temporary OSS channel is verified on the Chat
    # compatible endpoint. Keep image turns on that protocol for now.
    if uses_bailian_oss:
        prefer_responses = False
    if asset is None:
        user_content = make_user_message_content(user_text, canvas_state, canvas_bounds, image)
    else:
        text_content = make_user_content(user_text, canvas_state, canvas_bounds, asset)
        if uses_doubao_file:
            image_part = {"type": "input_image", "file_id": asset["provider_file_id"]}
        elif uses_bailian_oss:
            image_part = {
                "type": "image_url",
                "image_url": {"url": asset["provider_file_id"]},
            }
        else:
            with open(asset["storage_path"], "rb") as handle:
                encoded = base64.b64encode(handle.read()).decode("ascii")
            image_part = {
                "type": "image_url",
                "image_url": {"url": f"data:{asset['mime_type']};base64,{encoded}"},
            }
        user_content = [{"type": "text", "text": text_content}, image_part]
    user_message = {"role": "user", "content": user_content}
    store.append_event(conversation_id, "user.message", user_message, turn_id=turn_id, role="user")
    messages = [{"role": "system", "content": system_prompt_for_conversation(conversation)}] + history + [user_message]
    previous_response_id = None if provider_changed or uses_bailian_oss else conversation.get("previous_response_id")
    if uses_bailian_oss and conversation.get("previous_response_id"):
        store.update_conversation(conversation_id, {"previous_response_id": None})
    try:
        result = _invoke_provider(
            provider=provider,
            model=model,
            messages=_responses_rebuild_messages(messages),
            allow_clear=allow_clear,
            require_tool=payload.get("require_tool") is not False,
            reasoning_mode=reasoning_mode,
            prefer_responses=prefer_responses,
            previous_response_id=previous_response_id,
            allow_chat_fallback=False,
            turn_id=turn_id,
            conversation_id=conversation_id,
        )
    except Exception:
        if not previous_response_id:
            latest = store.get_turn(turn_id)
            if latest["status"] == "stopped":
                return turn_response(
                    latest,
                    messages=messages,
                    events=store.list_events(conversation_id, turn_id=turn_id),
                )
            store.update_turn(turn_id, status="error", error="model_request_failed")
            store.append_event(conversation_id, "turn.error", {"error": "model_request_failed"}, turn_id=turn_id)
            raise
        # A stored provider response can expire. Rebuild from the compact local
        # history before any canvas tool has executed, so this retry is safe.
        store.update_conversation(conversation_id, {"previous_response_id": None})
        try:
            result = _invoke_provider(
                provider=provider,
                model=model,
                messages=_responses_rebuild_messages(messages),
                allow_clear=allow_clear,
                require_tool=payload.get("require_tool") is not False,
                reasoning_mode=reasoning_mode,
                prefer_responses=prefer_responses,
                previous_response_id=None,
                allow_chat_fallback=False,
                turn_id=turn_id,
                conversation_id=conversation_id,
            )
        except Exception:
            latest = store.get_turn(turn_id)
            if latest["status"] == "stopped":
                return turn_response(
                    latest,
                    messages=messages,
                    events=store.list_events(conversation_id, turn_id=turn_id),
                )
            store.update_turn(turn_id, status="error", error="model_request_failed")
            store.append_event(
                conversation_id, "turn.error", {"error": "model_request_failed"}, turn_id=turn_id
            )
            raise

    response = _record_model_result(
        conversation_id=conversation_id,
        turn_id=turn_id,
        messages=messages,
        result=result,
    )
    if response["status"] != "stopped":
        store.update_conversation(
            conversation_id,
            {"previous_response_id": result.get("response_id") if result["protocol"] == "responses" else None},
        )
    return response


def normalize_tool_outputs(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        raise ValueError("tool_outputs must be a non-empty array")
    outputs: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("each tool output must be an object")
        call_id = item.get("tool_call_id", item.get("call_id"))
        if not isinstance(call_id, str) or not call_id:
            raise ValueError("each tool output requires tool_call_id")
        content = item.get("content", item.get("output", ""))
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False)
        outputs.append({"tool_call_id": call_id, "content": content})
    return outputs


def build_visual_review_input(
    conversation_id: str,
    provider_id: str,
    model: str,
    protocol: str,
    value: Any,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if value is None or value == []:
        return None, None
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise ValueError("visual_asset_ids must be an array of asset ids")
    if len(value) > 2:
        raise ValueError("at most two visual review assets are allowed per continuation")

    response_parts: list[dict[str, Any]] = [
        {"type": "input_text", "text": "Visually review this current canvas screenshot against the user request. Continue correcting only if needed."}
    ]
    chat_parts: list[dict[str, Any]] = [
        {"type": "text", "text": "Visually review this current canvas screenshot against the user request. Continue correcting only if needed."}
    ]
    for asset_id in value:
        asset = get_store().get_asset(asset_id)
        if asset["conversation_id"] not in {None, conversation_id}:
            raise ValueError("visual review asset belongs to another conversation")
        if (
            asset.get("provider") != provider_id
            or asset.get("provider_model") not in {None, model}
            or asset.get("status") not in {"active", "processed", "ready"}
            or not isinstance(asset.get("provider_file_id"), str)
        ):
            raise ValueError("visual review asset is not active for the current provider/model")
        reference = asset["provider_file_id"]
        if provider_id == "doubao":
            if protocol != "responses":
                raise ValueError("Doubao visual review requires an active Responses turn")
            response_parts.append({"type": "input_image", "file_id": reference})
        elif provider_id == "bailian":
            if not reference.startswith("oss://") or not _expiry_is_reusable(asset.get("expires_at")):
                raise ValueError("Bailian visual review asset has expired")
            response_parts.append({"type": "input_image", "image_url": reference})
            chat_parts.append({"type": "image_url", "image_url": {"url": reference}})
        else:
            raise ValueError(f"visual review is unsupported for provider {provider_id}")

    response_item = {"role": "user", "content": response_parts}
    chat_message = {"role": "user", "content": chat_parts} if len(chat_parts) > 1 else None
    return response_item, chat_message


def continue_turn(turn_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    store = get_store()
    turn = store.get_turn(turn_id)
    if turn["status"] == "stopped":
        return turn_response(turn, events=store.list_events(turn["conversation_id"], turn_id=turn_id))
    if turn["status"] not in {"requires_action", "running"}:
        raise ValueError(f"turn cannot continue from status {turn['status']}")

    outputs = normalize_tool_outputs(payload.get("tool_outputs"))
    tool_count = turn["tool_count"] + len(outputs)
    if tool_count > 160:
        turn = store.cancel_turn(turn_id, "tool_limit")
        store.append_event(turn["conversation_id"], "turn.stopped", {"reason": "tool_limit"}, turn_id=turn_id)
        return turn_response(turn, events=store.list_events(turn["conversation_id"], turn_id=turn_id))

    saved_canvas_revision: int | None = None
    if "canvas_state" in payload:
        expected_revision = payload.get("canvas_revision")
        if expected_revision is not None and not isinstance(expected_revision, int):
            raise ValueError("canvas_revision must be an integer")
        snapshot = store.put_canvas(
            turn["conversation_id"],
            payload["canvas_state"],
            expected_revision=expected_revision,
        )
        saved_canvas_revision = snapshot["canvas_revision"]
    for output in outputs:
        store.append_event(
            turn["conversation_id"], "tool.result", output, turn_id=turn_id, role="tool"
        )

    provider = MODEL_PROVIDERS[turn["provider"]]
    conversation = store.get_conversation(turn["conversation_id"])
    messages = [{"role": "system", "content": system_prompt_for_conversation(conversation)}] + _history_messages(
        turn["conversation_id"], turn_id=turn_id
    )
    response_visual_input, chat_visual_message = build_visual_review_input(
        turn["conversation_id"],
        turn["provider"],
        turn["model"],
        turn["protocol"],
        payload.get("visual_asset_ids"),
    )
    if chat_visual_message is not None:
        messages.append(chat_visual_message)
        store.append_event(
            turn["conversation_id"],
            "visual.review",
            chat_visual_message,
            turn_id=turn_id,
            role="user",
        )
    try:
        result = _invoke_provider(
            provider=provider,
            model=turn["model"],
            messages=messages,
            allow_clear=turn["clear_allowed"],
            require_tool=payload.get("require_tool") is not False,
            reasoning_mode=conversation["reasoning_mode"],
            prefer_responses=turn["protocol"] == "responses",
            previous_response_id=turn.get("previous_response_id") if turn["protocol"] == "responses" else None,
            tool_outputs=outputs if turn["protocol"] == "responses" else None,
            additional_input_items=[response_visual_input] if response_visual_input is not None else None,
            allow_chat_fallback=False,
            turn_id=turn_id,
            conversation_id=turn["conversation_id"],
        )
    except Exception:
        latest = store.get_turn(turn_id)
        if latest["status"] == "stopped":
            return turn_response(
                latest,
                messages=messages,
                events=store.list_events(turn["conversation_id"], turn_id=turn_id),
            )
        store.update_turn(turn_id, status="error", error="model_request_failed")
        store.append_event(
            turn["conversation_id"], "turn.error", {"error": "model_request_failed"}, turn_id=turn_id
        )
        raise
    store.update_turn(turn_id, tool_count=tool_count)
    response = _record_model_result(
        conversation_id=turn["conversation_id"],
        turn_id=turn_id,
        messages=messages,
        result=result,
        current_usage=turn.get("usage"),
    )
    if saved_canvas_revision is not None:
        response["canvas_revision"] = saved_canvas_revision
    if response["status"] != "stopped":
        store.update_conversation(
            turn["conversation_id"],
            {"previous_response_id": result.get("response_id") if result["protocol"] == "responses" else None},
        )
    return response


def cancel_turn(turn_id: str) -> dict[str, Any]:
    store = get_store()
    before = store.get_turn(turn_id)
    abort_active_provider_request(turn_id)
    turn = store.cancel_turn(turn_id)
    if before["status"] != turn["status"]:
        store.append_event(
            turn["conversation_id"], "turn.stopped", {"reason": turn["stop_reason"]}, turn_id=turn_id
        )
    return turn_response(turn, events=store.list_events(turn["conversation_id"], turn_id=turn_id))


def turn_response(
    turn: dict[str, Any],
    *,
    assistant_message: dict[str, Any] | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
    messages: list[dict[str, Any]] | None = None,
    events: list[dict[str, Any]] | None = None,
    reasoning_degraded: bool = False,
) -> dict[str, Any]:
    return {
        "turn_id": turn["turn_id"],
        "conversation_id": turn["conversation_id"],
        "status": turn["status"],
        "provider": turn["provider"],
        "model": turn["model"],
        "protocol": turn["protocol"],
        "assistant_message": assistant_message,
        "tool_calls": tool_calls or [],
        "messages": sanitize_for_storage(messages or []),
        "usage": turn.get("usage", {}),
        "reasoning_summary": turn.get("reasoning_summary", ""),
        "reasoning_degraded": reasoning_degraded,
        "clear_allowed": turn["clear_allowed"],
        "stop_reason": turn.get("stop_reason"),
        "events": events or [],
    }


def update_debug_messages(payload: dict[str, Any]) -> dict[str, Any]:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        raise ValueError("messages must be an array")

    snapshot = {
        "updated_at": datetime.now().astimezone().isoformat(),
        "provider": payload.get("provider") if isinstance(payload.get("provider"), str) else "",
        "model": payload.get("model") if isinstance(payload.get("model"), str) else "",
        "messages": sanitize_for_storage(messages),
    }

    os.makedirs(os.path.dirname(DEBUG_MESSAGES_PATH), exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=os.path.dirname(DEBUG_MESSAGES_PATH), delete=False) as handle:
        tmp_path = handle.name
        json.dump(snapshot, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp_path, DEBUG_MESSAGES_PATH)

    return {
        "status": "updated",
        "path": DEBUG_MESSAGES_PATH,
        "messages": len(messages),
        "updated_at": snapshot["updated_at"],
    }


def scrub_legacy_debug_snapshots(directory: str | None = None) -> int:
    """Remove inline data URLs left by older demo builds.

    Current writes are already sanitized at the persistence boundary.  This
    one-time startup migration keeps archived ``messages*.json`` snapshots from
    retaining payloads created before that guard existed.
    """

    snapshots_dir = directory or os.path.dirname(DEBUG_MESSAGES_PATH)
    if not os.path.isdir(snapshots_dir):
        return 0

    updated = 0
    for name in os.listdir(snapshots_dir):
        if not (name.startswith("messages") and name.endswith(".json")):
            continue
        path = os.path.join(snapshots_dir, name)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue

        sanitized = sanitize_for_storage(payload)
        if sanitized == payload:
            continue
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=snapshots_dir, delete=False
        ) as handle:
            tmp_path = handle.name
            json.dump(sanitized, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(tmp_path, path)
        updated += 1
    return updated


def _stream_event(event: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    event_type = str(event.get("type", "step.completed"))
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    if event_type == "assistant.message" and isinstance(data.get("content"), str):
        event_type = "assistant.text.delta"
        data = {"text": data["content"]}
    return event_type, {
        "id": event.get("id"),
        "conversation_id": event.get("conversation_id"),
        "turn_id": event.get("turn_id"),
        "type": event_type,
        "payload": data,
        "created_at": event.get("created_at"),
    }


class CircuitAgentHandler(BaseHTTPRequestHandler):
    server_version = "CircuitAgentHTTP/0.2"

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._send_common_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/health":
                get_store()
                context_recorder = get_context_recorder()
                self._send_json({
                    "ok": True,
                    "default_provider": DEFAULT_PROVIDER,
                    "default_model": MODEL_PROVIDERS[DEFAULT_PROVIDER].default_model,
                    "models": list_model_options(),
                    "components": get_registry_summary(),
                    "storage": {"kind": "sqlite", "ready": True},
                    "context_history": {
                        "enabled": context_recorder is not None,
                        "path": str(context_recorder.root) if context_recorder else None,
                        "complete": context_recorder is not None,
                        "no_truncation": context_recorder is not None,
                    },
                })
                return
            if path == "/api/models":
                self._send_json(list_model_options())
                return
            if path == "/api/components/catalog":
                self._send_json(get_component_catalog())
                return
            if path == "/api/conversations":
                self._send_json({"items": get_store().list_conversations()})
                return
            match = re.fullmatch(r"/api/conversations/([A-Za-z0-9_-]+)", path)
            if match:
                self._send_json(get_store().get_conversation(match.group(1)))
                return
            match = re.fullmatch(r"/api/conversations/([A-Za-z0-9_-]+)/events", path)
            if match:
                query = parse_qs(parsed.query)
                after_id = int(query.get("after_id", ["0"])[0])
                limit = int(query.get("limit", ["500"])[0])
                self._send_json({
                    "items": get_store().list_events(match.group(1), after_id=after_id, limit=limit)
                })
                return
            match = re.fullmatch(r"/api/turns/([A-Za-z0-9_-]+)", path)
            if match:
                turn = get_store().get_turn(match.group(1))
                self._send_json(turn_response(
                    turn,
                    events=get_store().list_events(turn["conversation_id"], turn_id=turn["turn_id"]),
                ))
                return
            match = re.fullmatch(r"/api/assets/([A-Za-z0-9_-]+)", path)
            if match:
                asset = get_store().get_asset(match.group(1))
                asset["url"] = f"/api/assets/{asset['id']}/content"
                self._send_json(asset)
                return
            match = re.fullmatch(r"/api/assets/([A-Za-z0-9_-]+)/content", path)
            if match:
                asset = get_store().get_asset(match.group(1), include_storage_path=True)
                with open(asset["storage_path"], "rb") as handle:
                    self._send_bytes(handle.read(), asset["mime_type"])
                return
            self.send_error(404, "Not Found")
        except Exception as error:
            self._handle_error(error)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/assets":
                fields, upload = self._read_multipart()
                conversation_id = fields.get("conversation_id") or None
                asset = get_store().save_asset(
                    upload["data"],
                    filename=upload["filename"],
                    mime_type=upload["mime_type"],
                    conversation_id=conversation_id,
                )
                provider_id = fields.get("provider", "")
                upload_requested = fields.get("upload_to_provider", "").strip().lower() in {
                    "1", "true", "yes", "on"
                }
                provider_upload_error = ""
                if upload_requested:
                    if not provider_id:
                        raise ValueError("provider is required when upload_to_provider is true")
                    try:
                        asset = upload_asset_to_provider(asset["id"], provider_id, fields.get("model") or None)
                    except Exception as error:
                        # Keep the local hashed asset usable as a one-request
                        # fallback when a provider upload is temporarily down.
                        provider_upload_error = str(error)
                        asset = get_store().get_asset(asset["id"])
                asset["url"] = f"/api/assets/{asset['id']}/content"
                asset["provider_upload"] = {
                    "status": "failed" if provider_upload_error else asset["status"] if upload_requested else "not_requested",
                    "supported": provider_capabilities(provider_id).files,
                    "error": provider_upload_error or None,
                }
                self._send_json(asset, status=201)
                return

            payload = self._read_json(allow_empty=True)
            if path == "/api/circuit-agent":
                result = call_agent(payload)
            elif path == "/api/models":
                result = list_model_options()
            elif path == "/api/components/catalog":
                result = get_component_catalog()
            elif path == "/api/components/detail":
                names = payload.get("names")
                if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
                    raise ValueError("names must be an array of strings")
                result = get_component_detail(names)
            elif path == "/api/debug/messages":
                result = update_debug_messages(payload)
            elif path == "/api/conversations":
                self._send_json(create_conversation(payload), status=201)
                return
            else:
                match = re.fullmatch(r"/api/conversations/([A-Za-z0-9_-]+)/turns", path)
                if match:
                    if "text/event-stream" in self.headers.get("Accept", ""):
                        turn_id = payload.get("turn_id")
                        if not isinstance(turn_id, str) or not turn_id:
                            turn_id = f"turn_{uuid.uuid4().hex}"
                            payload["turn_id"] = turn_id
                        conversation_id = match.group(1)
                        self._send_turn_stream(
                            conversation_id,
                            turn_id,
                            lambda: start_conversation_turn(conversation_id, payload),
                        )
                        return
                    result = start_conversation_turn(match.group(1), payload)
                    self._send_json(result, status=201)
                    return
                match = re.fullmatch(r"/api/turns/([A-Za-z0-9_-]+)/continue", path)
                if match:
                    turn_id = match.group(1)
                    if "text/event-stream" in self.headers.get("Accept", ""):
                        turn = get_store().get_turn(turn_id)
                        existing = get_store().list_events(
                            turn["conversation_id"], turn_id=turn_id, limit=1000
                        )
                        after_id = max((event["id"] for event in existing), default=0)
                        self._send_turn_stream(
                            turn["conversation_id"],
                            turn_id,
                            lambda: continue_turn(turn_id, payload),
                            after_id=after_id,
                        )
                        return
                    result = continue_turn(turn_id, payload)
                else:
                    match = re.fullmatch(r"/api/turns/([A-Za-z0-9_-]+)/cancel", path)
                    if match:
                        result = cancel_turn(match.group(1))
                    else:
                        self.send_error(404, "Not Found")
                        return
            self._send_json(result)
        except Exception as error:
            self._handle_error(error)

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        try:
            payload = self._read_json()
            match = re.fullmatch(r"/api/conversations/([A-Za-z0-9_-]+)/canvas", path)
            if not match:
                self.send_error(404, "Not Found")
                return
            if "canvas_state" not in payload:
                raise ValueError("canvas_state is required")
            expected_revision = payload.get("canvas_revision")
            if expected_revision is not None and not isinstance(expected_revision, int):
                raise ValueError("canvas_revision must be an integer")
            self._send_json(get_store().put_canvas(
                match.group(1), payload["canvas_state"], expected_revision=expected_revision
            ))
        except Exception as error:
            self._handle_error(error)

    def do_PATCH(self) -> None:
        path = urlparse(self.path).path
        try:
            payload = self._read_json()
            match = re.fullmatch(r"/api/conversations/([A-Za-z0-9_-]+)", path)
            if not match:
                self.send_error(404, "Not Found")
                return
            self._send_json(update_conversation_settings(match.group(1), payload))
        except Exception as error:
            self._handle_error(error)

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        try:
            match = re.fullmatch(r"/api/conversations/([A-Za-z0-9_-]+)", path)
            if not match:
                self.send_error(404, "Not Found")
                return
            get_store().delete_conversation(match.group(1))
            self._send_json({"deleted": True, "id": match.group(1)})
        except Exception as error:
            self._handle_error(error)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}")

    def _read_json(self, *, allow_empty: bool = False) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)
        if not raw_body and allow_empty:
            return {}
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid JSON request body: {error.msg}") from error
        if not isinstance(payload, dict):
            raise ValueError("request body must be a JSON object")
        return payload

    def _read_multipart(self) -> tuple[dict[str, str], dict[str, Any]]:
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data"):
            raise ValueError("asset upload requires multipart/form-data")
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            raise ValueError("asset upload is empty")
        if content_length > MAX_ASSET_BYTES + 1024 * 1024:
            raise ValueError(f"asset upload exceeds {MAX_ASSET_BYTES} bytes")
        raw_body = self.rfile.read(content_length)
        envelope = (
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + raw_body
        )
        message = BytesParser(policy=email_policy).parsebytes(envelope)
        fields: dict[str, str] = {}
        upload: dict[str, Any] | None = None
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            filename = part.get_filename()
            data = part.get_payload(decode=True) or b""
            if filename:
                if len(data) > MAX_ASSET_BYTES:
                    raise ValueError(f"asset upload exceeds {MAX_ASSET_BYTES} bytes")
                mime_type = part.get_content_type()
                if not mime_type.startswith("image/"):
                    raise ValueError("only image assets are supported")
                upload = {"filename": filename, "mime_type": mime_type, "data": data}
            elif isinstance(name, str):
                fields[name] = data.decode(part.get_content_charset() or "utf-8")
        if upload is None or not upload["data"]:
            raise ValueError("multipart field 'file' is required")
        return fields, upload

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self._send_common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_turn_stream(
        self,
        conversation_id: str,
        turn_id: str,
        operation,
        *,
        after_id: int = 0,
    ) -> None:
        self.send_response(200)
        self._send_common_headers()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True

        outcome: dict[str, Any] = {}
        finished = threading.Event()

        def run_operation() -> None:
            try:
                outcome["result"] = operation()
            except Exception as error:
                outcome["error"] = error
            finally:
                finished.set()

        threading.Thread(target=run_operation, daemon=True).start()
        last_event_id = after_id
        connected = True
        while connected:
            events = get_store().list_events(
                conversation_id,
                turn_id=turn_id,
                after_id=last_event_id,
                limit=500,
            )
            for event in events:
                last_event_id = max(last_event_id, int(event["id"]))
                if event.get("type") == "visual.review":
                    continue
                event_name, payload = _stream_event(event)
                connected = self._write_sse(event_name, payload)
                if not connected:
                    break
            if not connected or finished.is_set():
                break
            finished.wait(0.05)

        if not connected:
            return
        # Flush events appended between the last poll and operation completion.
        for event in get_store().list_events(
            conversation_id,
            turn_id=turn_id,
            after_id=last_event_id,
            limit=500,
        ):
            last_event_id = max(last_event_id, int(event["id"]))
            if event.get("type") == "visual.review":
                continue
            event_name, payload = _stream_event(event)
            if not self._write_sse(event_name, payload):
                return

        error = outcome.get("error")
        if isinstance(error, Exception):
            self._write_sse(
                "turn.error",
                {"turn_id": turn_id, "conversation_id": conversation_id, "error": str(error)},
            )
            return
        result = outcome.get("result")
        if not isinstance(result, dict):
            self._write_sse(
                "turn.error",
                {"turn_id": turn_id, "conversation_id": conversation_id, "error": "empty turn result"},
            )
            return
        final_event = {
            "requires_action": "step.completed",
            "completed": "turn.completed",
            "stopped": "turn.stopped",
            "error": "turn.error",
        }.get(result.get("status"), "step.completed")
        self._write_sse(final_event, result)

    def _write_sse(self, event_name: str, payload: dict[str, Any]) -> bool:
        encoded = (
            f"event: {event_name}\n"
            f"data: {json.dumps(sanitize_for_storage(payload), ensure_ascii=False, separators=(',', ':'))}\n\n"
        ).encode("utf-8")
        try:
            self.wfile.write(encoded)
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError):
            return False

    def _send_bytes(self, payload: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self._send_common_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "private, max-age=3600")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _handle_error(self, error: Exception) -> None:
        if isinstance(error, NotFoundError):
            status = 404
        elif isinstance(error, RevisionConflictError):
            status = 409
        elif isinstance(error, (ValueError, StoreError)):
            status = 400
        else:
            status = 500
        self._send_json({"error": str(error), "error_type": error.__class__.__name__}, status=status)

    def _send_common_headers(self) -> None:
        self.send_header(
            "Access-Control-Allow-Origin",
            os.getenv("CIRCUIT_ALLOWED_ORIGIN", "http://localhost:5178"),
        )
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")


def main() -> None:
    scrubbed_snapshots = scrub_legacy_debug_snapshots()
    context_recorder = get_context_recorder()
    server = ThreadingHTTPServer((HOST, PORT), CircuitAgentHandler)
    print(f"Circuit agent API listening on http://{HOST}:{PORT}")
    print(f"LangSmith tracing={os.getenv('LANGSMITH_TRACING')} project={os.getenv('LANGSMITH_PROJECT')}")
    for provider in MODEL_PROVIDERS.values():
        status = "ready" if provider.api_key() else f"missing {'/'.join(provider.api_key_envs)}"
        print(f"Provider {provider.id}: default_model={provider.default_model} base_url={provider.base_url} {status}")
    if scrubbed_snapshots:
        print(f"Sanitized {scrubbed_snapshots} legacy debug snapshot(s)")
    if context_recorder:
        print(f"Full model context history: {context_recorder.root}")
    else:
        print("Full model context history: disabled")
    server.serve_forever()


if __name__ == "__main__":
    main()
