export const CANVAS_SIZE = 1000;
export const COMPONENT_GRID_SIZE = 10;
export const CONNECTION_GRID_SIZE = 5;
// Backwards-compatible visual/component grid alias. New connection code should
// use CONNECTION_GRID_SIZE explicitly.
export const GRID_SIZE = COMPONENT_GRID_SIZE;
export const MAJOR_GRID_SIZE = 50;

export type Point = [number, number];
export type Orientation = "h" | "v";
export type CanvasBounds = {
  width: number;
  height: number;
};

export const DEFAULT_CANVAS_BOUNDS: CanvasBounds = {
  width: CANVAS_SIZE,
  height: CANVAS_SIZE,
};

export function isPointOnGrid(point: Point, step: number): boolean {
  if (!Number.isFinite(step) || step <= 0) return false;
  return point.every((value) => Number.isFinite(value) && Number.isInteger(value / step));
}

export function isComponentOriginOnGrid(point: Point): boolean {
  return isPointOnGrid(point, COMPONENT_GRID_SIZE);
}

export function isConnectionPointOnGrid(point: Point): boolean {
  return isPointOnGrid(point, CONNECTION_GRID_SIZE);
}

export function snapCoordinateToGrid(value: number, max: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) {
    throw new RangeError("Grid step must be a positive finite number");
  }
  const safeMax = Number.isFinite(max) ? Math.max(0, max) : 0;
  const maxGridCoordinate = Math.floor(safeMax / step) * step;
  const snapped = Math.round(value / step) * step;
  return Math.min(maxGridCoordinate, Math.max(0, snapped));
}

export function snapPointToGridStep(point: Point, canvasBounds: CanvasBounds, step: number): Point {
  return [
    snapCoordinateToGrid(point[0], canvasBounds.width, step),
    snapCoordinateToGrid(point[1], canvasBounds.height, step),
  ];
}

export type WireSegment = {
  id: string;
  start: Point;
  end: Point;
};

export type Junction = {
  id: string;
  point: Point;
  manual?: boolean;
};

export type ComponentProperty = {
  name: string;
  type: string;
  default: string;
  serialize: string;
  display: string;
  options: string[];
  formatting?: Array<{ conditions: string; value: string }>;
};

export type ComponentConfiguration = {
  name: string;
  value: string;
  implements: string;
  properties: Record<string, string>;
};

export type ComponentConnection = {
  name: string;
  start: string;
  end: string;
  edge: string;
  conditions: string;
};

export type ComponentRenderShape = {
  type: "line" | "rect" | "ellipse" | "path" | "text";
  conditions: string;
  autorotate: string;
  attrs: Record<string, string>;
};

export type ComponentDefinitionSet = {
  consts: Record<string, string>;
  defs: Record<string, Array<{ conditions: string; value: string }>>;
};

export type ComponentDetail = {
  id: number | null;
  name: string;
  requested_name: string;
  category: string;
  path: string;
  minsize: string;
  properties: ComponentProperty[];
  property_defaults: Record<string, string>;
  configurations: ComponentConfiguration[];
  matched_configuration: ComponentConfiguration | null;
  suggested_properties: Record<string, string>;
  aliases: string[];
  flags?: string[];
  connections: ComponentConnection[];
  render: {
    autorotate: string;
    shapes: ComponentRenderShape[];
  };
  definitions: ComponentDefinitionSet;
};

export type ComponentLabelPropertyName = "Reference" | "Text";

export function getComponentLabelPropertyName(detail: ComponentDetail): ComponentLabelPropertyName | null {
  const propertyNames = new Set(detail.properties.map((property) => property.name));
  if (propertyNames.has("Reference")) return "Reference";
  if (propertyNames.has("Text")) return "Text";
  return null;
}

export type ComponentInstance = {
  id: string;
  name: string;
  requestedName: string;
  origin: Point;
  orientation: Orientation;
  size: number;
  properties: Record<string, string>;
  detail: ComponentDetail;
};

export type ComponentOrientationCapability =
  | "HorizontalOnly"
  | "VerticalOnly"
  | "HorizontalToVertical"
  | "HorizontalAndVertical";

export function getAllowedComponentOrientations(detail: ComponentDetail): Orientation[] {
  const flags = new Set((detail.flags ?? []).map((flag) => flag.trim().toLowerCase()));
  const horizontalOnly = flags.has("horizontalonly");
  const verticalOnly = flags.has("verticalonly");
  if (horizontalOnly && verticalOnly) return [];
  if (horizontalOnly) return ["h"];
  if (verticalOnly) return ["v"];
  return ["h", "v"];
}

export function componentSupportsOrientation(detail: ComponentDetail, orientation: Orientation): boolean {
  return getAllowedComponentOrientations(detail).includes(orientation);
}

export function getComponentOrientationCapability(detail: ComponentDetail): ComponentOrientationCapability {
  const allowed = getAllowedComponentOrientations(detail);
  if (allowed.length === 1) return allowed[0] === "h" ? "HorizontalOnly" : "VerticalOnly";

  const autorotate = [detail.render.autorotate, ...detail.render.shapes.map((shape) => shape.autorotate)]
    .join(",")
    .toLowerCase();
  return autorotate.includes("horizontaltovertical") ? "HorizontalToVertical" : "HorizontalAndVertical";
}

