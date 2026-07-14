import { describe, expect, it } from "vitest";

import { checkComponentLibraryPortGrid } from "../src/componentIntegrity";
import type { ComponentConnection, ComponentDetail } from "../src/circuitTools";

function componentDetail(overrides: Partial<ComponentDetail> = {}): ComponentDetail {
  return {
    id: null,
    name: "Test component",
    requested_name: "Test component",
    category: "test",
    path: "test.xml",
    minsize: "10",
    properties: [],
    property_defaults: {},
    configurations: [],
    matched_configuration: null,
    suggested_properties: {},
    aliases: [],
    connections: [connection("left", "_Start"), connection("right", "_End")],
    render: { autorotate: "", shapes: [] },
    definitions: { consts: {}, defs: {} },
    ...overrides,
  };
}

function connection(name: string, location: string, conditions = ""): ComponentConnection {
  return {
    name,
    start: location,
    end: location,
    edge: "start",
    conditions,
  };
}

describe("component library port-grid integrity", () => {
  it("checks every resolved port in horizontal and vertical orientations", () => {
    const report = checkComponentLibraryPortGrid([componentDetail()]);

    expect(report).toMatchObject({
      valid: true,
      gridSize: 5,
      checkedComponents: 1,
      checkedOrientations: 2,
      checkedPorts: 4,
      issues: [],
    });
  });

  it("checks only orientations allowed by XML flags", () => {
    const report = checkComponentLibraryPortGrid([
      componentDetail({ flags: ["HorizontalOnly"] }),
    ]);

    expect(report).toMatchObject({
      valid: true,
      checkedComponents: 1,
      checkedOrientations: 1,
      checkedPorts: 2,
      issues: [],
    });
  });

  it("reports conflicting orientation flags", () => {
    const report = checkComponentLibraryPortGrid([
      componentDetail({ flags: ["HorizontalOnly", "VerticalOnly"] }),
    ]);

    expect(report.valid).toBe(false);
    expect(report.checkedOrientations).toBe(0);
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "invalid_orientation_flags", component: "Test component" }),
    ]);
  });

  it("reports off-grid midpoint ports for both orientations", () => {
    const report = checkComponentLibraryPortGrid([
      componentDetail({
        name: "Odd midpoint",
        minsize: "15",
        connections: [connection("middle", "_Middle")],
      }),
    ]);

    expect(report.valid).toBe(false);
    expect(report.checkedPorts).toBe(2);
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "off_grid_port", component: "Odd midpoint", orientation: "h", point: [7.5, 0] }),
      expect.objectContaining({ code: "off_grid_port", component: "Odd midpoint", orientation: "v", point: [0, 7.5] }),
    ]);
    expect(report.issues[0].message).toContain("5px connection grid");
  });

  it("uses default and suggested properties when resolving active ports", () => {
    const report = checkComponentLibraryPortGrid([
      componentDetail({
        minsize: "15",
        property_defaults: { Enabled: "false" },
        suggested_properties: { Enabled: "true" },
        connections: [connection("conditional-middle", "_Middle", "$Enabled")],
      }),
    ]);

    expect(report.checkedPorts).toBe(2);
    expect(report.issues.map((issue) => issue.orientation)).toEqual(["h", "v"]);
  });

  it.each([undefined, "", "not-a-number", "0", "-10", "Infinity"])(
    "reports invalid minsize %s without throwing",
    (minsize) => {
      const malformed = componentDetail({ name: "Bad size", minsize: minsize as string });

      expect(() => checkComponentLibraryPortGrid([malformed])).not.toThrow();
      expect(checkComponentLibraryPortGrid([malformed]).issues).toEqual([
        expect.objectContaining({ code: "invalid_size", component: "Bad size" }),
      ]);
    }
  );

  it("isolates a malformed component and continues checking later assets", () => {
    const malformed = componentDetail({
      name: "Broken connection",
      connections: [{ ...connection("broken", "_Start"), edge: null as unknown as string }],
    });
    const valid = componentDetail({ name: "Still checked" });

    const report = checkComponentLibraryPortGrid([malformed, valid]);

    expect(report.issues).toEqual([
      expect.objectContaining({ code: "port_resolution_failed", component: "Broken connection", orientation: "h" }),
      expect.objectContaining({ code: "port_resolution_failed", component: "Broken connection", orientation: "v" }),
    ]);
    expect(report.checkedComponents).toBe(2);
    expect(report.checkedOrientations).toBe(2);
    expect(report.checkedPorts).toBe(4);
  });

  it("returns a readable issue for a missing connections collection", () => {
    const malformed = componentDetail({
      name: "Missing connections",
      connections: undefined as unknown as ComponentConnection[],
    });

    const report = checkComponentLibraryPortGrid([malformed]);

    expect(report.issues).toEqual([
      expect.objectContaining({ code: "invalid_connections", component: "Missing connections" }),
    ]);
    expect(report.issues[0].message).toContain("connections must be an array");
  });

  it("does not throw when the library value itself is absent", () => {
    const report = checkComponentLibraryPortGrid(undefined);

    expect(report.valid).toBe(false);
    expect(report.issues[0]).toMatchObject({ code: "invalid_component", component: "component-library" });
  });
});
