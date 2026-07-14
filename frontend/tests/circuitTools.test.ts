import { describe, expect, it } from "vitest";

import { buildToolResultMessages, componentToolSnapshot, createModelCanvasState } from "../src/agentContext";
import {
  COMPONENT_GRID_SIZE,
  CONNECTION_GRID_SIZE,
  GRID_SIZE,
  applyToolCall,
  componentSupportsOrientation,
  createComponentInstance,
  emptyCanvasState,
  getAllowedComponentOrientations,
  getComponentOrientationCapability,
  isComponentOriginOnGrid,
  isCanvasMutatingToolCall,
  isConnectionPointOnGrid,
  parseToolCalls,
  snapCoordinateToGrid,
  snapPointToGridStep,
  validateCanvas,
} from "../src/circuitTools";
import type { CircuitCanvasState, ComponentDetail, ComponentInstance } from "../src/circuitTools";
import type { OpenAiToolCall, ToolExecutionRecord } from "../src/appTypes";

const midpointPortDetail: ComponentDetail = {
  id: null,
  name: "MidpointPort",
  requested_name: "MidpointPort",
  category: "test",
  path: "",
  minsize: "10",
  properties: [],
  property_defaults: {},
  configurations: [],
  matched_configuration: null,
  suggested_properties: {},
  aliases: [],
  connections: [
    {
      name: "port",
      start: "_Middle",
      end: "_Middle",
      edge: "start",
      conditions: "",
    },
  ],
  render: { autorotate: "", shapes: [] },
  definitions: { consts: {}, defs: {} },
};

function midpointPortComponent(id: string, y: number): ComponentInstance {
  return {
    id,
    name: midpointPortDetail.name,
    requestedName: midpointPortDetail.requested_name,
    origin: [100, y],
    orientation: "h",
    size: 10,
    properties: {},
    detail: midpointPortDetail,
  };
}

describe("separate component and connection grids", () => {
  it("classifies discovery and inspection tools as read-only", () => {
    expect(isCanvasMutatingToolCall({ name: "get_component_catalog" })).toBe(false);
    expect(isCanvasMutatingToolCall({ name: "get_component_detail", names: ["Resistor"] })).toBe(false);
    expect(isCanvasMutatingToolCall({ name: "inspect_canvas" })).toBe(false);
    expect(isCanvasMutatingToolCall({ name: "review_canvas_visual" })).toBe(false);
    expect(isCanvasMutatingToolCall({ name: "draw_wire_segment", start: [0, 0], end: [10, 0] })).toBe(true);
  });

  it("keeps the 10px grid alias while allowing 5px connection points", () => {
    expect(COMPONENT_GRID_SIZE).toBe(10);
    expect(CONNECTION_GRID_SIZE).toBe(5);
    expect(GRID_SIZE).toBe(COMPONENT_GRID_SIZE);

    expect(isComponentOriginOnGrid([105, 100])).toBe(false);
    expect(isConnectionPointOnGrid([105, 100])).toBe(true);
    expect(isConnectionPointOnGrid([103, 100])).toBe(false);
  });

  it("rejects a component origin at [105,100]", () => {
    const result = applyToolCall(emptyCanvasState, {
      name: "place_component",
      componentName: "MidpointPort",
      origin: [105, 100],
      orientation: "h",
      properties: {},
    });

    expect(result.trace.status).toBe("error");
    expect(result.trace.detail).toContain("10px grid");
  });

  it("accepts a wire whose endpoints use 5px coordinates", () => {
    const result = applyToolCall(emptyCanvasState, {
      name: "draw_wire_segment",
      start: [105, 100],
      end: [105, 200],
    });

    expect(result.trace.status).toBe("ok");
    expect(result.state.wires[0]).toMatchObject({ start: [105, 100], end: [105, 200] });
  });

  it("connects a wire to component ports at [105,100] without a dangling issue", () => {
    const state: CircuitCanvasState = {
      components: [midpointPortComponent("cmp_1", 100), midpointPortComponent("cmp_2", 200)],
      wires: [{ id: "wire_1", start: [105, 100], end: [105, 200] }],
      junctions: [],
    };

    const report = validateCanvas(state);

    expect(report.status).toBe("valid");
    expect(report.issues).toEqual([]);
  });

  it("accepts junctions on the 5px connection grid and rejects non-grid points", () => {
    const withWire: CircuitCanvasState = {
      components: [],
      wires: [{ id: "wire_1", start: [105, 100], end: [105, 200] }],
      junctions: [],
    };

    const accepted = applyToolCall(withWire, { name: "add_junction", point: [105, 155] });
    const rejected = applyToolCall(withWire, { name: "add_junction", point: [105, 153] });

    expect(accepted.trace.status).toBe("ok");
    expect(rejected.trace.status).toBe("error");
    expect(rejected.trace.detail).toContain("5px grid");
  });
});

