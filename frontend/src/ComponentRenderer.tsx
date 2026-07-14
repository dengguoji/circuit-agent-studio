import { componentSupportsOrientation } from "./circuitTools";
import type { ComponentConnection, ComponentInstance, ComponentRenderShape, Point } from "./circuitTools";

type LocalPoint = { x: number; y: number };
type LocalBounds = { left: number; top: number; right: number; bottom: number };

const UNIVERSAL_LABEL_ROLE = "universal-label";
const UNIVERSAL_LABEL_GAP = 8;
const DEFAULT_TEXT_SIZE = 11;
const LARGE_TEXT_SIZE = 13;

export type AbsoluteConnectionPoint = {
  name: string;
  point: Point;
  start: Point;
  end: Point;
  edge: string;
};

export type ComponentBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ComponentVisibleText = {
  source: string;
  value: string;
  property: string | null;
};

type Props = {
  component: ComponentInstance;
  active: boolean;
  className?: string;
};

export function ComponentRenderer({ component, active, className }: Props) {
  const transform = `translate(${component.origin[0]} ${component.origin[1]})`;
  const visibleShapes = component.detail.render.shapes.filter((shape) => evalConditions(shape.conditions, component));
  const classes = [active ? "component activeComponent" : "component", className].filter(Boolean).join(" ");

  return (
    <g className={classes} transform={transform}>
      {visibleShapes.map((shape, index) => renderOrientedShape(component, shape, `${component.id}-${index}`))}
      {active && (
        <g className="connectionDebugLayer">
          {getComponentConnectionPoints(component).map((connection, index) => {
            const local = canvasToTranslatedLocal(component, connection.point);
            return <circle key={`${connection.name}-${index}`} cx={local.x} cy={local.y} r={3} className="connectionDot" />;
          })}
        </g>
      )}
    </g>
  );
}

export function getComponentConnectionPoints(component: ComponentInstance): AbsoluteConnectionPoint[] {
  return component.detail.connections
    .filter((connection) => evalConditions(connection.conditions, component))
    .map((connection) => {
      const start = resolveLocation(connection.start, component);
      const end = resolveLocation(connection.end, component);
      const localPoint = getConnectionLocalPoint(connection, start, end);
      return {
        name: connection.name,
        point: toCanvasPoint(component, localPoint),
        start: toCanvasPoint(component, start),
        end: toCanvasPoint(component, end),
        edge: connection.edge,
      };
    });
}

export function getComponentBounds(component: ComponentInstance): ComponentBounds {
  const size = component.size;
  const pad = Math.max(40, size / 2);
  const points = [
    toCanvasPoint(component, { x: 0, y: 0 }),
    toCanvasPoint(component, { x: size, y: 0 }),
    toCanvasPoint(component, { x: 0, y: -pad }),
    toCanvasPoint(component, { x: size, y: -pad }),
    toCanvasPoint(component, { x: 0, y: pad }),
    toCanvasPoint(component, { x: size, y: pad }),
    ...getComponentConnectionPoints(component).flatMap((connection) => [connection.start, connection.end, connection.point]),
    ...getVisibleTextLocalBounds(component).flatMap((bounds) => [
      [component.origin[0] + bounds.left, component.origin[1] + bounds.top] as Point,
      [component.origin[0] + bounds.right, component.origin[1] + bounds.bottom] as Point,
    ]),
  ];
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };
}

export function getComponentVisibleTexts(component: ComponentInstance): ComponentVisibleText[] {
  return component.detail.render.shapes
    .filter((shape) => shape.type === "text" && evalConditions(shape.conditions, component))
    .map((shape) => {
      const source = shape.attrs.value ?? "";
      return {
        source,
        value: resolveText(source, component),
        property: source.match(/\$([A-Za-z][A-Za-z0-9_]*)/)?.[1] ?? null,
      };
    })
    .filter((text) => text.value.trim().length > 0);
}

function getVisibleTextLocalBounds(component: ComponentInstance): LocalBounds[] {
  return component.detail.render.shapes
    .filter((shape) => shape.type === "text" && evalConditions(shape.conditions, component))
    .map((shape) => getTextLocalBounds(component, shape))
    .filter((bounds): bounds is LocalBounds => bounds !== null);
}

