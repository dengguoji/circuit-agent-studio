import { getComponentBounds, getComponentConnectionPoints, getComponentVisibleTexts } from "./ComponentRenderer";
import {
  COMPONENT_GRID_SIZE,
  CONNECTION_GRID_SIZE,
  GRID_SIZE,
  MAJOR_GRID_SIZE,
  getComponentLabelPropertyName,
  getComponentOrientationCapability,
  validateCanvas,
} from "./circuitTools";
import { pointIsOnWireSegment, samePoint } from "./geometry";
import type { AgentMessage, OpenAiToolCall, ToolExecutionRecord } from "./appTypes";
import type { CanvasBounds, CircuitCanvasState, ComponentDetail, ComponentInstance, Point, WireSegment } from "./circuitTools";

export function buildToolResultMessages(
  toolCalls: OpenAiToolCall[],
  records: ToolExecutionRecord[],
  canvasState: CircuitCanvasState,
  canvasBounds: CanvasBounds
): AgentMessage[] {
  const validation = validateCanvas(canvasState, canvasBounds);
  const modelCanvasState = createModelCanvasState(canvasState, canvasBounds);

  return toolCalls.map((toolCall, index) => {
    const result = records[index]?.result;
    const status = result?.trace.status === "ok" ? "executed" : "error";
    const payload: Record<string, unknown> = {
      status,
      name: toolCall.function.name,
      result: compactToolResultForModel(result?.toolResult ?? null),
    };

    if (toolCall.function.name === "inspect_canvas") {
      payload.current_canvas_state = modelCanvasState;
      payload.current_canvas_bounds = canvasBounds;
    } else if (validation.issues.length > 0) {
      payload.issues = validation.issues;
    }

    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(payload, null, 2),
    };
  });
}

export function componentToolSnapshot(component: ComponentInstance) {
  const visibleText = getVisibleComponentText(component);
  return {
    id: component.id,
    name: component.name,
    requested_name: component.requestedName,
    origin: component.origin,
    orientation: component.orientation,
    bbox: getComponentBBox(component),
    connection_points: getModelConnectionPoints(component),
    visible_label: visibleText.label,
    visible_value: visibleText.value,
    properties: component.properties,
  };
}

export function createModelCanvasState(state: CircuitCanvasState, canvasBounds: CanvasBounds) {
  const validation = validateCanvas(state, canvasBounds);
  const componentConnectionPoints = state.components.flatMap((component) =>
    getComponentConnectionPoints(component).map((connection) => ({
      component,
      connection,
      connectedTo: getPointConnections(state, connection.point, { componentId: component.id }),
    }))
  );

  const wireSnapshots = state.wires.map((wire) => ({
    id: wire.id,
    start: wire.start,
    end: wire.end,
    orientation: getWireOrientation(wire),
    length: getWireLength(wire),
    start_connections: getPointConnections(state, wire.start, { wireId: wire.id }),
    end_connections: getPointConnections(state, wire.end, { wireId: wire.id }),
  }));

  const openComponentPoints = componentConnectionPoints
    .filter((item) => item.connectedTo.length === 0)
    .map((item) => ({
      component_id: item.component.id,
      component_name: item.component.name,
      connection_name: item.connection.name,
      point: item.connection.point,
    }));

  const danglingWireEndpoints = wireSnapshots.flatMap((wire) => {
    const endpoints: Array<{ wire_id: string; endpoint: "start" | "end"; point: Point }> = [];
    if (wire.start_connections.length === 0) endpoints.push({ wire_id: wire.id, endpoint: "start", point: wire.start });
    if (wire.end_connections.length === 0) endpoints.push({ wire_id: wire.id, endpoint: "end", point: wire.end });
    return endpoints;
  });

  return {
    canvas: {
      width: canvasBounds.width,
      height: canvasBounds.height,
      component_grid: COMPONENT_GRID_SIZE,
      connection_grid: CONNECTION_GRID_SIZE,
      grid: GRID_SIZE,
      major_grid: MAJOR_GRID_SIZE,
    },
    summary: {
      components: state.components.length,
      wires: state.wires.length,
      junctions: state.junctions.length,
      status: validation.status,
    },
    components: state.components.map((component) => ({
      id: component.id,
      name: component.name,
      requested_name: component.requestedName,
      origin: component.origin,
      orientation: component.orientation,
      properties: component.properties,
      bbox: getComponentBBox(component),
      connection_points: getModelConnectionPoints(component).map((connection) => ({
        name: connection.name,
        point: connection.point,
        edge: connection.edge,
        connected_to: getPointConnections(state, connection.point, { componentId: component.id }),
      })),
    })),
    wires: wireSnapshots,
    junctions: state.junctions.map((junction) => ({
      id: junction.id,
      point: junction.point,
      manual: Boolean(junction.manual),
    })),
    connectivity: {
      open_component_points: openComponentPoints,
      dangling_wire_endpoints: danglingWireEndpoints,
    },
    validation,
    next_action_hint: getNextActionHint(state, validation, openComponentPoints.length, danglingWireEndpoints.length),
  };
}

function getComponentBBox(component: ComponentInstance) {
  const bounds = getComponentBounds(component);
  return {
    top_left: [bounds.x, bounds.y] as Point,
    bottom_right: [bounds.x + bounds.width, bounds.y + bounds.height] as Point,
    size: [bounds.width, bounds.height] as Point,
  };
}