describe("component orientation capabilities", () => {
  const horizontalOnlyDetail: ComponentDetail = {
    ...midpointPortDetail,
    name: "Adder",
    requested_name: "Adder",
    flags: ["HorizontalOnly"],
  };

  it("derives allowed orientations from XML flags and existing autorotate data", () => {
    expect(getAllowedComponentOrientations(horizontalOnlyDetail)).toEqual(["h"]);
    expect(getComponentOrientationCapability(horizontalOnlyDetail)).toBe("HorizontalOnly");
    expect(componentSupportsOrientation(horizontalOnlyDetail, "v")).toBe(false);

    const autoRotateDetail: ComponentDetail = {
      ...midpointPortDetail,
      flags: [],
      render: { autorotate: "HorizontalToVertical", shapes: [] },
    };
    expect(getAllowedComponentOrientations(autoRotateDetail)).toEqual(["h", "v"]);
    expect(getComponentOrientationCapability(autoRotateDetail)).toBe("HorizontalToVertical");
  });

  it("rejects unsupported placement and movement orientations", () => {
    const placed = createComponentInstance(
      {
        name: "place_component",
        componentName: "Adder",
        origin: [100, 100],
        orientation: "v",
        properties: {},
      },
      horizontalOnlyDetail,
      "cmp_1"
    );
    expect(placed.component).toBeNull();
    expect(placed.error).toContain("use h only");

    const state: CircuitCanvasState = {
      components: [{
        id: "cmp_1",
        name: "Adder",
        requestedName: "Adder",
        origin: [100, 100],
        orientation: "h",
        size: 140,
        properties: {},
        detail: horizontalOnlyDetail,
      }],
      wires: [],
      junctions: [],
    };
    const moved = applyToolCall(state, {
      name: "move_component",
      id: "cmp_1",
      origin: [100, 100],
      orientation: "v",
    });
    expect(moved.trace.status).toBe("error");
    expect(moved.trace.detail).toContain("use h only");
  });

  it("marks legacy invalid canvas orientations for review", () => {
    const state: CircuitCanvasState = {
      components: [{
        id: "cmp_1",
        name: "Adder",
        requestedName: "Adder",
        origin: [100, 100],
        orientation: "v",
        size: 140,
        properties: {},
        detail: horizontalOnlyDetail,
      }],
      wires: [],
      junctions: [],
    };
    const report = validateCanvas(state);
    expect(report.status).toBe("needs review");
    expect(report.issues.some((issue) => issue.message.includes("does not support orientation v"))).toBe(true);
  });

  it("reuses render_summary.autorotate in the Agent tool result without adding orientation fields", () => {
    const toolCall: OpenAiToolCall = {
      id: "call_detail",
      type: "function",
      function: { name: "get_component_detail", arguments: '{"names":["Adder"]}' },
    };
    const record: ToolExecutionRecord = {
      call: { name: "get_component_detail", names: ["Adder"] },
      result: {
        state: emptyCanvasState,
        activeId: null,
        trace: { id: "component-detail", action: "get_component_detail", detail: "1/1 components", status: "ok" },
        toolResult: { status: "executed", components: [horizontalOnlyDetail], errors: [] },
      },
    };

    const [message] = buildToolResultMessages(
      [toolCall],
      [record],
      emptyCanvasState,
      { width: 1280, height: 720 }
    );
    const payload = JSON.parse(message.content) as {
      result: { components: Array<Record<string, unknown>> };
    };
    const detail = payload.result.components[0];
    expect(detail.render_summary).toEqual({ autorotate: "HorizontalOnly" });
    expect(detail).not.toHaveProperty("allowed_orientations");
    expect(detail).not.toHaveProperty("flags");
  });
});