function getTextLocalBounds(component: ComponentInstance, shape: ComponentRenderShape): LocalBounds | null {
  const rawValue = shape.attrs.value ?? "";
  const value = resolveText(rawValue, component);
  if (!value) return null;

  const autoRotate = shapeUsesAutoRotate(component, shape);
  const point = isUniversalLabelShape(shape)
    ? getUniversalLabelPoint(component)
    : adjustTextPoint(
        component,
        rawValue,
        {
          x: resolveScalar(shape.attrs.x ?? "_Middle", "x", component, autoRotate),
          y: resolveScalar(shape.attrs.y ?? "_Middle", "y", component, autoRotate),
        },
        autoRotate
      );
  const align = getTextAlign(component, rawValue, shape.attrs.align ?? "CentreCentre", autoRotate);
  const fontSize = shape.attrs.size === "large" ? LARGE_TEXT_SIZE : DEFAULT_TEXT_SIZE;
  const bounds = estimateTextBounds(point, value, fontSize, align);
  return component.orientation === "v" && autoRotate ? rotateBoundsClockwise(bounds) : bounds;
}

function getUniversalLabelPoint(component: ComponentInstance): LocalPoint {
  const nativeTextBounds = component.detail.render.shapes
    .filter(
      (shape) =>
        shape.type === "text"
        && !isUniversalLabelShape(shape)
        && evalConditions(shape.conditions, component)
    )
    .map((shape) => getTextLocalBounds(component, shape))
    .filter((bounds): bounds is LocalBounds => bounds !== null);
  const pad = Math.max(40, component.size / 2);

  if (component.orientation === "h") {
    const top = Math.min(-pad, ...nativeTextBounds.map((bounds) => bounds.top));
    return { x: component.size / 2, y: round(top - UNIVERSAL_LABEL_GAP) };
  }

  const right = Math.max(pad, ...nativeTextBounds.map((bounds) => bounds.right));
  return { x: round(right + UNIVERSAL_LABEL_GAP), y: component.size / 2 };
}

function estimateTextBounds(
  point: LocalPoint,
  value: string,
  fontSize: number,
  align: { anchor: "start" | "middle" | "end"; baseline: "hanging" | "middle" | "alphabetic" }
): LocalBounds {
  const lines = value.split("\n");
  const width = Math.max(1, ...lines.map((line) => Array.from(line).length)) * fontSize * 0.62;
  const height = Math.max(1, lines.length) * fontSize * 1.2;
  const left = align.anchor === "start" ? point.x : align.anchor === "end" ? point.x - width : point.x - width / 2;
  const top = align.baseline === "hanging" ? point.y : align.baseline === "middle" ? point.y - height / 2 : point.y - height;
  return { left, top, right: left + width, bottom: top + height };
}

function rotateBoundsClockwise(bounds: LocalBounds): LocalBounds {
  const corners = [
    { x: bounds.left, y: bounds.top },
    { x: bounds.right, y: bounds.top },
    { x: bounds.left, y: bounds.bottom },
    { x: bounds.right, y: bounds.bottom },
  ].map((point) => ({ x: -point.y, y: point.x }));
  return {
    left: Math.min(...corners.map((point) => point.x)),
    top: Math.min(...corners.map((point) => point.y)),
    right: Math.max(...corners.map((point) => point.x)),
    bottom: Math.max(...corners.map((point) => point.y)),
  };
}

function isUniversalLabelShape(shape: ComponentRenderShape): boolean {
  return shape.attrs["data-role"] === UNIVERSAL_LABEL_ROLE;
}

function renderOrientedShape(component: ComponentInstance, shape: ComponentRenderShape, key: string) {
  const autoRotate = shapeUsesAutoRotate(component, shape);
  const rendered = renderShape(component, shape, key, autoRotate);
  if (!rendered) return null;

  if (component.orientation === "v" && autoRotate) {
    return (
      <g key={`${key}-rotate`} transform="rotate(90)">
        {rendered}
      </g>
    );
  }

  return rendered;
}