export function describeAllowedComponentOrientations(detail: ComponentDetail): string {
  const allowed = getAllowedComponentOrientations(detail);
  if (allowed.length === 0) return "no valid orientation because its XML flags conflict";
  if (allowed.length === 1) return `${allowed[0]} only`;
  return "h or v";
}

export type CircuitCanvasState = {
  components: ComponentInstance[];
  wires: WireSegment[];
  junctions: Junction[];
};

export type ToolTraceStatus = "ok" | "error";

export type TraceItem = {
  id: string;
  action: CircuitToolCall["name"];
  detail: string;
  status: ToolTraceStatus;
};

export type CircuitToolCall =
  | { name: "inspect_canvas" }
  | { name: "review_canvas_visual" }
  | { name: "get_component_catalog" }
  | { name: "get_component_detail"; names: string[] }
  | { name: "place_component"; id?: string; componentName: string; origin: Point; orientation: Orientation; properties: Record<string, unknown> }
  | { name: "move_component"; id: string; origin: Point; orientation?: Orientation }
  | { name: "update_component_properties"; id: string; properties: Record<string, unknown> }
  | { name: "remove_component"; id: string }
  | { name: "draw_wire_segment"; id?: string; start: Point; end: Point }
  | { name: "update_wire_segment"; id: string; start?: Point; end?: Point }
  | { name: "delete_wire_segment"; id: string }
  | { name: "add_junction"; id?: string; point: Point }
  | { name: "move_junction"; id: string; point: Point }
  | { name: "remove_junction"; id: string }
  | { name: "clear_canvas" };

export function isCanvasMutatingToolCall(call: CircuitToolCall): boolean {
  return ![
    "inspect_canvas",
    "review_canvas_visual",
    "get_component_catalog",
    "get_component_detail",
  ].includes(call.name);
}

export type ValidationIssue = {
  id: string;
  target: "component" | "wire" | "junction" | "canvas";
  message: string;
  point?: Point;
};

export type ValidationReport = {
  issues: ValidationIssue[];
  status: "valid" | "needs review";
};

export type ToolExecutionResult = {
  state: CircuitCanvasState;
  activeId: string | null;
  trace: TraceItem;
  toolResult?: unknown;
};

export const emptyCanvasState: CircuitCanvasState = {
  components: [],
  wires: [],
  junctions: [],
};

export const demoToolCalls: CircuitToolCall[] = [
  { name: "clear_canvas" },
  { name: "get_component_detail", names: ["Resistor", "Lamp", "Cell"] },
  {
    name: "place_component",
    componentName: "Resistor",
    origin: [420, 260],
    orientation: "h",
    properties: { Resistance: 4700, Style: "IEC" },
  },
  {
    name: "place_component",
    componentName: "Lamp",
    origin: [580, 260],
    orientation: "h",
    properties: {},
  },
  {
    name: "place_component",
    componentName: "Cell",
    origin: [420, 380],
    orientation: "h",
    properties: { Voltage: 5 },
  },
  { name: "draw_wire_segment", start: [470, 260], end: [580, 260] },
];

export function parseToolCalls(input: string): { calls: CircuitToolCall[]; error: string | null } {
  let parsed: unknown;

  try {
    parsed = JSON.parse(input);
  } catch (error) {
    return {
      calls: [],
      error: `JSON parse failed: ${error instanceof Error ? error.message : "invalid JSON"}`,
    };
  }

  const rawCalls = getRawCalls(parsed);
  const calls: CircuitToolCall[] = [];

  for (let index = 0; index < rawCalls.length; index += 1) {
    const result = normalizeToolCall(rawCalls[index]);
    if (typeof result === "string") {
      return { calls: [], error: `Tool call ${index + 1}: ${result}` };
    }
    calls.push(result);
  }

  return { calls, error: null };
}