describe("component label semantics", () => {
  it("reports Reference as the visible label and keeps Value as the parameter value", () => {
    const diodeDetail: ComponentDetail = {
      ...midpointPortDetail,
      name: "Alternative Diode",
      requested_name: "Alternative Diode",
      properties: [
        { name: "Reference", type: "string", default: "", serialize: "reference", display: "Reference", options: [] },
        { name: "Value", type: "string", default: "", serialize: "value", display: "Value", options: [] },
      ],
      render: {
        autorotate: "",
        shapes: [
          { type: "text", conditions: "$Reference", autorotate: "Off", attrs: { value: "$Reference", x: "_Middle", y: "_Middle-23", align: "BottomCentre" } },
          { type: "text", conditions: "$Value", autorotate: "Off", attrs: { value: "$Value", x: "_Middle", y: "_Middle-13", align: "BottomCentre" } },
        ],
      },
    };
    const component: ComponentInstance = {
      id: "cmp_diode",
      name: diodeDetail.name,
      requestedName: diodeDetail.requested_name,
      origin: [100, 100],
      orientation: "h",
      size: 40,
      properties: { Reference: "D1", Value: "1N4148" },
      detail: diodeDetail,
    };

    expect(componentToolSnapshot(component)).toMatchObject({
      visible_label: "D1",
      visible_value: "1N4148",
    });
  });

  it("does not mistake a meter's fixed internal glyph for its visible value", () => {
    const meterDetail: ComponentDetail = {
      ...midpointPortDetail,
      name: "Meter",
      requested_name: "Voltmeter",
      properties: [
        { name: "Type", type: "enum", default: "Voltmeter", serialize: "t", display: "Type", options: ["Voltmeter"] },
        { name: "Text", type: "string", default: "", serialize: "text", display: "Text", options: [] },
      ],
      render: {
        autorotate: "",
        shapes: [
          { type: "text", conditions: "$Type==Voltmeter", autorotate: "Off", attrs: { value: "V", x: "_Middle", y: "_Middle", align: "CentreCentre" } },
          { type: "text", conditions: "$Text", autorotate: "Off", attrs: { value: "$Text", x: "_Middle", y: "_Middle-24", align: "BottomCentre", "data-role": "universal-label" } },
        ],
      },
    };
    const component: ComponentInstance = {
      id: "cmp_meter",
      name: meterDetail.name,
      requestedName: meterDetail.requested_name,
      origin: [100, 100],
      orientation: "h",
      size: 40,
      properties: { Type: "Voltmeter", Text: "V1" },
      detail: meterDetail,
    };

    expect(componentToolSnapshot(component)).toMatchObject({ visible_label: "V1", visible_value: "" });
  });
});

describe("boundary-safe grid snapping", () => {
  it("never snaps past a canvas edge that is not grid-aligned", () => {
    expect(snapCoordinateToGrid(999, 997, CONNECTION_GRID_SIZE)).toBe(995);
    expect(snapCoordinateToGrid(999, 997, COMPONENT_GRID_SIZE)).toBe(990);
    expect(snapPointToGridStep([999, 999], { width: 997, height: 993 }, CONNECTION_GRID_SIZE)).toEqual([995, 990]);
  });
});

describe("model canvas grid metadata", () => {
  it("publishes explicit component and connection grids while preserving grid", () => {
    const modelState = createModelCanvasState(emptyCanvasState, { width: 997, height: 993 });

    expect(modelState.canvas).toMatchObject({
      width: 997,
      height: 993,
      component_grid: 10,
      connection_grid: 5,
      grid: 10,
      major_grid: 50,
    });
  });
});

describe("visual review tool parsing", () => {
  it("accepts the no-argument visual review call", () => {
    const parsed = parseToolCalls(JSON.stringify({
      id: "call_visual",
      type: "function",
      function: { name: "review_canvas_visual", arguments: "{}" },
    }));
    expect(parsed.error).toBeNull();
    expect(parsed.calls).toEqual([{ name: "review_canvas_visual" }]);
  });
});
