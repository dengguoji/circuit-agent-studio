from __future__ import annotations

import json
import os
import sys
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path
from typing import Any


COMPONENT_NS = "http://schemas.circuit-diagram.org/circuitDiagramDocument/2012/component/xml"
PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_COMPONENTS_DIR = PROJECT_ROOT / "assets" / "components-master"
DEFAULT_COMPONENT_LIST_PATH = PROJECT_ROOT / "assets" / "component_list.json"
CATALOG_HIDDEN_COMPONENTS = {"Wire"}
NATIVE_LABEL_PROPERTIES = {"Reference", "Text"}
UNIVERSAL_LABEL_ROLE = "universal-label"
UNIVERSAL_LABEL_PROPERTY = {
    "name": "Text",
    "type": "string",
    "default": "",
    "serialize": "text",
    "display": "Text",
    "options": [],
    "formatting": [],
}
UNIVERSAL_LABEL_SHAPES = [
    {
        "type": "text",
        "conditions": "horizontal,$Text",
        "autorotate": "Off",
        "attrs": {
            "value": "$Text",
            "x": "_Middle",
            "y": "_Middle-24y",
            "align": "BottomCentre",
            "data-role": UNIVERSAL_LABEL_ROLE,
        },
    },
    {
        "type": "text",
        "conditions": "!horizontal,$Text",
        "autorotate": "Off",
        "attrs": {
            "value": "$Text",
            "x": "_Middle+24x",
            "y": "_Middle",
            "align": "CentreLeft",
            "data-role": UNIVERSAL_LABEL_ROLE,
        },
    },
]
CANONICAL_FLAGS = {
    "horizontalonly": "HorizontalOnly",
    "verticalonly": "VerticalOnly",
    "middlemustalign": "MiddleMustAlign",
    "flipprimary": "FlipPrimary",
    "flipsecondary": "FlipSecondary",
}


def components_dir() -> Path:
    return Path(os.getenv("CIRCUIT_COMPONENTS_DIR", str(DEFAULT_COMPONENTS_DIR))).expanduser()


def component_list_path() -> Path:
    return Path(os.getenv("CIRCUIT_COMPONENT_LIST", str(DEFAULT_COMPONENT_LIST_PATH))).expanduser()


def _tag_name(elem: ET.Element) -> str:
    return elem.tag.split("}", 1)[1] if "}" in elem.tag else elem.tag


def _children(elem: ET.Element, tag: str | None = None) -> list[ET.Element]:
    result = []
    for child in elem:
        if tag is None or _tag_name(child) == tag:
            result.append(child)
    return result


def _find_child(elem: ET.Element, tag: str) -> ET.Element | None:
    for child in elem:
        if _tag_name(child) == tag:
            return child
    return None


def _normalize(value: str) -> str:
    return "".join(ch for ch in value.lower() if ch.isalnum())


def _parse_property(prop: ET.Element) -> dict[str, Any]:
    return {
        "name": prop.attrib.get("name", ""),
        "type": prop.attrib.get("type", ""),
        "default": prop.attrib.get("default", ""),
        "serialize": prop.attrib.get("serialize", ""),
        "display": prop.attrib.get("display", ""),
        "options": [(option.text or "") for option in _children(prop, "option")],
        "formatting": [
            {
                "conditions": fmt.attrib.get("conditions", ""),
                "value": fmt.attrib.get("value", ""),
            }
            for formatting in _children(prop, "formatting")
            for fmt in _children(formatting, "format")
        ],
    }


def _parse_configuration(config: ET.Element) -> dict[str, Any]:
    value = config.attrib.get("value", "")
    properties: dict[str, str] = {}
    for pair in value.split(","):
        if ":" not in pair:
            continue
        key, prop_value = pair.split(":", 1)
        properties[key.strip()] = prop_value.strip()

    return {
        "name": config.attrib.get("name", ""),
        "value": value,
        "implements": config.attrib.get("implements", ""),
        "properties": properties,
    }


def _parse_flags(declaration: ET.Element) -> list[str]:
    flags = _find_child(declaration, "flags")
    if flags is None:
        return []

    result: list[str] = []
    for child in flags:
        if _tag_name(child).lower() not in {"option", "flag"}:
            continue
        value = (child.text or "").strip()
        if not value:
            continue
        canonical = CANONICAL_FLAGS.get(value.lower(), value)
        if canonical not in result:
            result.append(canonical)
    return result