function renderShape(component: ComponentInstance, shape: ComponentRenderShape, key: string, autoRotate: boolean) {
  const attrs = shape.attrs;
  const stroke = attrs.fill === "true" ? "none" : "currentColor";
  const fill = attrs.fill === "true" ? "currentColor" : "none";
  const strokeWidth = numberAttr(attrs.thickness, 1);

  if (shape.type === "line") {
    const start = resolveLocation(attrs.start ?? "_Start", component, autoRotate);
    const end = resolveLocation(attrs.end ?? "_End", component, autoRotate);
    return (
      <line
        key={key}
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    );
  }

  if (shape.type === "rect") {
    const point = attrs.location
      ? resolveLocation(attrs.location, component, autoRotate)
      : {
          x: resolveScalar(attrs.x ?? "0", "x", component, autoRotate),
          y: resolveScalar(attrs.y ?? "0", "y", component, autoRotate),
        };
    return (
      <rect
        key={key}
        x={point.x}
        y={point.y}
        width={numberAttr(attrs.width, 0)}
        height={numberAttr(attrs.height, 0)}
        stroke={stroke}
        fill={fill}
        strokeWidth={strokeWidth}
        vectorEffect="non-scaling-stroke"
      />
    );
  }

  if (shape.type === "ellipse") {
    const centre = attrs.centre
      ? resolveLocation(attrs.centre, component, autoRotate)
      : {
          x: resolveScalar(attrs.x ?? "0", "x", component, autoRotate),
          y: resolveScalar(attrs.y ?? "0", "y", component, autoRotate),
        };
    return (
      <ellipse
        key={key}
        cx={centre.x}
        cy={centre.y}
        rx={numberAttr(attrs.rx, 1)}
        ry={numberAttr(attrs.ry, 1)}
        stroke={stroke}
        fill={fill}
        strokeWidth={strokeWidth}
        vectorEffect="non-scaling-stroke"
      />
    );
  }

  if (shape.type === "path") {
    const start = resolveLocation(attrs.start ?? "_Start", component, autoRotate);
    return (
      <path
        key={key}
        d={`M ${start.x} ${start.y} ${attrs.data ?? ""}`}
        stroke={stroke}
        fill={fill}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    );
  }

  if (shape.type === "text") {
    const rawValue = attrs.value ?? "";
    const value = resolveText(rawValue, component);
    if (!value) return null;
    const point = isUniversalLabelShape(shape)
      ? getUniversalLabelPoint(component)
      : adjustTextPoint(
          component,
          rawValue,
          {
            x: resolveScalar(attrs.x ?? "_Middle", "x", component, autoRotate),
            y: resolveScalar(attrs.y ?? "_Middle", "y", component, autoRotate),
          },
          autoRotate
        );
    const align = getTextAlign(component, rawValue, attrs.align ?? "CentreCentre", autoRotate);
    return (
      <text
        key={key}
        x={point.x}
        y={point.y}
        textAnchor={align.anchor}
        dominantBaseline={align.baseline}
        fontSize={attrs.size === "large" ? LARGE_TEXT_SIZE : DEFAULT_TEXT_SIZE}
        className="componentText"
      >
        {value}
      </text>
    );
  }

  return null;
}

function adjustTextPoint(component: ComponentInstance, rawValue: string, point: LocalPoint, autoRotate: boolean): LocalPoint {
  if (!isVerticalResistorTwinText(component, rawValue, autoRotate)) {
    return point;
  }

  const center = component.size / 2;
  // For auto-rotated vertical resistors, local y becomes visual x after rotate(90).
  // Keep the value close to the symbol and the label in the outer lane.
  if (rawValue === "$Resistance") {
    return { x: center, y: -14 };
  }
  if (rawValue === "$Text") {
    return { x: center, y: -30 };
  }
  return point;
}

