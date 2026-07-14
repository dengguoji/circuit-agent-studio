import type { CanvasBounds } from "./circuitTools";

export function computeCanvasViewportBounds(
  canvasBounds: CanvasBounds,
  viewportWidth: number,
  viewportHeight: number
): CanvasBounds {
  if (viewportWidth <= 0 || viewportHeight <= 0) return canvasBounds;

  const canvasAspect = canvasBounds.width / canvasBounds.height;
  const viewportAspect = viewportWidth / viewportHeight;

  if (viewportAspect > canvasAspect) {
    return {
      width: canvasBounds.height * viewportAspect,
      height: canvasBounds.height,
    };
  }

  return {
    width: canvasBounds.width,
    height: canvasBounds.width / viewportAspect,
  };
}