export function applyToolCall(state: CircuitCanvasState, call: CircuitToolCall, canvasBounds = DEFAULT_CANVAS_BOUNDS): ToolExecutionResult {
  const rejected = validateToolCallForExecution(state, call, canvasBounds);
  if (rejected) {
    return {
      state,
      activeId: getToolTargetId(call),
      trace: {
        id: getToolTargetId(call) ?? "canvas",
        action: call.name,
        detail: rejected,
        status: "error",
      },
      toolResult: { status: "error", message: rejected },
    };
  }

  switch (call.name) {
    case "inspect_canvas": {
      const validation = validateCanvas(state, canvasBounds);
      const summary = {
        components: state.components.length,
        wires: state.wires.length,
        junctions: state.junctions.length,
        status: validation.status,
      };
      return {
        state,
        activeId: null,
        trace: {
          id: "canvas",
          action: call.name,
          detail: `${summary.components} components, ${summary.wires} wires, ${summary.junctions} junctions, ${summary.status}`,
          status: validation.status === "valid" ? "ok" : "error",
        },
        toolResult: {
          status: "executed",
          summary,
          validation,
        },
      };
    }
    case "clear_canvas":
      return {
        state: emptyCanvasState,
        activeId: "canvas",
        trace: { id: "canvas", action: call.name, detail: "canvas cleared", status: "ok" },
        toolResult: { status: "executed" },
      };
    case "draw_wire_segment": {
      const wire: WireSegment = { id: getNextCanvasObjectId(state, "wire"), start: call.start, end: call.end };
      const nextState = {
        components: state.components,
        wires: [...state.wires, wire],
        junctions: reconcileJunctions([...state.wires, wire], state.junctions),
      };
      return {
        state: nextState,
        activeId: wire.id,
        trace: { id: wire.id, action: call.name, detail: formatWire(wire), status: "ok" },
        toolResult: { status: "executed", wire },
      };
    }
    case "update_wire_segment": {
      const nextWires = state.wires.map((wire) =>
        wire.id === call.id
          ? {
              ...wire,
              start: call.start ?? wire.start,
              end: call.end ?? wire.end,
            }
          : wire
      );
      const updated = nextWires.find((wire) => wire.id === call.id);
      const nextState = { components: state.components, wires: nextWires, junctions: reconcileJunctions(nextWires, state.junctions) };
      return {
        state: nextState,
        activeId: call.id,
        trace: {
          id: call.id,
          action: call.name,
          detail: updated ? formatWire(updated) : call.id,
          status: "ok",
        },
        toolResult: { status: "executed", wire: updated },
      };
    }
    case "delete_wire_segment": {
      const nextState = {
        components: state.components,
        wires: state.wires.filter((wire) => wire.id !== call.id),
        junctions: reconcileJunctions(
          state.wires.filter((wire) => wire.id !== call.id),
          state.junctions
        ),
      };
      return {
        state: nextState,
        activeId: null,
        trace: { id: call.id, action: call.name, detail: call.id, status: "ok" },
        toolResult: { status: "executed", id: call.id },
      };
    }
    case "add_junction": {
      const junction: Junction = { id: getNextCanvasObjectId(state, "junction"), point: call.point, manual: true };
      const nextState = {
        components: state.components,
        wires: state.wires,
        junctions: [...state.junctions, junction],
      };
      return {
        state: nextState,
        activeId: junction.id,
        trace: { id: junction.id, action: call.name, detail: `${junction.id} ${formatPoint(junction.point)}`, status: "ok" },
        toolResult: { status: "executed", junction },
      };
    }
    case "move_junction": {
      const nextState = {
        components: state.components,
        wires: state.wires,
        junctions: state.junctions.map((junction) =>
          junction.id === call.id ? { ...junction, point: call.point, manual: true } : junction
        ),
      };
      return {
        state: nextState,
        activeId: call.id,
        trace: { id: call.id, action: call.name, detail: `${call.id} ${formatPoint(call.point)}`, status: "ok" },
        toolResult: { status: "executed", junction: { id: call.id, point: call.point, manual: true } },
      };
    }
    case "remove_junction": {
      const nextState = {
        components: state.components,
        wires: state.wires,
        junctions: state.junctions.filter((junction) => junction.id !== call.id),
      };
      return {
        state: nextState,
        activeId: null,
        trace: { id: call.id, action: call.name, detail: call.id, status: "ok" },
        toolResult: { status: "executed", id: call.id },
      };
    }
    default:
      return {
        state,
        activeId: getToolTargetId(call),
        trace: {
          id: getToolTargetId(call) ?? "component-registry",
          action: call.name,
          detail: `${call.name} requires async execution`,
          status: "error",
        },
        toolResult: { status: "error", message: `${call.name} requires async execution` },
      };
  }
}

