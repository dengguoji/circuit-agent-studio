export type TimelineItemStatus = "pending" | "running" | "success" | "stopped" | "error";

export type TimelineTone = "neutral" | "info" | "success" | "warning" | "danger";

export type TimelineItemBase = {
  id: string;
  createdAt?: string;
};

export type ChatMessageTimelineItem = TimelineItemBase & {
  kind: "message";
  role: "user" | "assistant";
  content: string;
  status?: "streaming" | "complete" | "error";
};

export type ReasoningTimelineItem = TimelineItemBase & {
  kind: "reasoning";
  title?: string;
  summary: string;
  status?: TimelineItemStatus;
  defaultExpanded?: boolean;
};

export type ToolTimelineEvent = {
  id: string;
  name: string;
  summary?: string;
  detail?: string;
  status: TimelineItemStatus;
  targetId?: string;
};

export type ToolTimelineItem = TimelineItemBase & {
  kind: "tool";
  title?: string;
  events: ToolTimelineEvent[];
  defaultExpanded?: boolean;
};

export type StatusTimelineItem = TimelineItemBase & {
  kind: "status";
  label: string;
  detail?: string;
  tone?: TimelineTone;
  actionLabel?: string;
};

export type ConversationTimelineItem =
  | ChatMessageTimelineItem
  | ReasoningTimelineItem
  | ToolTimelineItem
  | StatusTimelineItem;

export type ConversationSummary = {
  id: string;
  title: string;
  subtitle?: string;
  unreadCount?: number;
};

export type ReasoningModeOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export type ContextUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  imageTokens?: number;
  sessionTotalTokens?: number;
  contextWindow?: number;
};

export type ComposerAttachment = {
  id: string;
  name: string;
  previewUrl?: string;
  metadata?: string;
};