function getModelConnectionPoints(component: ComponentInstance) {
  return getComponentConnectionPoints(component).map((connection) => ({
    name: connection.name,
    point: connection.point,
    edge: connection.edge,
  }));
}

function getVisibleComponentText(component: ComponentInstance) {
  const texts = getComponentVisibleTexts(component);
  const labelProperty = getComponentLabelPropertyName(component.detail);
  const propertyNames = new Set(component.detail.properties.map((property) => property.name));
  const label = texts.find((text) => text.property === labelProperty)?.value ?? "";
  const value = texts.find(
    (text) => text.property !== null && text.property !== labelProperty && propertyNames.has(text.property)
  )?.value ?? "";
  return { label, value };
}

function sanitizeToolResultForModel(result: unknown): unknown {
  if (!isPlainObject(result)) return result;

  const sanitized: Record<string, unknown> = {};
  Object.entries(result).forEach(([key, value]) => {
    if (key === "canvas_state" || key === "canvas_bounds") return;
    if (key === "components" && Array.isArray(value)) {
      sanitized[key] = value.map((item) => (isComponentDetailLike(item) ? componentDetailForModel(item) : item));
      return;
    }
    sanitized[key] = value;
  });
  return sanitized;
}

function compactToolResultForModel(result: unknown): unknown {
  const sanitized = sanitizeToolResultForModel(result);
  if (!isPlainObject(sanitized)) return sanitized;

  const { status: _status, ...rest } = sanitized;
  return rest;
}

function componentDetailForModel(detail: ComponentDetail) {
  return {
    name: detail.name,
    requested_name: detail.requested_name,
    category: detail.category,
    minsize: detail.minsize,
    aliases: detail.aliases,
    properties: detail.properties.map((property) => ({
      name: property.name,
      type: property.type,
      default: property.default,
      display: property.display,
      options: property.options,
    })),
    property_defaults: detail.property_defaults,
    configurations: detail.configurations.map((configuration) => ({
      name: configuration.name,
      value: configuration.value,
      implements: configuration.implements,
      properties: configuration.properties,
    })),
    matched_configuration: detail.matched_configuration
      ? {
          name: detail.matched_configuration.name,
          value: detail.matched_configuration.value,
          implements: detail.matched_configuration.implements,
          properties: detail.matched_configuration.properties,
        }
      : null,
    suggested_properties: detail.suggested_properties,
    connections: detail.connections.map((connection) => ({
      name: connection.name,
      start: connection.start,
      end: connection.end,
      edge: connection.edge,
      conditions: connection.conditions,
    })),
    render_summary: {
      autorotate: getComponentOrientationCapability(detail),
    },
  };
}

function getPointConnections(
  state: CircuitCanvasState,
  point: Point,
  exclude: { componentId?: string; wireId?: string; junctionId?: string } = {}
): string[] {
  const connections: string[] = [];

  state.components.forEach((component) => {
    if (component.id === exclude.componentId) return;
    getComponentConnectionPoints(component).forEach((connection) => {
      if (samePoint(connection.point, point)) {
        connections.push(`${component.id}.${connection.name}`);
      }
    });
  });

  state.wires.forEach((wire) => {
    if (wire.id === exclude.wireId) return;
    if (samePoint(wire.start, point)) connections.push(`${wire.id}.start`);
    if (samePoint(wire.end, point)) connections.push(`${wire.id}.end`);
    if (!samePoint(wire.start, point) && !samePoint(wire.end, point) && pointIsOnWireSegment(point, wire)) {
      connections.push(`${wire.id}.segment`);
    }
  });

  state.junctions.forEach((junction) => {
    if (junction.id === exclude.junctionId) return;
    if (samePoint(junction.point, point)) connections.push(junction.id);
  });

  return connections;
}

function getNextActionHint(state: CircuitCanvasState, validation: ReturnType<typeof validateCanvas>, openPorts: number, danglingEndpoints: number): string {
  if (validation.issues.length > 0) {
    return `fix_validation_issues: ${validation.issues.slice(0, 3).map((issue) => `${issue.id} ${issue.message}`).join("; ")}`;
  }
  if (state.components.length === 0 && state.wires.length === 0) {
    return "canvas_empty: identify required components first, then place components and draw explicit wire segments";
  }
  if (state.components.length > 0 && state.wires.length === 0) {
    return "components_placed_no_wires: use component connection_points to draw horizontal or vertical wire segments";
  }
  if (openPorts > 0 || danglingEndpoints > 0) {
    return `review_connectivity: ${openPorts} open component points, ${danglingEndpoints} dangling wire endpoints`;
  }
  return "layout_valid: compare against the user request or image; stop if the circuit is complete, otherwise continue with explicit tool calls";
}

function getWireOrientation(wire: WireSegment): "h" | "v" | "invalid" {
  if (wire.start[1] === wire.end[1]) return "h";
  if (wire.start[0] === wire.end[0]) return "v";
  return "invalid";
}

function getWireLength(wire: WireSegment): number {
  return Math.abs(wire.end[0] - wire.start[0]) + Math.abs(wire.end[1] - wire.start[1]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isComponentDetailLike(value: unknown): value is ComponentDetail {
  return isPlainObject(value) && isPlainObject(value.render) && isPlainObject(value.definitions) && Array.isArray(value.properties);
}