export function validateCanvas(state: CircuitCanvasState, canvasBounds = DEFAULT_CANVAS_BOUNDS): ValidationReport {
  const issues: ValidationIssue[] = [];
  const componentPortPoints = state.components.flatMap((component) => getComponentConnectionPointCoordinates(component));
  const allIds = [
    ...state.components.map((component) => component.id),
    ...state.wires.map((wire) => wire.id),
    ...state.junctions.map((junction) => junction.id),
  ];
  const duplicateIds = new Set(allIds.filter((id, index) => allIds.indexOf(id) !== index));

  duplicateIds.forEach((id) => {
    issues.push({ id, target: "canvas", message: `Duplicate id: ${id}` });
  });

  state.components.forEach((component) => {
    if (!componentSupportsOrientation(component.detail, component.orientation)) {
      issues.push({
        id: component.id,
        target: "component",
        message: `${component.name} does not support orientation ${component.orientation}; use ${describeAllowedComponentOrientations(component.detail)}`,
        point: component.origin,
      });
    }
    if (!isComponentOriginOnGrid(component.origin)) {
      issues.push({
        id: component.id,
        target: "component",
        message: `Component origin must be on ${COMPONENT_GRID_SIZE}px grid`,
        point: component.origin,
      });
    }
    if (!isInsideCanvas(component.origin, canvasBounds)) {
      issues.push({ id: component.id, target: "component", message: "Component origin must stay inside the canvas", point: component.origin });
    }
  });

  state.wires.forEach((wire) => {
    if (isZeroLengthWire(wire)) {
      issues.push({ id: wire.id, target: "wire", message: "Wire length must be greater than 0", point: wire.start });
    }

    if (!isAxisAlignedWire(wire)) {
      issues.push({ id: wire.id, target: "wire", message: "Wire must be horizontal or vertical", point: wire.start });
    }

    (["start", "end"] as const).forEach((endpoint) => {
      const point = wire[endpoint];
      if (!isConnectionPointOnGrid(point)) {
        issues.push({
          id: `${wire.id}.${endpoint}.grid`,
          target: "wire",
          message: `${wire.id} ${endpoint} endpoint must be on ${CONNECTION_GRID_SIZE}px grid`,
          point,
        });
      }
      if (!isInsideCanvas(point, canvasBounds)) {
        issues.push({
          id: `${wire.id}.${endpoint}.bounds`,
          target: "wire",
          message: `${wire.id} ${endpoint} endpoint must stay inside the canvas`,
          point,
        });
      }
    });

    if (validateWireGeometry(wire, canvasBounds) === null) {
      (["start", "end"] as const).forEach((endpoint) => {
        const point = wire[endpoint];
        if (!isWireEndpointConnected(state, wire, point, componentPortPoints)) {
          issues.push({
            id: `${wire.id}.${endpoint}`,
            target: "wire",
            message: `${wire.id} ${endpoint} endpoint ${formatPoint(point)} is dangling`,
            point,
          });
        }
      });
    }
  });

  state.junctions.forEach((junction) => {
    if (!isConnectionPointOnGrid(junction.point)) {
      issues.push({
        id: junction.id,
        target: "junction",
        message: `Junction must be on ${CONNECTION_GRID_SIZE}px grid`,
        point: junction.point,
      });
    }

    if (!isInsideCanvas(junction.point, canvasBounds)) {
      issues.push({ id: junction.id, target: "junction", message: "Junction must stay inside the canvas", point: junction.point });
    }

    if (!state.wires.some((wire) => pointIsOnWire(junction.point, wire))) {
      issues.push({ id: junction.id, target: "junction", message: "Junction must sit on a wire segment", point: junction.point });
    }
  });

  return {
    issues,
    status: issues.length === 0 ? "valid" : "needs review",
  };
}

export function mergeComponentProperties(detail: ComponentDetail, overrides: Record<string, unknown>): { properties: Record<string, string>; errors: string[] } {
  const propertyDefs = new Map(detail.properties.map((property) => [property.name, property]));
  const properties = {
    ...detail.property_defaults,
    ...detail.suggested_properties,
  };
  const errors: string[] = [];

  Object.entries(overrides).forEach(([key, value]) => {
    const def = propertyDefs.get(key);
    if (!def) {
      errors.push(`Unknown property ${key} for ${detail.name}`);
      return;
    }
    const stringValue = String(value);
    if (def.type === "enum" && def.options.length > 0 && !def.options.includes(stringValue)) {
      errors.push(`Invalid value ${stringValue} for ${key}; expected ${def.options.join(", ")}`);
      return;
    }
    if (def.type === "bool" && !["true", "false"].includes(stringValue.toLowerCase())) {
      errors.push(`Invalid boolean value ${stringValue} for ${key}`);
      return;
    }
    properties[key] = stringValue;
  });

  return { properties, errors };
}

export function createComponentInstance(
  call: Extract<CircuitToolCall, { name: "place_component" }>,
  detail: ComponentDetail,
  id: string
): { component: ComponentInstance | null; error: string | null } {
  if (!componentSupportsOrientation(detail, call.orientation)) {
    return {
      component: null,
      error: `Rejected ${detail.name}: orientation ${call.orientation} is not supported; use ${describeAllowedComponentOrientations(detail)}`,
    };
  }
  const { properties, errors } = mergeComponentProperties(detail, call.properties);
  if (errors.length > 0) return { component: null, error: errors.join("; ") };

  const size = Number.parseFloat(detail.minsize) || 40;
  return {
    component: {
      id,
      name: detail.name,
      requestedName: call.componentName,
      origin: call.origin,
      orientation: call.orientation,
      size,
      properties,
      detail,
    },
    error: null,
  };
}

