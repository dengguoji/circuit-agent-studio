import { SVG_EXPORT_STYLE } from "./appConfig";
import type { CanvasBounds } from "./circuitTools";

export function downloadTextFile(filename: string, text: string, mimeType: string) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function prepareSvgForExport(svg: SVGSVGElement, canvasBounds: CanvasBounds) {
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", String(Math.round(canvasBounds.width)));
  svg.setAttribute("height", String(Math.round(canvasBounds.height)));
  svg.setAttribute("viewBox", `0 0 ${canvasBounds.width} ${canvasBounds.height}`);
  svg.removeAttribute("class");
  svg.removeAttribute("role");
  svg.removeAttribute("aria-label");

  svg
    .querySelectorAll(".connectionHintLayer,.wireHandleLayer,.snapTargetLayer,.issueMarkerLayer,.canvasClearFlash")
    .forEach((node) => node.remove());
  svg.querySelectorAll("[filter]").forEach((node) => node.removeAttribute("filter"));
  svg.querySelectorAll("[class]").forEach((node) => {
    const className = node.getAttribute("class");
    if (!className) return;
    const nextClassName = className
      .split(/\s+/)
      .filter((name) => name && !name.startsWith("active") && !name.startsWith("draft") && name !== "connectionDebugLayer")
      .join(" ");
    if (nextClassName) {
      node.setAttribute("class", nextClassName);
    } else {
      node.removeAttribute("class");
    }
  });

  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = SVG_EXPORT_STYLE;
  const defs = svg.querySelector("defs");
  if (defs) {
    defs.insertBefore(style, defs.firstChild);
  } else {
    svg.insertBefore(style, svg.firstChild);
  }
}

export function formatExportTimestamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}
