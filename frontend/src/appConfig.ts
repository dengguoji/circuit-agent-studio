export const AGENT_MAX_MODEL_ROUNDS = 32;
export const AGENT_MAX_TOOL_CALLS = 160;
export const AGENT_MAX_REPAIR_CYCLES = 3;
export const AGENT_MAX_STALLED_ROUNDS = 2;
// Backwards-compatible alias for callers that still use the old round name.
export const AGENT_MAX_TOOL_ROUNDS = AGENT_MAX_MODEL_ROUNDS;
export const SIDEBAR_MIN_WIDTH = 300;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_DEFAULT_WIDTH = 360;
export const SIDEBAR_COLLAPSED_WIDTH = 72;
export const SNAP_DISTANCE = 12;
export const WIRE_ENDPOINT_HIT_DISTANCE = 10;
export const HISTORY_LIMIT = 100;
export const CANVAS_STORAGE_KEY = "circuit-ai-workbench:canvas-state:v1";
export const PROJECT_FILE_VERSION = 1;

export const SVG_EXPORT_STYLE = `
.outsideCanvas{display:none}
.paper{fill:#fff}
.minorGridLine{fill:none;stroke:#e8eaee;stroke-width:1}
.majorGridLine{fill:none;stroke:#cfd5dd;stroke-width:1}
.canvasBounds{fill:none;stroke:transparent;stroke-width:0}
.component,.wireComponent{color:#111}
.componentText{fill:currentColor;stroke:none;font-family:Inter,Arial,sans-serif;font-weight:600;paint-order:stroke}
.junction{fill:#111;stroke:none}
line,path,rect,ellipse{vector-effect:non-scaling-stroke}
`;
