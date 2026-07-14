import type { ComponentDetail } from "./circuitTools";
import type {
  AgentResponse,
  AgentUsage,
  ConversationEvent,
  ConversationRecord,
  ConversationSummary,
  ReasoningMode,
} from "./appTypes";

export type ComponentCatalogResponse = {
  count?: number;
  items?: unknown[];
  error?: string;
  [key: string]: unknown;
};

export type ComponentCatalogItem = {
  name: string;
  minsize: string;
};

export type ComponentDetailResponse = {
  components: ComponentDetail[];
  errors: string[];
};

export type ModelProviderId = "bailian" | "doubao";

export type ModelOption = {
  provider: ModelProviderId;
  provider_name: string;
  model: string;
  label: string;
  available: boolean;
  missing_env: string[];
  protocol?: "responses" | "chat_completions";
  context_window?: number;
  reasoning_modes?: ReasoningMode[];
  supports_files?: boolean;
  capabilities?: {
    responses?: boolean;
    previous_response_id?: boolean;
    files?: boolean;
    context_window?: number | null;
    reasoning_modes?: ReasoningMode[];
  };
};

export type ModelsResponse = {
  default_provider: ModelProviderId;
  default_model: string;
  options: ModelOption[];
};

export async function readJsonResponse<T extends { error?: string }>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    if (!response.ok) {
      throw new Error(`${label} failed with ${response.status} and returned an empty response`);
    }
    throw new Error(`${label} returned an empty response`);
  }

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    const preview = text.replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`${label} returned invalid JSON${preview ? `: ${preview}` : ""}`);
  }

  if (!response.ok || data.error) {
    throw new Error(data.error ?? `${label} failed with ${response.status}`);
  }

  return data;
}

export async function fetchComponentCatalog(): Promise<ComponentCatalogResponse> {
  const response = await fetch("/api/components/catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return readJsonResponse<ComponentCatalogResponse>(response, "Component catalog request");
}

export async function fetchComponentDetails(names: string[]): Promise<ComponentDetailResponse> {
  const response = await fetch("/api/components/detail", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ names }),
  });
  const data = await readJsonResponse<Partial<ComponentDetailResponse> & { error?: string }>(
    response,
    "Component detail request",
  );
  return {
    components: Array.isArray(data.components) ? data.components : [],
    errors: Array.isArray(data.errors) ? data.errors : [],
  };
}

export async function fetchModelOptions(): Promise<ModelsResponse> {
  const response = await fetch("/api/models");
  const data = await readJsonResponse<ModelsResponse & { error?: string }>(response, "Model options request");
  return {
    ...data,
    options: data.options.map((option) => ({
      ...option,
      protocol: option.protocol ?? (option.capabilities?.responses ? "responses" : "chat_completions"),
      context_window: option.context_window ?? option.capabilities?.context_window ?? undefined,
      reasoning_modes: option.reasoning_modes ?? option.capabilities?.reasoning_modes,
      supports_files: option.supports_files ?? option.capabilities?.files,
    })),
  };
}

export async function syncDebugMessages(payload: { provider: string; model: string; messages: unknown[] }): Promise<void> {
  const response = await fetch("/api/debug/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, messages: stripDataUrls(payload.messages) }),
  });
  await readJsonResponse<{ status?: string; error?: string }>(response, "Debug messages sync");
}

export type ConversationListResponse = {
  conversations?: ConversationSummary[];
  items?: ConversationSummary[];
  error?: string;
};

export async function fetchConversations(signal?: AbortSignal): Promise<ConversationSummary[]> {
  const response = await fetch("/api/conversations", { signal });
  const data = await readJsonResponse<ConversationListResponse>(response, "Conversation list request");
  return Array.isArray(data.conversations) ? data.conversations : Array.isArray(data.items) ? data.items : [];
}

export async function createConversation(payload: {
  title?: string;
  provider: string;
  model: string;
  reasoning_mode: ReasoningMode;
  canvas_state?: unknown;
}): Promise<ConversationRecord> {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await readJsonResponse<{ conversation?: ConversationRecord; error?: string } & Partial<ConversationRecord>>(
    response,
    "Create conversation request"
  );
  return data.conversation ?? (data as ConversationRecord);
}

export async function fetchConversation(id: string, signal?: AbortSignal): Promise<ConversationRecord> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { signal });
  const data = await readJsonResponse<{ conversation?: ConversationRecord; events?: ConversationEvent[]; error?: string } & Partial<ConversationRecord>>(
    response,
    "Conversation request"
  );
  const conversation = data.conversation ?? (data as ConversationRecord);
  if (!conversation.events && Array.isArray(data.events)) conversation.events = data.events;
  if (!conversation.events) {
    try {
      conversation.events = await fetchConversationEvents(id, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      conversation.events = [];
    }
  }
  return conversation;
}