function getTextAlign(
  component: ComponentInstance,
  rawValue: string,
  rawAlign: string,
  autoRotate: boolean
): { anchor: "start" | "middle" | "end"; baseline: "hanging" | "middle" | "alphabetic" } {
  if (isVerticalResistorTwinText(component, rawValue, autoRotate)) {
    return { anchor: "middle", baseline: "middle" };
  }
  return parseAlign(resolveText(rawAlign, component));
}

function isVerticalResistorTwinText(component: ComponentInstance, rawValue: string, autoRotate: boolean): boolean {
  return (
    component.name === "Resistor" &&
    component.orientation === "v" &&
    autoRotate &&
    component.properties.ShowResistance?.toLowerCase() === "true" &&
    Boolean(component.properties.Text) &&
    (rawValue === "$Resistance" || rawValue === "$Text")
  );
}

function shapeUsesAutoRotate(component: ComponentInstance, shape: ComponentRenderShape) {
  if (component.orientation === "h") return false;
  if (!componentSupportsOrientation(component.detail, "v")) return false;
  const localAutorotate = shape.autorotate.toLowerCase();
  if (localAutorotate.includes("off")) return false;
  const renderAutorotate = component.detail.render.autorotate.toLowerCase();
  if (localAutorotate.includes("horizontaltovertical") || renderAutorotate.includes("horizontaltovertical")) {
    return true;
  }

  // Assets without HorizontalOnly are rotatable by default. Most either opt
  // into automatic rotation or define explicit horizontal/vertical geometry.
  // For the few assets that do neither, rotate the complete shape so paths,
  // leads and logical connection points share one transform.
  if (/\bhorizontal\b/i.test(shape.conditions)) return false;
  const hasOrientationSpecificGeometry = component.detail.render.shapes.some(
    (candidate) => candidate.type !== "text" && /\bhorizontal\b/i.test(candidate.conditions)
  );
  return !hasOrientationSpecificGeometry;
}

function getConnectionLocalPoint(connection: ComponentConnection, start: LocalPoint, end: LocalPoint): LocalPoint {
  const edge = connection.edge.toLowerCase();
  if (edge === "start") return start;
  if (edge === "end") return end;
  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  };
}

function toCanvasPoint(component: ComponentInstance, local: LocalPoint): Point {
  if (component.orientation === "h") {
    return [round(component.origin[0] + local.x), round(component.origin[1] + local.y)];
  }
  return [round(component.origin[0] - local.y), round(component.origin[1] + local.x)];
}

function canvasToTranslatedLocal(component: ComponentInstance, point: Point): LocalPoint {
  return { x: point[0] - component.origin[0], y: point[1] - component.origin[1] };
}

