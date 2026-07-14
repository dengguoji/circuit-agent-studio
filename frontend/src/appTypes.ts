import type {
  CircuitCanvasState,
  CircuitToolCall,
  ToolExecutionResult,
  WireSegment,
} from "./circuitTools";

export type AgentLoopStatus = "idle" | "running" | "complete" | "stopped" | "error";
export type AgentPanelTab = "chat" | "trace";
export type AgentStopReason =
  | "user"
  | "no_progress"
  | "repair_budget"
  | "round_limit"
  | "tool_limit"
  | "model_error";
export type ReasoningMode = "fast" | "auto" | "deep";
export type EditorMode = "select" | "wire";
export type EditorSelection = { kind: "component" | "wire" | "junction"; id: string };
export type WireEndpoint = "start" | "end";

export type SnapTarget = {
  kind: "component-port" | "junction" | "wire-endpoint" | "wire-segment";
  point: [number, number];
  sourceId: string;
  label: string;
};

export type WireDraft = {
  start: [number, number];
  end: [number, number];
  startSnap: SnapTarget | null;
  endSnap: SnapTarget | null;
};

export type ComponentDragState = {
  id: string;
  baseState: CircuitCanvasState;
  startPoint: [number, number];
  startOrigin: [number, number];
  latestOrigin: [number, number];
  moved: boolean;
};

export type WireEndpointDragState = {
  id: string;
  endpoint: WireEndpoint;
  baseState: CircuitCanvasState;
  fixedPoint: [number, number];
  latestPoint: [number, number];
  moved: boolean;
};

export type WireSegmentDragState = {
  id: string;
  baseState: CircuitCanvasState;
  startPoint: [number, number];
  startWire: WireSegment;
  latestStart: [number, number];
  latestEnd: [number, number];
  moved: boolean;
};

export type MessageContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type AgentMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | MessageContentPart[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
};

export type AgentResponse = {
  error?: string;
  turn_id?: string;
  conversation_id?: string;
  canvas_revision?: number;
  status?: "running" | "requires_action" | "completed" | "stopped" | "error";
  model?: string;
  enable_thinking?: boolean;
  protocol?: "responses" | "chat_completions";
  reasoning_summary?: string;
  reasoning_degraded?: boolean;
  usage?: AgentUsage;
  clear_allowed?: boolean;
  response_id?: string;
  assistant_message?: AgentMessage | null;
  stop_reason?: string | null;
  events?: ConversationEvent[];
  raw_response?: unknown;
  tool_calls?: OpenAiToolCall[];
  messages?: AgentMessage[];
};

export type AgentUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  image_tokens?: number;
  context_window?: number;
  session_total_tokens?: number;
};

export type ConversationSummary = {
  id: string;
  title: string;
  provider: string;
  model: string;
  reasoning_mode: ReasoningMode;
  canvas_revision: number;
  created_at: string;
  updated_at: string;
};

export type ConversationRecord = ConversationSummary & {
  canvas_state?: CircuitCanvasState;
  events?: ConversationEvent[];
};

export type ConversationEventType =
  | "user.message"
  | "assistant.message"
  | "reasoning.summary"
  | "tool.call"
  | "tool.result"
  | "visual.review"
  | "turn.started"
  | "reasoning.summary.delta"
  | "assistant.text.delta"
  | "usage.updated"
  | "step.completed"
  | "turn.completed"
  | "turn.stopped"
  | "turn.error";

export type ConversationEvent = {
  id: string | number;
  conversation_id: string;
  turn_id?: string | null;
  sequence?: number;
  type: ConversationEventType;
  payload?: Record<string, unknown>;
  data?: Record<string, unknown>;
  role?: string | null;
  created_at: string;
};

export type AgentTimelineItem = {
  id: string;
  kind: "user" | "assistant" | "reasoning" | "tool" | "status" | "error";
  text: string;
  createdAt: string;
  toolName?: string;
  toolStatus?: "running" | "ok" | "error";
  targetId?: string;
};

export type ToolExecutionRecord = {
  call: CircuitToolCall;
  result: ToolExecutionResult;
};

export type ToolExecutionBatch = {
  state: CircuitCanvasState;
  records: ToolExecutionRecord[];
};

export type AgentRoundSummary = {
  round: number;
  toolCalls: number;
  status: "tool_calls" | "final";
  model?: string;
  enableThinking?: boolean;
  usage?: AgentUsage;
};

export type OpenAiToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type UploadedImage = {
  name: string;
  mime_type: string;
  data_url: string;
  width: number;
  height: number;
  asset_id?: string;
  provider_ref?: string;
  expires_at?: string;
};

export type AgentRunControl = {
  id: number;
  abortController: AbortController;
  stopped: boolean;
  stopReason: AgentStopReason | null;
  startState: CircuitCanvasState;
  toolCalls: number;
  repairCycles: number;
  visualReviews: number;
  stalledRounds: number;
  previousCanvasFingerprint: string;
  previousIssueFingerprint: string;
  repeatedIssueRounds: number;
  clearAllowed: boolean;
  turnId?: string;
};
