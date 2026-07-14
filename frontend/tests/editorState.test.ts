import { describe, expect, it } from "vitest";

import { reconcileCanvasComponentDetails } from "../src/editorState";
import type { CircuitCanvasState, ComponentDetail } from "../src/circuitTools";


function detail(flags?: string[]): ComponentDetail {
  return {
    id: null,
    name: "Adder",
    requested_name: "Adder",
    category: "test",
    path: "adder.xml",
    minsize: "140",
    properties: [],
    property_defaults: {},
    configurations: [],
    matched_configuration: null,
    suggested_properties: {},
    aliases: ["Full Adder"],
    flags,
    connections: [],
    render: { autorotate: "", shapes: [] },
    definitions: { consts: {}, defs: {} },
  };
}


describe("canvas component detail reconciliation", () => {
  it("refreshes persisted details and repairs an unsupported legacy orientation", () => {
    const legacyDetail = detail();
    const currentDetail = detail(["HorizontalOnly"]);
    const state: CircuitCanvasState = {
      components: [{
        id: "cmp_1",
        name: "Adder",
        requestedName: "Full Adder",
        origin: [100, 100],
        orientation: "v",
        size: 140,
        properties: {},
        detail: legacyDetail,
      }],
      wires: [],
      junctions: [],
    };

    const reconciled = reconcileCanvasComponentDetails(state, [currentDetail]);

    expect(reconciled.components[0].orientation).toBe("h");
    expect(reconciled.components[0].detail).toBe(currentDetail);
  });

  it("preserves a supported vertical orientation", () => {
    const currentDetail = detail([]);
    const state: CircuitCanvasState = {
      components: [{
        id: "cmp_1",
        name: "Adder",
        requestedName: "Adder",
        origin: [100, 100],
        orientation: "v",
        size: 140,
        properties: {},
        detail: currentDetail,
      }],
      wires: [],
      junctions: [],
    };

    expect(reconcileCanvasComponentDetails(state, [currentDetail])).toBe(state);
  });

  it("drops a legacy injected Text when the refreshed asset owns Reference", () => {
    const currentDetail: ComponentDetail = {
      ...detail([]),
      name: "Alternative Diode",
      requested_name: "Alternative Diode",
      aliases: ["Diode"],
      properties: [{
        name: "Reference",
        type: "string",
        default: "D1",
        serialize: "reference",
        display: "Reference",
        options: [],
      }],
      property_defaults: { Reference: "D1" },
    };
    const state: CircuitCanvasState = {
      components: [{
        id: "cmp_1",
        name: "Alternative Diode",
        requestedName: "Diode",
        origin: [100, 100],
        orientation: "h",
        size: 40,
        properties: { Reference: "D1", Text: "元件1" },
        detail: detail([]),
      }],
      wires: [],
      junctions: [],
    };

    const reconciled = reconcileCanvasComponentDetails(state, [currentDetail]);

    expect(reconciled.components[0].properties).toEqual({ Reference: "D1" });
  });

  it("migrates a legacy Text value into an empty Reference", () => {
    const currentDetail: ComponentDetail = {
      ...detail([]),
      name: "Alternative Diode",
      requested_name: "Alternative Diode",
      aliases: ["Diode"],
      properties: [{
        name: "Reference",
        type: "string",
        default: "",
        serialize: "reference",
        display: "Reference",
        options: [],
      }],
      property_defaults: { Reference: "" },
    };
    const state: CircuitCanvasState = {
      components: [{
        id: "cmp_1",
        name: "Alternative Diode",
        requestedName: "Diode",
        origin: [100, 100],
        orientation: "h",
        size: 40,
        properties: { Reference: "", Text: "D7" },
        detail: detail([]),
      }],
      wires: [],
      junctions: [],
    };

    expect(reconcileCanvasComponentDetails(state, [currentDetail]).components[0].properties).toEqual({ Reference: "D7" });
  });
});
