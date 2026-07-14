import { getComponentConnectionPoints } from "./ComponentRenderer";
import {
  CONNECTION_GRID_SIZE,
  getAllowedComponentOrientations,
  isConnectionPointOnGrid,
  type ComponentDetail,
  type ComponentInstance,
  type Orientation,
  type Point,
} from "./circuitTools";

export type ComponentPortIntegrityIssueCode =
  | "invalid_component"
  | "invalid_size"
  | "invalid_connections"
  | "invalid_orientation_flags"
  | "port_resolution_failed"
  | "invalid_port_coordinate"
  | "off_grid_port";

export type ComponentPortIntegrityIssue = {
  code: ComponentPortIntegrityIssueCode;
  component: string;
  componentIndex: number;
  message: string;
  orientation?: Orientation;
  port?: string;
  point?: Point;
};

export type ComponentLibraryIntegrityReport = {
  valid: boolean;
  gridSize: number;
  checkedComponents: number;
  checkedOrientations: number;
  checkedPorts: number;
  issues: ComponentPortIntegrityIssue[];
};

/**
 * Checks the ports produced by the same resolver used by the canvas renderer.
 * Every component is tested at the origin with its default/suggested properties
 * in every orientation allowed by its XML flags. Malformed assets are reported
 * and never abort the scan.
 */
export function checkComponentLibraryPortGrid(
  details: readonly ComponentDetail[] | null | undefined
): ComponentLibraryIntegrityReport {
  if (!Array.isArray(details)) {
    const issue: ComponentPortIntegrityIssue = {
      code: "invalid_component",
      component: "component-library",
      componentIndex: -1,
      message: "Component library must be an array; no port checks were run.",
    };
    return createReport(0, 0, 0, [issue]);
  }

  const issues: ComponentPortIntegrityIssue[] = [];
  let checkedOrientations = 0;
  let checkedPorts = 0;

  details.forEach((detail, componentIndex) => {
    const component = componentLabel(detail, componentIndex);
    if (!isRecord(detail)) {
      issues.push({
        code: "invalid_component",
        component,
        componentIndex,
        message: `${component}: component detail is missing or malformed; port checks were skipped.`,
      });
      return;
    }

    const componentDetail = detail as unknown as ComponentDetail;

    const size = parseComponentSize(componentDetail.minsize);
    if (size === null) {
      issues.push({
        code: "invalid_size",
        component,
        componentIndex,
        message: `${component}: minsize ${formatValue(componentDetail.minsize)} must be a positive finite number; h/v port checks were skipped.`,
      });
      return;
    }

    if (!Array.isArray(componentDetail.connections)) {
      issues.push({
        code: "invalid_connections",
        component,
        componentIndex,
        message: `${component}: connections must be an array; h/v port checks were skipped.`,
      });
      return;
    }

    const orientations = getAllowedComponentOrientations(componentDetail);
    if (orientations.length === 0) {
      issues.push({
        code: "invalid_orientation_flags",
        component,
        componentIndex,
        message: `${component}: XML flags cannot declare both HorizontalOnly and VerticalOnly.`,
      });
      return;
    }

    orientations.forEach((orientation) => {
      const instance = createDefaultInstance(componentDetail, componentIndex, orientation, size);

      try {
        const ports = getComponentConnectionPoints(instance);
        checkedOrientations += 1;
        checkedPorts += ports.length;

        ports.forEach((port, portIndex) => {
          const portName = typeof port.name === "string" && port.name.trim() ? port.name : `port-${portIndex + 1}`;
          if (!isFinitePoint(port.point)) {
            issues.push({
              code: "invalid_port_coordinate",
              component,
              componentIndex,
              orientation,
              port: portName,
              message: `${component} [${orientation}] port "${portName}" resolved to an invalid coordinate.`,
            });
            return;
          }

          if (!isConnectionPointOnGrid(port.point)) {
            issues.push({
              code: "off_grid_port",
              component,
              componentIndex,
              orientation,
              port: portName,
              point: port.point,
              message: `${component} [${orientation}] port "${portName}" resolved to ${formatPoint(port.point)}, outside the ${CONNECTION_GRID_SIZE}px connection grid.`,
            });
          }
        });
      } catch (error) {
        issues.push({
          code: "port_resolution_failed",
          component,
          componentIndex,
          orientation,
          message: `${component} [${orientation}] port resolution failed: ${errorMessage(error)}.`,
        });
      }
    });
  });

  return createReport(details.length, checkedOrientations, checkedPorts, issues);
}

function createReport(
  checkedComponents: number,
  checkedOrientations: number,
  checkedPorts: number,
  issues: ComponentPortIntegrityIssue[]
): ComponentLibraryIntegrityReport {
  return {
    valid: issues.length === 0,
    gridSize: CONNECTION_GRID_SIZE,
    checkedComponents,
    checkedOrientations,
    checkedPorts,
    issues,
  };
}

function createDefaultInstance(
  detail: ComponentDetail,
  componentIndex: number,
  orientation: Orientation,
  size: number
): ComponentInstance {
  return {
    id: `integrity-${componentIndex}-${orientation}`,
    name: componentLabel(detail, componentIndex),
    requestedName: typeof detail.requested_name === "string" ? detail.requested_name : "",
    origin: [0, 0],
    orientation,
    size,
    properties: {
      ...stringRecord(detail.property_defaults),
      ...stringRecord(detail.suggested_properties),
    },
    detail,
  };
}

function parseComponentSize(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const size = Number(value.trim());
  return Number.isFinite(size) && size > 0 ? size : null;
}

function componentLabel(detail: unknown, componentIndex: number): string {
  if (isRecord(detail) && typeof detail.name === "string" && detail.name.trim()) return detail.name.trim();
  return `component-${componentIndex + 1}`;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function isFinitePoint(value: unknown): value is Point {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

function formatPoint(point: Point): string {
  return `[${point[0]}, ${point[1]}]`;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value.trim() ? JSON.stringify(value) : "(missing)";
  return value === undefined || value === null ? "(missing)" : JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "unknown component definition error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
