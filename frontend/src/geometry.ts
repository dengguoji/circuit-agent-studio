import type { Point, WireSegment } from "./circuitTools";

export function distance(a: Point, b: Point) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function samePoint(a: Point, b: Point) {
  return a[0] === b[0] && a[1] === b[1];
}

export function isAxisAlignedPoints(a: Point, b: Point) {
  return a[0] === b[0] || a[1] === b[1];
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function pointIsOnWireSegment(point: Point, wire: WireSegment): boolean {
  const minX = Math.min(wire.start[0], wire.end[0]);
  const maxX = Math.max(wire.start[0], wire.end[0]);
  const minY = Math.min(wire.start[1], wire.end[1]);
  const maxY = Math.max(wire.start[1], wire.end[1]);

  if (wire.start[1] === wire.end[1]) {
    return point[1] === wire.start[1] && point[0] >= minX && point[0] <= maxX;
  }
  if (wire.start[0] === wire.end[0]) {
    return point[0] === wire.start[0] && point[1] >= minY && point[1] <= maxY;
  }
  return false;
}