function validateToolCallForExecution(state: CircuitCanvasState, call: CircuitToolCall, canvasBounds: CanvasBounds): string | null {
  switch (call.name) {
    case "inspect_canvas":
    case "review_canvas_visual":
      return null;
    case "get_component_catalog":
    case "get_component_detail":
      return null;
    case "clear_canvas":
      return null;
    case "place_component": {
      if (!isComponentOriginOnGrid(call.origin)) {
        return `Rejected place_component: origin must be on ${COMPONENT_GRID_SIZE}px grid`;
      }
      if (!isInsideCanvas(call.origin, canvasBounds)) return "Rejected place_component: origin must stay inside the canvas";
      return null;
    }
    case "move_component": {
      const component = state.components.find((item) => item.id === call.id);
      if (!component) return `Rejected ${call.id}: component does not exist`;
      if (!isComponentOriginOnGrid(call.origin)) return `Rejected ${call.id}: origin must be on ${COMPONENT_GRID_SIZE}px grid`;
      if (!isInsideCanvas(call.origin, canvasBounds)) return `Rejected ${call.id}: origin must stay inside the canvas`;
      const orientation = call.orientation ?? component.orientation;
      if (!componentSupportsOrientation(component.detail, orientation)) {
        return `Rejected ${call.id}: ${component.name} does not support orientation ${orientation}; use ${describeAllowedComponentOrientations(component.detail)}`;
      }
      return null;
    }
    case "update_component_properties":
      return state.components.some((component) => component.id === call.id) ? null : `Rejected ${call.id}: component does not exist`;
    case "remove_component":
      return state.components.some((component) => component.id === call.id) ? null : `Rejected ${call.id}: component does not exist`;
    case "draw_wire_segment": {
      return validateWireGeometry({ id: getNextCanvasObjectId(state, "wire"), start: call.start, end: call.end }, canvasBounds);
    }
    case "update_wire_segment": {
      const current = state.wires.find((wire) => wire.id === call.id);
      if (!current) return `Rejected ${call.id}: wire does not exist`;
      const nextWire = { ...current, start: call.start ?? current.start, end: call.end ?? current.end };
      return validateWireGeometry(nextWire, canvasBounds);
    }
    case "delete_wire_segment":
      return state.wires.some((wire) => wire.id === call.id) ? null : `Rejected ${call.id}: wire does not exist`;
    case "add_junction":
      if (!isConnectionPointOnGrid(call.point)) return `Rejected add_junction: point must be on ${CONNECTION_GRID_SIZE}px grid`;
      if (!isInsideCanvas(call.point, canvasBounds)) return "Rejected add_junction: point must stay inside the canvas";
      if (!state.wires.some((wire) => pointIsOnWire(call.point, wire))) return "Rejected add_junction: junction must sit on a wire segment";
      if (state.junctions.some((junction) => samePoint(junction.point, call.point))) return `Rejected add_junction: junction already exists at ${formatPoint(call.point)}`;
      return null;
    case "move_junction": {
      const current = state.junctions.find((junction) => junction.id === call.id);
      if (!current) return `Rejected ${call.id}: junction does not exist`;
      if (!current.manual) return `Rejected ${call.id}: inferred junctions move with their connected wires`;
      if (!isConnectionPointOnGrid(call.point)) return `Rejected ${call.id}: point must be on ${CONNECTION_GRID_SIZE}px grid`;
      if (!isInsideCanvas(call.point, canvasBounds)) return `Rejected ${call.id}: point must stay inside the canvas`;
      if (!state.wires.some((wire) => pointIsOnWire(call.point, wire))) return `Rejected ${call.id}: junction must sit on a wire segment`;
      if (state.junctions.some((junction) => junction.id !== call.id && samePoint(junction.point, call.point))) {
        return `Rejected ${call.id}: junction already exists at ${formatPoint(call.point)}`;
      }
      return null;
    }
    case "remove_junction":
      return state.junctions.some((junction) => junction.id === call.id) ? null : `Rejected ${call.id}: junction does not exist`;
    default:
      return assertNever(call);
  }
}

function validateWireGeometry(wire: WireSegment, canvasBounds: CanvasBounds): string | null {
  if (isZeroLengthWire(wire)) return `Rejected ${wire.id}: wire length must be greater than 0`;
  if (!isAxisAlignedWire(wire)) return `Rejected ${wire.id}: wire must be horizontal or vertical`;
  if (!isConnectionPointOnGrid(wire.start) || !isConnectionPointOnGrid(wire.end)) {
    return `Rejected ${wire.id}: endpoints must be on ${CONNECTION_GRID_SIZE}px grid`;
  }
  if (!isInsideCanvas(wire.start, canvasBounds) || !isInsideCanvas(wire.end, canvasBounds)) {
    return `Rejected ${wire.id}: endpoints must stay inside the canvas`;
  }
  return null;
}

function reconcileJunctions(wires: WireSegment[], currentJunctions: Junction[]): Junction[] {
  const nextJunctions: Junction[] = [];
  const usedIds = new Set<string>(wires.map((wire) => wire.id));
  const usedPoints = new Set<string>();
  const implicitPoints = collectImplicitJunctionPoints(wires);

  currentJunctions.forEach((junction) => {
    if (!wires.some((wire) => pointIsOnWire(junction.point, wire))) return;
    const pointKey = pointToKey(junction.point);
    const isImplicitPoint = implicitPoints.some((point) => samePoint(point, junction.point));
    if (!junction.manual && !isImplicitPoint) return;
    if (usedPoints.has(pointKey)) return;
    nextJunctions.push(junction);
    usedPoints.add(pointKey);
    usedIds.add(junction.id);
  });

  implicitPoints.forEach((point) => {
    const pointKey = pointToKey(point);
    if (usedPoints.has(pointKey)) return;
    const junction = { id: getNextGeneratedJunctionId(usedIds), point };
    nextJunctions.push(junction);
    usedIds.add(junction.id);
    usedPoints.add(pointKey);
  });

  return nextJunctions;
}

