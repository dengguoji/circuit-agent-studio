type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonViewerProps = {
  value: unknown;
};

export function JsonViewer({ value }: JsonViewerProps) {
  return (
    <div className="jsonViewer">
      <JsonNode value={toJsonValue(value)} depth={0} />
    </div>
  );
}

function JsonNode({ value, depth }: { value: JsonValue; depth: number }) {
  if (Array.isArray(value)) {
    return <JsonArray value={value} depth={depth} />;
  }

  if (value !== null && typeof value === "object") {
    return <JsonObject value={value} depth={depth} />;
  }

  return <JsonPrimitive value={value} />;
}

function JsonArray({ value, depth }: { value: JsonValue[]; depth: number }) {
  if (value.length === 0) {
    return <span className="jsonPunctuation">[]</span>;
  }

  return (
    <details className="jsonBranch" open={depth < 2}>
      <summary>
        <span className="jsonPunctuation">[</span>
        <span className="jsonMuted">{value.length} items</span>
        <span className="jsonPunctuation">]</span>
      </summary>
      <div className="jsonChildren">
        {value.map((item, index) => (
          <div className="jsonRow" key={index}>
            <JsonNode value={item} depth={depth + 1} />
            {index < value.length - 1 && <span className="jsonPunctuation">,</span>}
          </div>
        ))}
      </div>
    </details>
  );
}

function JsonObject({ value, depth }: { value: { [key: string]: JsonValue }; depth: number }) {
  const entries = Object.entries(value);

  if (entries.length === 0) {
    return <span className="jsonPunctuation">{"{}"}</span>;
  }

  return (
    <details className="jsonBranch" open={depth < 2}>
      <summary>
        <span className="jsonPunctuation">{"{"}</span>
        <span className="jsonMuted">{entries.length} keys</span>
        <span className="jsonPunctuation">{"}"}</span>
      </summary>
      <div className="jsonChildren">
        {entries.map(([key, item], index) => (
          <div className="jsonRow" key={key}>
            <span className="jsonKey">"{key}"</span>
            <span className="jsonPunctuation">: </span>
            <JsonNode value={item} depth={depth + 1} />
            {index < entries.length - 1 && <span className="jsonPunctuation">,</span>}
          </div>
        ))}
      </div>
    </details>
  );
}

function JsonPrimitive({ value }: { value: null | boolean | number | string }) {
  if (value === null) {
    return <span className="jsonNull">null</span>;
  }

  if (typeof value === "string") {
    return <span className="jsonString">"{escapeJsonString(value)}"</span>;
  }

  if (typeof value === "number") {
    return <span className="jsonNumber">{value}</span>;
  }

  return <span className="jsonBoolean">{String(value)}</span>;
}

function escapeJsonString(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonValue(item)])
    );
  }
  return String(value);
}