function resolveLocation(rawExpr: string, component: ComponentInstance, autoRotate = true): LocalPoint {
  const expr = substituteVariables(rawExpr || "0", component);
  const anchor = anchorFor(expr, component.size, component.orientation === "v" && !autoRotate ? "v" : "h");
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

function resolveScalar(rawExpr: string, axis: "x" | "y", component: ComponentInstance, autoRotate = true): number {
  const expr = substituteVariables(rawExpr || "0", component);
  const anchor = anchorFor(expr, component.size, component.orientation === "v" && !autoRotate ? "v" : "h");
  let value = anchor ? anchor.point[axis] : 0;
  let remainder = anchor ? expr.slice(anchor.token.length) : expr;

  if (!anchor && /^-?\d+(\.\d+)?$/.test(expr.trim())) {
    return Number.parseFloat(expr);
  }

  for (const match of remainder.matchAll(/([+-])([^+-]+)/g)) {
    const sign = match[1] === "-" ? -1 : 1;
    const token = match[2].trim().replace(/,$/, "");
    const explicitAxis = token.endsWith("y") || token.endsWith("Y") ? "y" : token.endsWith("x") || token.endsWith("X") ? "x" : axis;
    const parsed = Number.parseFloat(token.replace(/[xyXY]$/, ""));
    if (explicitAxis === axis && Number.isFinite(parsed)) {
      value += sign * parsed;
    }
  }
  return value;
}

function anchorFor(expr: string, size: number, orientation: "h" | "v" = "h"): { token: string; point: LocalPoint } | null {
  const lower = expr.trim().toLowerCase();
  if (lower.startsWith("_start")) return { token: expr.trim().slice(0, 6), point: { x: 0, y: 0 } };
  if (lower.startsWith("_middle")) {
    return { token: expr.trim().slice(0, 7), point: orientation === "v" ? { x: 0, y: size / 2 } : { x: size / 2, y: 0 } };
  }
  if (lower.startsWith("_end")) return { token: expr.trim().slice(0, 4), point: orientation === "v" ? { x: 0, y: size } : { x: size, y: 0 } };
  return null;
}

function substituteVariables(expr: string, component: ComponentInstance): string {
  return expr.replace(/\$(\w+)/g, (_match, name) => resolveVariable(name, component));
}

function resolveText(expr: string, component: ComponentInstance): string {
  return expr.replace(/\$(\w+)/g, (match, name) => {
    const resolved = resolveTextVariable(name, component);
    return resolved === match ? component.properties[name] ?? match : resolved;
  });
}

function resolveTextVariable(name: string, component: ComponentInstance): string {
  if (component.properties[name] !== undefined) {
    const property = component.detail.properties.find((item) => item.name === name);
    const rawValue = component.properties[name];
    const format = property?.formatting?.find((rule) => evalConditions(rule.conditions, component));
    return decodeTextEscapes(format ? applyFormatTemplate(format.value, component) : rawValue);
  }
  return decodeTextEscapes(resolveVariable(name, component));
}

function applyFormatTemplate(template: string, component: ComponentInstance): string {
  return template.replace(/\$(\w+)((?:\([^)]+\))*)/g, (_match, name: string, operations: string) => {
    let value = component.properties[name] ?? "";
    const numeric = Number.parseFloat(value);
    if (operations && Number.isFinite(numeric)) {
      let transformed = numeric;
      for (const operation of operations.matchAll(/\(([^)]+)\)/g)) {
        const op = operation[1];
        if (op.startsWith("div_")) {
          const divisor = Number.parseFloat(op.slice(4));
          if (Number.isFinite(divisor) && divisor !== 0) transformed /= divisor;
        } else if (op.startsWith("round_")) {
          const places = Number.parseInt(op.slice(6), 10);
          if (Number.isFinite(places)) {
            transformed = Number(transformed.toFixed(places));
          }
        }
      }
      value = String(transformed);
    }
    return value;
  });
}

function decodeTextEscapes(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\n/g, "\n");
}

function resolveVariable(name: string, component: ComponentInstance): string {
  if (component.properties[name] !== undefined) return component.properties[name];
  if (component.detail.definitions.consts[name] !== undefined) return component.detail.definitions.consts[name];
  const rules = component.detail.definitions.defs[name];
  if (rules) {
    const matched = rules.find((rule) => evalConditions(rule.conditions, component));
    if (matched) return matched.value;
  }
  return `$${name}`;
}

function evalConditions(conditions: string | null | undefined, component: ComponentInstance): boolean {
  if (!conditions) return true;
  return evalExpression(conditions, component);
}

function evalExpression(value: string, component: ComponentInstance): boolean {
  const stripped = stripParens(value.trim());
  if (!stripped) return true;

  const andParts = splitTopLevel(stripped, ",");
  if (andParts.length > 1) {
    return andParts.every((part) => evalExpression(part, component));
  }

  const orParts = splitTopLevel(stripped, "|");
  if (orParts.length > 1) {
    return orParts.some((part) => evalExpression(part, component));
  }

  return evalAtom(stripped, component);
}

function evalAtom(value: string, component: ComponentInstance): boolean {
  if (!value) return true;
  if (value.startsWith("!")) return !evalAtom(value.slice(1), component);
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

function parseAlign(value: string): { anchor: "start" | "middle" | "end"; baseline: "hanging" | "middle" | "alphabetic" } {
  const lower = value.toLowerCase();
  const anchor = lower.includes("left") ? "start" : lower.includes("right") ? "end" : "middle";
  const baseline = lower.includes("top") ? "hanging" : lower.includes("bottom") ? "alphabetic" : "middle";
  return { anchor, baseline };
}

function numberAttr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
