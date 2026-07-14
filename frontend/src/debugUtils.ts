export function summarizeDebugValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) {
      const header = value.slice(0, Math.min(value.indexOf(",") + 1 || 40, 80));
      return `${header}<base64 ${value.length} chars>`;
    }
    if (value.length > 1800) {
      return `${value.slice(0, 900)}\n... <truncated ${value.length} chars> ...\n${value.slice(-300)}`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => summarizeDebugValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, summarizeDebugValue(child)]));
  }

  return value;
}