def _parse_definitions(root: ET.Element) -> dict[str, Any]:
    definitions = _find_child(root, "definitions")
    result: dict[str, Any] = {"consts": {}, "defs": {}}
    if definitions is None:
        return result

    for child in definitions:
        tag = _tag_name(child)
        name = child.attrib.get("name", "")
        if not name:
            continue
        if tag == "const":
            result["consts"][name] = child.attrib.get("value", "")
        elif tag == "def":
            result["defs"][name] = [
                {
                    "conditions": when.attrib.get("conditions", ""),
                    "value": when.attrib.get("value", ""),
                }
                for when in _children(child, "when")
            ]
    return result


def _merge_conditions(parent: str, child: str | None) -> str:
    child = child or ""
    if parent and child:
        return f"{parent},{child}"
    return parent or child


def _parse_connections(elem: ET.Element | None, inherited_conditions: str = "") -> list[dict[str, Any]]:
    if elem is None:
        return []

    points: list[dict[str, Any]] = []
    for child in elem:
        tag = _tag_name(child)
        conditions = _merge_conditions(inherited_conditions, child.attrib.get("conditions"))
        if tag == "connection":
            points.append(
                {
                    "name": child.attrib.get("name", ""),
                    "start": child.attrib.get("start", ""),
                    "end": child.attrib.get("end", ""),
                    "edge": child.attrib.get("edge", ""),
                    "conditions": conditions,
                }
            )
        elif tag in {"g", "group"}:
            points.extend(_parse_connections(child, conditions))
    return points


def _parse_render_shapes(elem: ET.Element | None, inherited_conditions: str = "") -> tuple[list[dict[str, Any]], list[str]]:
    if elem is None:
        return [], []

    shapes: list[dict[str, Any]] = []
    unsupported: list[str] = []

    for child in elem:
        tag = _tag_name(child)
        conditions = _merge_conditions(inherited_conditions, child.attrib.get("conditions"))
        if tag in {"g", "group"}:
            nested, nested_unsupported = _parse_render_shapes(child, conditions)
            shapes.extend(nested)
            unsupported.extend(nested_unsupported)
            continue

        if tag not in {"line", "rect", "ellipse", "path", "text"}:
            unsupported.append(tag)
            continue

        attrs = {key: value for key, value in child.attrib.items()}
        shape = {
            "type": tag,
            "conditions": conditions,
            "autorotate": child.attrib.get("autorotate", elem.attrib.get("autorotate", "")),
            "attrs": attrs,
        }
        shapes.append(shape)

    return shapes, unsupported


def _parse_component_xml(xml_path: Path, component_id: int | None) -> dict[str, Any]:
    tree = ET.parse(str(xml_path))
    root = tree.getroot()
    declaration = _find_child(root, "declaration")
    if declaration is None:
        raise ValueError(f"{xml_path}: missing declaration")

    meta = {
        item.attrib.get("name", ""): item.attrib.get("value", "")
        for item in _children(declaration, "meta")
        if item.attrib.get("name")
    }
    name = meta.get("name", xml_path.stem)
    minsize = meta.get("minsize", "40")
    properties = [_parse_property(prop) for prop in _children(declaration, "property")]
    configurations_el = _find_child(declaration, "configurations")
    configurations = [
        _parse_configuration(config)
        for config in (_children(configurations_el, "configuration") if configurations_el is not None else [])
    ]

    connections_el = _find_child(root, "connections")
    render_el = _find_child(root, "render")
    shapes, unsupported = _parse_render_shapes(render_el)
    if unsupported:
        joined = ", ".join(sorted(set(unsupported)))
        raise ValueError(f"{xml_path}: unsupported render tag(s): {joined}")

    category = xml_path.relative_to(components_dir()).parts[0]
    defaults = {prop["name"]: prop["default"] for prop in properties}
    aliases = [config["name"] for config in configurations if config["name"]]

    component = {
        "id": component_id,
        "name": name,
        "category": category,
        "path": str(xml_path.relative_to(components_dir())),
        "minsize": minsize,
        "properties": properties,
        "property_defaults": defaults,
        "configurations": configurations,
        "aliases": aliases,
        "flags": _parse_flags(declaration),
        "connections": _parse_connections(connections_el),
        "render": {
            "autorotate": render_el.attrib.get("autorotate", "") if render_el is not None else "",
            "shapes": shapes,
        },
        "definitions": _parse_definitions(root),
    }
    _apply_universal_label(component)
    return component


def _apply_universal_label(component: dict[str, Any]) -> None:
    # Reference and Text are alternative component-designator channels. Assets
    # that already own either channel also own its layout; injecting another
    # Text shape would duplicate the label and can overlap native value text.
    if any(prop.get("name") in NATIVE_LABEL_PROPERTIES for prop in component["properties"]):
        return

    component["properties"].append(dict(UNIVERSAL_LABEL_PROPERTY))
    component["property_defaults"]["Text"] = ""
    component["render"]["shapes"].extend(json.loads(json.dumps(UNIVERSAL_LABEL_SHAPES, ensure_ascii=False)))