function collectImplicitJunctionPoints(wires: WireSegment[]): Point[] {
  const points: Point[] = [];
  const addPoint = (point: Point) => {
    if (!points.some((current) => samePoint(current, point))) {
      points.push(point);
    }
  };

  wires.forEach((wire) => {
    [wire.start, wire.end].forEach((endpoint) => {
      const containingWires = wires.filter((candidate) => pointIsOnWire(endpoint, candidate));
      const isBranchPoint = containingWires.some((candidate) => !samePoint(endpoint, candidate.start) && !samePoint(endpoint, candidate.end));
      if ((isBranchPoint && containingWires.length > 1) || containingWires.length >= 3) {
        addPoint(endpoint);
      }
    });
  });

  for (let leftIndex = 0; leftIndex < wires.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < wires.length; rightIndex += 1) {
      const intersection = getOrthogonalWireIntersection(wires[leftIndex], wires[rightIndex]);
      if (!intersection) continue;

      const containingWires = wires.filter((wire) => pointIsOnWire(intersection, wire));
      const hasInteriorWire = containingWires.some((wire) => !samePoint(intersection, wire.start) && !samePoint(intersection, wire.end));
      const isSimpleCorner = containingWires.length === 2 && !hasInteriorWire;

      if (!isSimpleCorner && containingWires.length > 1) {
        addPoint(intersection);
      }
    }
  }

  return points;
}

function getOrthogonalWireIntersection(left: WireSegment, right: WireSegment): Point | null {
  const leftHorizontal = left.start[1] === left.end[1];
  const leftVertical = left.start[0] === left.end[0];
  const rightHorizontal = right.start[1] === right.end[1];
  const rightVertical = right.start[0] === right.end[0];

  if (leftHorizontal && rightVertical) {
    const point: Point = [right.start[0], left.start[1]];
    return pointIsOnWire(point, left) && pointIsOnWire(point, right) ? point : null;
  }

  if (leftVertical && rightHorizontal) {
    const point: Point = [left.start[0], right.start[1]];
    return pointIsOnWire(point, left) && pointIsOnWire(point, right) ? point : null;
  }

  return null;
}

function isWireEndpointConnected(state: CircuitCanvasState, owner: WireSegment, point: Point, componentPortPoints: Point[]): boolean {
  if (componentPortPoints.some((portPoint) => samePoint(portPoint, point))) return true;
  if (state.junctions.some((junction) => samePoint(junction.point, point))) return true;
  return state.wires.some((wire) => wire.id !== owner.id && pointIsOnWire(point, wire));
}

type LocalPoint = { x: number; y: number };

function getComponentConnectionPointCoordinates(component: ComponentInstance): Point[] {
  return component.detail.connections
    .filter((connection) => evalComponentConditions(connection.conditions, component))
    .map((connection) => {
      const start = resolveComponentLocation(connection.start, component);
      const end = resolveComponentLocation(connection.end, component);
      const localPoint = getComponentConnectionLocalPoint(connection, start, end);
      return componentLocalToCanvasPoint(component, localPoint);
    });
}

function getComponentConnectionLocalPoint(connection: ComponentConnection, start: LocalPoint, end: LocalPoint): LocalPoint {
  const edge = connection.edge.toLowerCase();
  if (edge === "start") return start;
  if (edge === "end") return end;
  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  };
}

function componentLocalToCanvasPoint(component: ComponentInstance, local: LocalPoint): Point {
  if (component.orientation === "h") {
    return [round(component.origin[0] + local.x), round(component.origin[1] + local.y)];
  }
  return [round(component.origin[0] - local.y), round(component.origin[1] + local.x)];
}

function resolveComponentLocation(rawExpr: string, component: ComponentInstance): LocalPoint {
  const expr = substituteComponentVariables(rawExpr || "0", component);
  const anchor = componentAnchorFor(expr, component.size);
  let point = anchor ? { ...anchor.point } : { x: 0, y: 0 };
  let remainder = anchor ? expr.slice(anchor.token.length) : expr;

  if (!anchor && /^-?\d+(\.\d+)?$/.test(expr.trim())) {
    point = { x: Number.parseFloat(expr), y: 0 };
    remainder = "";
  }

  for (const match of remainder.matchAll(/([+-])([^+-]+)/g)) {
    const sign = match[1] === "-" ? -1 : 1;
    const token = match[2].trim().replace(/,$/, "");
    const axis = token.endsWith("y") || token.endsWith("Y") ? "y" : "x";
    const value = Number.parseFloat(token.replace(/[xyXY]$/, ""));
    if (Number.isFinite(value)) {
      point[axis] += sign * value;
    }
  }
  return point;
}

function componentAnchorFor(expr: string, size: number): { token: string; point: LocalPoint } | null {
  const lower = expr.trim().toLowerCase();
  if (lower.startsWith("_start")) return { token: expr.trim().slice(0, 6), point: { x: 0, y: 0 } };
  if (lower.startsWith("_middle")) return { token: expr.trim().slice(0, 7), point: { x: size / 2, y: 0 } };
  if (lower.startsWith("_end")) return { token: expr.trim().slice(0, 4), point: { x: size, y: 0 } };
  return null;
}

function substituteComponentVariables(expr: string, component: ComponentInstance): string {
  return expr.replace(/\$(\w+)/g, (_match, name) => resolveComponentVariable(name, component));
}

