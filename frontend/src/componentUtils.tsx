import type React from "react";
import { ComponentRenderer, getComponentBounds } from "./ComponentRenderer";
import { mergeComponentProperties } from "./circuitTools";
import type { ComponentDetail, ComponentInstance, WireSegment } from "./circuitTools";

export function normalizeCacheKey(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeSearchValue(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function componentDisplayName(component: ComponentInstance): string {
  return component.requestedName && component.requestedName !== component.name ? component.requestedName : component.name;
}

export function createPreviewComponent(detail: ComponentDetail): ComponentInstance {
  const merged = mergeComponentProperties(detail, {});
  return {
    id: `preview-${detail.name}`,
    name: detail.name,
    requestedName: detail.requested_name,
    origin: [0, 0],
    orientation: "h",
    size: Number.parseFloat(detail.minsize) || 40,
    properties: merged.properties,
    detail,
  };
}

export function ComponentLibraryTile({
  detail,
  active,
  onPick,
  onPointerDown,
  onDragStart,
}: {
  detail: ComponentDetail;
  active: boolean;
  onPick: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void;
}) {
  const preview = createPreviewComponent(detail);
  const bounds = getComponentBounds(preview);
  const pad = 16;
  const viewBox = `${bounds.x - pad} ${bounds.y - pad} ${Math.max(70, bounds.width + pad * 2)} ${Math.max(46, bounds.height + pad * 2)}`;

  return (
    <button
      type="button"
      className={active ? "componentTile active" : "componentTile"}
      draggable
      onPointerDown={onPointerDown}
      onDragStart={onDragStart}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPick();
        }
      }}
    >
      <svg viewBox={viewBox} aria-hidden="true">
        <ComponentRenderer component={preview} active={false} className="componentThumbnail" />
      </svg>
      <span>{detail.name}</span>
    </button>
  );
}

export function WireSegmentRenderer({
  wire,
  wireDetail,
  active,
  draft = false,
}: {
  wire: WireSegment;
  wireDetail: ComponentDetail | null;
  active: boolean;
  draft?: boolean;
}) {
  if (!wireDetail) {
    return (
      <line
        x1={wire.start[0]}
        y1={wire.start[1]}
        x2={wire.end[0]}
        y2={wire.end[1]}
        className={["wire", active ? "activeWire" : "", draft ? "draftWire" : ""].filter(Boolean).join(" ")}
      />
    );
  }

  const component = createWireComponentInstance(wire, wireDetail);
  if (!component) return null;

  return (
    <ComponentRenderer
      component={component}
      active={false}
      className={["wireComponent", active ? "activeWireComponent" : "", draft ? "draftWireComponent" : ""].filter(Boolean).join(" ")}
    />
  );
}

export function createWireComponentInstance(wire: WireSegment, detail: ComponentDetail): ComponentInstance | null {
  if (wire.start[0] === wire.end[0] && wire.start[1] === wire.end[1]) return null;

  const horizontal = wire.start[1] === wire.end[1];
  const vertical = wire.start[0] === wire.end[0];
  if (!horizontal && !vertical) return null;

  const size = horizontal ? Math.abs(wire.end[0] - wire.start[0]) : Math.abs(wire.end[1] - wire.start[1]);
  const origin: [number, number] = horizontal
    ? [Math.min(wire.start[0], wire.end[0]), wire.start[1]]
    : [wire.start[0], Math.min(wire.start[1], wire.end[1])];

  return {
    id: wire.id,
    name: detail.name,
    requestedName: detail.requested_name,
    origin,
    orientation: horizontal ? "h" : "v",
    size,
    properties: {},
    detail,
  };
}