export async function fetchConversationEvents(id: string, signal?: AbortSignal): Promise<ConversationEvent[]> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/events`, { signal });
  const data = await readJsonResponse<{ items?: ConversationEvent[]; events?: ConversationEvent[]; error?: string }>(
    response,
    "Conversation events request"
  );
  return Array.isArray(data.events) ? data.events : Array.isArray(data.items) ? data.items : [];
}

export async function updateConversation(
  id: string,
  payload: Partial<Pick<ConversationSummary, "title" | "provider" | "model" | "reasoning_mode">>
): Promise<ConversationRecord> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await readJsonResponse<{ conversation?: ConversationRecord; error?: string } & Partial<ConversationRecord>>(
    response,
    "Update conversation request"
  );
  return data.conversation ?? (data as ConversationRecord);
}

export async function deleteConversation(id: string): Promise<void> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  await readJsonResponse<{ status?: string; error?: string }>(response, "Delete conversation request");
}

export async function saveConversationCanvas(
  id: string,
  payload: { canvas_state: unknown; canvas_bounds: unknown; revision?: number }
): Promise<number> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      canvas_state: payload.canvas_state,
      canvas_bounds: payload.canvas_bounds,
      ...(payload.revision === undefined ? {} : { canvas_revision: payload.revision }),
    }),
  });
  const data = await readJsonResponse<{ revision?: number; canvas_revision?: number; error?: string }>(
    response,
    "Save conversation canvas request"
  );
  return data.canvas_revision ?? data.revision ?? (payload.revision ?? 0) + 1;
}

export async function cancelConversationTurn(turnId: string): Promise<void> {
  const response = await fetch(`/api/turns/${encodeURIComponent(turnId)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  await readJsonResponse<{ status?: string; error?: string }>(response, "Cancel turn request");
}

export type AssetUploadResponse = {
  asset_id: string;
  status: string;
  provider_ref?: string;
  expires_at?: string;
  error?: string;
};

export type TurnStreamEvent = {
  event: string;
  data: Record<string, unknown>;
};

export async function uploadAsset(
  file: File,
  options: { provider: string; model: string; purpose?: string; conversationId?: string | null },
  signal?: AbortSignal
): Promise<AssetUploadResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("provider", options.provider);
  form.append("model", options.model);
  form.append("purpose", options.purpose ?? "user_image");
  if (options.conversationId) form.append("conversation_id", options.conversationId);
  form.append("upload_to_provider", "true");
  const response = await fetch("/api/assets", { method: "POST", body: form, signal });
  const data = await readJsonResponse<AssetUploadResponse & {
    id?: string;
    provider_file_id?: string;
    url?: string;
  }>(response, "Asset upload request");
  return {
    ...data,
    asset_id: data.asset_id ?? data.id ?? "",
    provider_ref: data.provider_ref ?? data.provider_file_id ?? data.url,
  };
}

export async function startConversationTurn(
  conversationId: string,
  payload: {
    turn_id?: string;
    message: string;
    model_provider: string;
    model: string;
    reasoning_mode: ReasoningMode;
    model_canvas_state: unknown;
    canvas_state: unknown;
    canvas_bounds: unknown;
    asset_id?: string;
    image?: unknown;
    require_tool?: boolean;
    prefer_responses?: boolean;
  },
  signal?: AbortSignal,
  onEvent?: (event: TurnStreamEvent) => void
): Promise<AgentResponse> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  return readTurnResponse(response, "Start conversation turn", onEvent);
}

export async function continueConversationTurn(
  turnId: string,
  payload: {
    tool_outputs: Array<{ tool_call_id: string; content: string }>;
    visual_asset_ids?: string[];
    canvas_state: unknown;
    canvas_revision?: number;
    require_tool?: boolean;
  },
  signal?: AbortSignal,
  onEvent?: (event: TurnStreamEvent) => void
): Promise<AgentResponse> {
  const response = await fetch(`/api/turns/${encodeURIComponent(turnId)}/continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  return readTurnResponse(response, "Continue conversation turn", onEvent);
}

async function readTurnResponse(
  response: Response,
  label: string,
  onEvent?: (event: TurnStreamEvent) => void
): Promise<AgentResponse> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return readJsonResponse<AgentResponse>(response, label);
  }
  if (!response.ok || !response.body) {
    throw new Error(`${label} failed with ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: AgentResponse | null = null;
  let streamError = "";

  function consumeBlock(block: string) {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const rawLine of block.split(/\r?\n/)) {
      if (rawLine.startsWith("event:")) eventName = rawLine.slice(6).trim();
      if (rawLine.startsWith("data:")) dataLines.push(rawLine.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const data = value as Record<string, unknown>;
    onEvent?.({ event: eventName, data });
    if (typeof data.status === "string" && typeof data.turn_id === "string" && Array.isArray(data.tool_calls)) {
      finalResponse = data as AgentResponse;
    } else if (eventName === "turn.error" && typeof data.error === "string") {
      streamError = data.error;
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    blocks.forEach(consumeBlock);
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);
  if (finalResponse) return finalResponse;
  throw new Error(streamError || `${label} stream ended without a final response`);
}

export function normalizeUsage(value: unknown): AgentUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const number = (key: string) => (typeof source[key] === "number" ? source[key] as number : undefined);
  const input = number("input_tokens") ?? number("prompt_tokens") ?? 0;
  const output = number("output_tokens") ?? number("completion_tokens") ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: number("total_tokens") ?? input + output,
    cached_tokens: number("cached_tokens"),
    reasoning_tokens: number("reasoning_tokens"),
    image_tokens: number("image_tokens"),
    context_window: number("context_window"),
    session_total_tokens: number("session_total_tokens"),
  };
}

function stripDataUrls(value: unknown): unknown {
  if (typeof value === "string") {
    return value.startsWith("data:image/") ? "[local image omitted]" : value;
  }
  if (Array.isArray(value)) return value.map(stripDataUrls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, stripDataUrls(item)]));
}

export function getCatalogItems(catalog: ComponentCatalogResponse): ComponentCatalogItem[] {
  if (!Array.isArray(catalog.items)) return [];
  return catalog.items
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      minsize: typeof item.minsize === "string" ? item.minsize : "",
    }))
    .filter((item) => item.name);
}