function resolveComponentVariable(name: string, component: ComponentInstance): string {
  if (component.properties[name] !== undefined) return component.properties[name];
  if (component.detail.definitions.consts[name] !== undefined) return component.detail.definitions.consts[name];
  const rules = component.detail.definitions.defs[name];
  if (rules) {
    const matched = rules.find((rule) => evalComponentConditions(rule.conditions, component));
    if (matched) return matched.value;
  }
  return `$${name}`;
}

function evalComponentConditions(conditions: string | null | undefined, component: ComponentInstance): boolean {
  if (!conditions) return true;
  return evalComponentExpression(conditions, component);
}

function evalComponentExpression(value: string, component: ComponentInstance): boolean {
  const stripped = stripParens(value.trim());
  if (!stripped) return true;

  const andParts = splitTopLevel(stripped, ",");
  if (andParts.length > 1) {
    return andParts.every((part) => evalComponentExpression(part, component));
  }

  const orParts = splitTopLevel(stripped, "|");
  if (orParts.length > 1) {
    return orParts.some((part) => evalComponentExpression(part, component));
  }

  return evalComponentAtom(stripped, component);
}

function evalComponentAtom(value: string, component: ComponentInstance): boolean {
  if (!value) return true;
  if (value.startsWith("!")) return !evalComponentAtom(value.slice(1), component);
  if (value === "horizontal") return component.orientation === "h";

  const eq = value.match(/^\$(\w+)\s*==\s*(.+)$/);
  if (eq) return (component.properties[eq[1]] ?? "") === eq[2].trim();

  const neq = value.match(/^\$(\w+)\s*!=\s*(.+)$/);
  if (neq) return (component.properties[neq[1]] ?? "") !== neq[2].trim();

  const cmp = value.match(/^\$(\w+)\[(lt|gt|lte|gte)\](.+)$/);
  if (cmp) {
    const actual = Number.parseFloat(component.properties[cmp[1]] ?? "");
    const expected = Number.parseFloat(cmp[3]);
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
    if (cmp[2] === "lt") return actual < expected;
    if (cmp[2] === "gt") return actual > expected;
    if (cmp[2] === "lte") return actual <= expected;
    return actual >= expected;
  }

  const exists = value.match(/^\$(\w+)$/);
  if (exists) {
    const prop = component.properties[exists[1]];
    return prop !== undefined && prop !== "" && prop !== "false";
  }

  return true;
}

function splitTopLevel(value: string, separator: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = "";

  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === separator && depth === 0) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (current) result.push(current);
  return result;
}

function stripParens(value: string): string {
  if (value.startsWith("(") && value.endsWith(")")) return value.slice(1, -1);
  return value;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function getNextGeneratedJunctionId(usedIds: Set<string>): string {
  return getNextPrefixedId(usedIds, "junc_");
}

export function getNextCanvasObjectId(state: CircuitCanvasState, kind: "component" | "wire" | "junction"): string {
  const prefix = kind === "component" ? "cmp_" : kind === "wire" ? "wire_" : "junc_";
  return getNextPrefixedId(getAllObjectIds(state), prefix);
}

function getAllObjectIds(state: CircuitCanvasState): Set<string> {
  return new Set([
    ...state.components.map((component) => component.id),
    ...state.wires.map((wire) => wire.id),
    ...state.junctions.map((junction) => junction.id),
  ]);
}

function getNextPrefixedId(usedIds: Set<string>, prefix: string): string {
  let maxIndex = 0;
  usedIds.forEach((id) => {
    if (!id.startsWith(prefix)) return;
    const suffix = Number.parseInt(id.slice(prefix.length), 10);
    if (Number.isFinite(suffix) && suffix > maxIndex) {
      maxIndex = suffix;
    }
  });
  return `${prefix}${maxIndex + 1}`;
}

function hasAnyId(state: CircuitCanvasState, id: string): boolean {
  return (
    state.components.some((component) => component.id === id) ||
    state.wires.some((wire) => wire.id === id) ||
    state.junctions.some((junction) => junction.id === id)
  );
}

function getRawCalls(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed.tool_calls)) return parsed.tool_calls;
  if (isRecord(parsed) && Array.isArray(parsed.calls)) return parsed.calls;
  return [parsed];
}

function normalizeToolCall(raw: unknown): CircuitToolCall | string {
  if (!isRecord(raw)) return "tool call must be an object";

  if (isRecord(raw.function)) {
    const name = raw.function.name;
    if (typeof name !== "string") return "function.name must be a string";
    const parsedArgs = parseArguments(raw.function.arguments);
    if (typeof parsedArgs === "string") return parsedArgs;
    return normalizeByName(name, parsedArgs);
  }

  const name = raw.tool ?? raw.action ?? raw.type ?? raw.name;
  if (typeof name !== "string") return "tool call must include name, action, type, or function.name";

  const args = raw.arguments === undefined ? raw : parseArguments(raw.arguments);
  if (typeof args === "string") return args;

  return normalizeByName(name, args);
}

function parseArguments(value: unknown): Record<string, unknown> | string {
  if (value === undefined || value === null) return {};
  if (isRecord(value)) return value;
  if (typeof value !== "string") return "arguments must be an object or JSON string";

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : "arguments JSON must parse to an object";
  } catch (error) {
    return `arguments JSON parse failed: ${error instanceof Error ? error.message : "invalid JSON"}`;
  }
}

