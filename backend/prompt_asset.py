from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
PROMPT_BLOCK_RE = re.compile(
    r"<!--\s*prompt:(?P<name>[a-zA-Z0-9_-]+):start\s*-->\s*"
    r"(?P<content>.*?)"
    r"\s*<!--\s*prompt:(?P=name):end\s*-->",
    re.DOTALL,
)
VARIABLE_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")


@dataclass(frozen=True)
class PromptAsset:
    path: Path
    metadata: dict[str, Any]
    blocks: dict[str, str]


def load_prompt_asset(path: Path) -> PromptAsset:
    text = path.read_text(encoding="utf-8")
    frontmatter_match = FRONTMATTER_RE.match(text)
    if frontmatter_match is None:
        raise ValueError(f"Prompt frontmatter is required: {path}")

    metadata = yaml.safe_load(frontmatter_match.group(1)) or {}
    if not isinstance(metadata, dict):
        raise ValueError(f"Prompt frontmatter must be a mapping: {path}")

    blocks = {
        match.group("name"): match.group("content").strip()
        for match in PROMPT_BLOCK_RE.finditer(text)
    }
    missing_blocks = {"system", "user"} - set(blocks)
    if missing_blocks:
        names = ", ".join(sorted(missing_blocks))
        raise ValueError(f"Prompt is missing required role blocks ({names}): {path}")

    declared_variables = {
        spec.get("name")
        for spec in metadata.get("variables", [])
        if isinstance(spec, dict) and isinstance(spec.get("name"), str)
    }
    referenced_variables = set().union(
        *(set(VARIABLE_RE.findall(block)) for block in blocks.values())
    )
    undeclared = referenced_variables - declared_variables
    if undeclared:
        names = ", ".join(sorted(undeclared))
        raise ValueError(f"Prompt references undeclared variables ({names}): {path}")

    return PromptAsset(path=path, metadata=metadata, blocks=blocks)


def render_prompt_block(asset: PromptAsset, block_name: str, variables: dict[str, Any]) -> str:
    if block_name not in asset.blocks:
        raise KeyError(f"Unknown prompt block: {block_name}")

    merged = dict(variables)
    for spec in asset.metadata.get("variables", []):
        if not isinstance(spec, dict):
            continue
        name = spec.get("name")
        if not isinstance(name, str) or name in merged:
            continue
        if spec.get("required") is False:
            merged[name] = spec.get("default", "")

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in merged:
            raise KeyError(f"Missing prompt variable: {name}")
        value = merged[name]
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False, indent=2)

    return VARIABLE_RE.sub(replace, asset.blocks[block_name]).strip()