@lru_cache(maxsize=1)
def load_registry() -> dict[str, Any]:
    base_dir = components_dir()
    list_path = component_list_path()
    if not base_dir.exists():
        raise FileNotFoundError(f"components directory not found: {base_dir}")
    if not list_path.exists():
        raise FileNotFoundError(f"component list not found: {list_path}")

    component_list = json.loads(list_path.read_text(encoding="utf-8"))
    ids_by_name = {_normalize(item["name"]): int(item["id"]) for item in component_list}

    components: list[dict[str, Any]] = []
    index: dict[str, dict[str, Any]] = {}
    errors: list[str] = []

    for xml_path in sorted(base_dir.rglob("*.xml")):
        try:
            probe = ET.parse(str(xml_path)).getroot()
            declaration = _find_child(probe, "declaration")
            meta_name = ""
            if declaration is not None:
                for item in _children(declaration, "meta"):
                    if item.attrib.get("name") == "name":
                        meta_name = item.attrib.get("value", "")
                        break
            component = _parse_component_xml(xml_path, ids_by_name.get(_normalize(meta_name)))
            components.append(component)
            index[_normalize(component["name"])] = {"component": component, "configuration": None}
            for config in component["configurations"]:
                if config["name"]:
                    index[_normalize(config["name"])] = {"component": component, "configuration": config}
                if config.get("implements"):
                    index.setdefault(_normalize(config["implements"]), {"component": component, "configuration": config})
        except Exception as exc:
            errors.append(str(exc))

    component_names = {_normalize(component["name"]) for component in components}
    missing = [
        item["name"]
        for item in component_list
        if _normalize(item["name"]) not in component_names
        and _normalize(item["name"]) not in index
    ]
    if missing:
        errors.append(f"component_list entries not backed by XML/configuration: {missing}")

    return {
        "components": components,
        "index": index,
        "errors": errors,
        "count": len(components),
        "component_list_count": len(component_list),
    }


def get_registry_summary() -> dict[str, Any]:
    registry = load_registry()
    return {
        "count": registry["count"],
        "component_list_count": registry["component_list_count"],
        "errors": registry["errors"],
        "components_dir": str(components_dir()),
        "component_list": str(component_list_path()),
    }


def get_component_catalog() -> dict[str, Any]:
    registry = load_registry()

    items: list[dict[str, Any]] = []
    for component in registry["components"]:
        if component["name"] in CATALOG_HIDDEN_COMPONENTS:
            continue
        aliases = component["aliases"]
        items.append(
            {
                "name": component["name"],
                "minsize": component["minsize"],
                "aliases": aliases[:10],
            }
        )

    return {
        "count": len(items),
        "items": items,
    }


def resolve_component_name(name: str) -> dict[str, Any] | None:
    return load_registry()["index"].get(_normalize(name))


def get_component_detail(names: list[str]) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    missing: list[str] = []

    for name in names:
        resolved = resolve_component_name(name)
        if resolved is None:
            missing.append(name)
            continue
        component = resolved["component"]
        configuration = resolved["configuration"]
        item = json.loads(json.dumps(component, ensure_ascii=False))
        if configuration is not None:
            item["requested_name"] = name
            item["matched_configuration"] = configuration
            item["suggested_properties"] = configuration.get("properties", {})
        else:
            item["requested_name"] = name
            item["matched_configuration"] = None
            item["suggested_properties"] = {}
        results.append(item)

    return {
        "components": results,
        "missing": missing,
    }


def validate_component_properties(component: dict[str, Any], properties: dict[str, Any]) -> tuple[dict[str, str], list[str]]:
    definitions = {prop["name"]: prop for prop in component["properties"]}
    merged = dict(component["property_defaults"])
    errors: list[str] = []

    for key, raw_value in properties.items():
        if key not in definitions:
            errors.append(f"Unknown property {key} for {component['name']}")
            continue
        prop = definitions[key]
        value = str(raw_value)
        if prop["type"] == "enum" and prop["options"] and value not in prop["options"]:
            errors.append(f"Invalid value {value!r} for {key}; expected one of {prop['options']}")
            continue
        if prop["type"] == "bool" and value.lower() not in {"true", "false"}:
            errors.append(f"Invalid boolean value {value!r} for {key}")
            continue
        merged[key] = value

    return merged, errors


def main() -> int:
    summary = get_registry_summary()
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if summary["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