function normalizeByName(name: string, args: Record<string, unknown>): CircuitToolCall | string {
  switch (name) {
    case "inspect_canvas":
    case "review_canvas_visual":
      return { name };
    case "get_component_catalog": {
      return { name };
    }
    case "get_component_detail": {
      if (!Array.isArray(args.names) || !args.names.every((item) => typeof item === "string")) {
        return "get_component_detail requires names array";
      }
      return { name, names: args.names };
    }
    case "clear_canvas":
      return { name };
    case "place_component": {
      const componentName = typeof args.name === "string" ? args.name.trim() : "";
      const origin = getPoint(args.origin);
      const orientation = getOrientation(args.orientation);
      const properties = getObject(args.properties) ?? {};
      if (!componentName) return "place_component requires name";
      if (!origin) return "place_component requires origin point";
      if (!orientation) return "place_component requires orientation h or v";
      return { name, id: getId(args) ?? undefined, componentName, origin, orientation, properties };
    }
    case "move_component": {
      const id = getId(args);
      const origin = getPoint(args.origin);
      const orientation = args.orientation === undefined ? undefined : getOrientation(args.orientation);
      if (!id) return "move_component requires string id";
      if (!origin) return "move_component requires origin point";
      if (args.orientation !== undefined && !orientation) return "move_component orientation must be h or v";
      return { name, id, origin, orientation: orientation ?? undefined };
    }
    case "update_component_properties": {
      const id = getId(args);
      const properties = getObject(args.properties);
      if (!id) return "update_component_properties requires string id";
      if (!properties) return "update_component_properties requires properties object";
      return { name, id, properties };
    }
    case "remove_component": {
      const id = getId(args);
      return id ? { name, id } : "remove_component requires string id";
    }
    case "draw_wire_segment": {
      const start = getPoint(args.start);
      const end = getPoint(args.end);
      if (!start) return "draw_wire_segment requires start point";
      if (!end) return "draw_wire_segment requires end point";
      return { name, id: getId(args) ?? undefined, start, end };
    }
    case "update_wire_segment": {
      const id = getId(args);
      const start = args.start === undefined ? undefined : getPoint(args.start);
      const end = args.end === undefined ? undefined : getPoint(args.end);
      if (!id) return "update_wire_segment requires string id";
      if (args.start !== undefined && !start) return "update_wire_segment start must be a point";
      if (args.end !== undefined && !end) return "update_wire_segment end must be a point";
      if (!start && !end) return "update_wire_segment requires start or end";
      return { name, id, start: start ?? undefined, end: end ?? undefined };
    }
    case "delete_wire_segment": {
      const id = getId(args);
      return id ? { name, id } : "delete_wire_segment requires string id";
    }
    case "add_junction": {
      const point = getPoint(args.point);
      if (!point) return "add_junction requires point";
      return { name, id: getId(args) ?? undefined, point };
    }
    case "move_junction": {
      const id = getId(args);
      const point = getPoint(args.point);
      if (!id) return "move_junction requires string id";
      if (!point) return "move_junction requires point";
      return { name, id, point };
    }
    case "remove_junction": {
      const id = getId(args);
      return id ? { name, id } : "remove_junction requires string id";
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

function getObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function getId(args: Record<string, unknown>): string | null {
  return typeof args.id === "string" && args.id.trim() ? args.id.trim() : null;
}

function getOrientation(value: unknown): Orientation | null {
  return value === "h" || value === "v" ? value : null;
}

function getPoint(value: unknown): Point | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const x = value[0];
  const y = value[1];
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y) ? [x, y] : null;
}

function getToolTargetId(call: CircuitToolCall): string | null {
  return "id" in call && typeof call.id === "string" ? call.id : null;
}

function formatWire(wire: WireSegment): string {
  return `${wire.id} ${formatPoint(wire.start)} -> ${formatPoint(wire.end)}`;
}

function formatPoint(point: Point): string {
  return `[${point[0]},${point[1]}]`;
}

function pointToKey(point: Point): string {
  return `${point[0]},${point[1]}`;
}

function samePoint(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function isAxisAlignedWire(wire: WireSegment): boolean {
  return wire.start[0] === wire.end[0] || wire.start[1] === wire.end[1];
}

function isZeroLengthWire(wire: WireSegment): boolean {
  return wire.start[0] === wire.end[0] && wire.start[1] === wire.end[1];
}

function isInsideCanvas(point: Point, canvasBounds = DEFAULT_CANVAS_BOUNDS): boolean {
  return point[0] >= 0 && point[0] <= canvasBounds.width && point[1] >= 0 && point[1] <= canvasBounds.height;
}

function pointIsOnWire(point: Point, wire: WireSegment): boolean {
  if (!isAxisAlignedWire(wire)) return false;
  const [x, y] = point;
  const [x1, y1] = wire.start;
  const [x2, y2] = wire.end;

  if (y1 === y2) {
    return y === y1 && x >= Math.min(x1, x2) && x <= Math.max(x1, x2);
  }

  return x === x1 && y >= Math.min(y1, y2) && y <= Math.max(y1, y2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}
