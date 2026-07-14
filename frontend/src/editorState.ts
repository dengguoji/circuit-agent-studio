import { CANVAS_STORAGE_KEY } from "./appConfig";
import {
  componentSupportsOrientation,
  emptyCanvasState,
  getAllowedComponentOrientations,
  getComponentLabelPropertyName,
} from "./circuitTools";
import type { CircuitCanvasState, ComponentDetail, ComponentInstance, WireSegment } from "./circuitTools";
import type { EditorSelection } from "./appTypes";

export function selectionExists(state: CircuitCanvasState, selection: EditorSelection) {
  if (selection.kind === "component") {
    return state.components.some((component) => component.id === selection.id);
  }
  if (selection.kind === "wire") {
    return state.wires.some((wire) => wire.id === selection.id);
  }
  return state.junctions.some((junction) => junction.id === selection.id);
}

export function canvasStatesEqual(a: CircuitCanvasState, b: CircuitCanvasState) {
  return JSON.stringify(canvasStateForHistory(a)) === JSON.stringify(canvasStateForHistory(b));
}

export function canvasStateForHistory(state: CircuitCanvasState) {
  return {
    components: state.components.map((component) => ({
      id: component.id,
      name: component.name,
      requestedName: component.requestedName,
      origin: component.origin,
      orientation: component.orientation,
      size: component.size,
      properties: Object.fromEntries(Object.entries(component.properties).sort(([left], [right]) => left.localeCompare(right))),
    })),
    wires: state.wires.map((wire) => ({
      id: wire.id,
      start: wire.start,
      end: wire.end,
    })),
    junctions: state.junctions.map((junction) => ({
      id: junction.id,
      point: junction.point,
      manual: Boolean(junction.manual),
    })),
  };
}

export function reconcileCanvasComponentDetails(
  state: CircuitCanvasState,
  details: readonly ComponentDetail[]
): CircuitCanvasState {
  if (details.length === 0 || state.components.length === 0) return state;

  const index = new Map<string, ComponentDetail>();
  details.forEach((detail) => {
    [detail.name, detail.requested_name, ...detail.aliases].forEach((name) => {
      if (name) index.set(normalizeComponentName(name), detail);
    });
  });

  let changed = false;
  const components = state.components.map((component) => {
    const detail = index.get(normalizeComponentName(component.requestedName))
      ?? index.get(normalizeComponentName(component.name));
    if (!detail) return component;

    const allowed = getAllowedComponentOrientations(detail);
    const orientation = componentSupportsOrientation(detail, component.orientation)
      ? component.orientation
      : allowed[0] ?? component.orientation;
    const properties = reconcileLegacyLabelProperties(component.properties, detail);
    if (
      detail === component.detail
      && orientation === component.orientation
      && properties === component.properties
    ) return component;
    changed = true;
    return { ...component, detail, orientation, properties };
  });

  return changed ? { ...state, components } : state;
}

function reconcileLegacyLabelProperties(
  properties: ComponentInstance["properties"],
  detail: ComponentDetail
): ComponentInstance["properties"] {
  if (getComponentLabelPropertyName(detail) !== "Reference" || !("Text" in properties)) {
    return properties;
  }

  const next = { ...properties };
  const legacyText = next.Text?.trim() ?? "";
  if (!(next.Reference?.trim()) && legacyText) {
    next.Reference = legacyText;
  }
  delete next.Text;
  return next;
}

function normalizeComponentName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function loadStoredCanvasState(): CircuitCanvasState {
  if (typeof window === "undefined") return emptyCanvasState;

  try {
    const raw = window.localStorage.getItem(CANVAS_STORAGE_KEY);
    if (!raw) return emptyCanvasState;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecordValue(parsed) || parsed.version !== 1 || !isRecordValue(parsed.state)) return emptyCanvasState;
    return normalizeStoredCanvasState(parsed.state) ?? emptyCanvasState;
  } catch (error) {
    console.warn("Failed to restore circuit canvas state", error);
    return emptyCanvasState;
  }
}

export function normalizeImportedProjectState(value: unknown): CircuitCanvasState | null {
  if (!isRecordValue(value)) return null;
  const rawState = isRecordValue(value.canvas_state) ? value.canvas_state : isRecordValue(value.state) ? value.state : null;
  if (!rawState) return null;

  const normalized = normalizeStoredCanvasState(rawState);
  if (!normalized || !Array.isArray(rawState.components) || !Array.isArray(rawState.wires) || !Array.isArray(rawState.junctions)) return null;
  if (
    normalized.components.length !== rawState.components.length ||
    normalized.wires.length !== rawState.wires.length ||
    normalized.junctions.length !== rawState.junctions.length
  ) {
    return null;
  }
  return normalized;
}

export function formatSaveTime(date: Date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function normalizeStoredCanvasState(value: Record<string, unknown>): CircuitCanvasState | null {
  if (!Array.isArray(value.components) || !Array.isArray(value.wires) || !Array.isArray(value.junctions)) return null;

  const components = value.components.flatMap((component) => {
    const normalized = normalizeStoredComponent(component);
    return normalized ? [normalized] : [];
  });
  const wires = value.wires.flatMap((wire) => {
    const normalized = normalizeStoredWire(wire);
    return normalized ? [normalized] : [];
  });
  const junctions = value.junctions.flatMap((junction) => {
    const normalized = normalizeStoredJunction(junction);
    return normalized ? [normalized] : [];
  });

  return { components, wires, junctions };
}

function normalizeStoredComponent(value: unknown): ComponentInstance | null {
  if (!isRecordValue(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.requestedName !== "string" ||
    !isPointValue(value.origin) ||
    (value.orientation !== "h" && value.orientation !== "v") ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    !isStringRecord(value.properties) ||
    !isComponentDetailValue(value.detail)
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    requestedName: value.requestedName,
    origin: value.origin,
    orientation: value.orientation,
    size: value.size,
    properties: value.properties,
    detail: value.detail,
  };
}

function normalizeStoredWire(value: unknown): WireSegment | null {
  if (!isRecordValue(value) || typeof value.id !== "string" || !isPointValue(value.start) || !isPointValue(value.end)) return null;
  return { id: value.id, start: value.start, end: value.end };
}

function normalizeStoredJunction(value: unknown): CircuitCanvasState["junctions"][number] | null {
  if (!isRecordValue(value) || typeof value.id !== "string" || !isPointValue(value.point)) return null;
  return { id: value.id, point: value.point, manual: value.manual === true };
}

function isPointValue(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecordValue(value) && Object.values(value).every((item) => typeof item === "string");
}

function isComponentDetailValue(value: unknown): value is ComponentDetail {
  if (!isRecordValue(value)) return false;
  const render = value.render;
  const definitions = value.definitions;
  return (
    typeof value.name === "string" &&
    typeof value.requested_name === "string" &&
    typeof value.minsize === "string" &&
    Array.isArray(value.properties) &&
    Array.isArray(value.connections) &&
    isRecordValue(render) &&
    Array.isArray(render.shapes) &&
    isRecordValue(definitions)
  );
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
