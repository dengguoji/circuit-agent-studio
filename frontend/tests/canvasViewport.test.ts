import { describe, expect, it } from "vitest";

import { computeCanvasViewportBounds } from "../src/canvasViewport";

const canvasBounds = { width: 1280, height: 720 };

describe("responsive canvas viewport", () => {
  it("keeps the logical canvas size at the matching aspect ratio", () => {
    expect(computeCanvasViewportBounds(canvasBounds, 1600, 900)).toEqual(canvasBounds);
  });

  it("extends the visible grid vertically instead of leaving a blank footer", () => {
    expect(computeCanvasViewportBounds(canvasBounds, 1000, 1000)).toEqual({
      width: 1280,
      height: 1280,
    });
  });

  it("extends the visible grid horizontally on wide viewports", () => {
    expect(computeCanvasViewportBounds(canvasBounds, 2000, 900)).toEqual({
      width: 1600,
      height: 720,
    });
  });

  it("falls back safely before the viewport has a measurable size", () => {
    expect(computeCanvasViewportBounds(canvasBounds, 0, 0)).toEqual(canvasBounds);
  });
});
