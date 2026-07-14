import {
  ChevronLeft,
  ImagePlus,
  MessageSquare,
  Plus,
  Send,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useRef, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ConversationTimeline, type ConversationTimelineProps } from "./ConversationTimeline";
import { UsagePill } from "./UsagePill";
import type {
  ComposerAttachment,
  ContextUsage,
  ConversationSummary,
  ConversationTimelineItem,
  ReasoningModeOption,
} from "./timelineTypes";

export type ConversationDockProps = {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  onConversationChange: (conversationId: string) => void;
  onCreateConversation: () => void;
  items: ConversationTimelineItem[];
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  running: boolean;
  reasoningMode: string;
  reasoningModes: ReasoningModeOption[];
  onReasoningModeChange: (value: string) => void;
  usage?: ContextUsage;
  attachment?: ComposerAttachment | null;
  onAttach?: () => void;
  onRemoveAttachment?: () => void;
  collapsed?: boolean;
  showCollapsedTrigger?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  title?: string;
  placeholder?: string;
  disabled?: boolean;
  headerSlot?: ReactNode;
  composerSlot?: ReactNode;
  emptyState?: ReactNode;
  followLatest?: boolean;
  onToolEventSelect?: ConversationTimelineProps["onToolEventSelect"];
  onStatusAction?: ConversationTimelineProps["onStatusAction"];
  className?: string;
  ariaLabel?: string;
};

export function ConversationDock({
  conversations,
  activeConversationId,
  onConversationChange,
  onCreateConversation,
  items,
  value,
  onValueChange,
  onSubmit,
  onStop,
  running,
  reasoningMode,
  reasoningModes,
  onReasoningModeChange,
  usage,
  attachment,
  onAttach,
  onRemoveAttachment,
  collapsed = false,
  showCollapsedTrigger = true,
  onCollapsedChange,
  title = "Circuit Agent Studio",
  placeholder = "Describe what to draw or change…",
  disabled = false,
  headerSlot,
  composerSlot,
  emptyState,
  followLatest = true,
  onToolEventSelect,
  onStatusAction,
  className = "",
  ariaLabel = "Agent conversation",
}: ConversationDockProps) {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const canSubmit = value.trim().length > 0 && !disabled && !running;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (canSubmit) onSubmit();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  if (collapsed) {
    if (!showCollapsedTrigger) return null;
    return (
      <section className={["cw-floating-dock", "cw-conversation-dock", "is-collapsed", className].filter(Boolean).join(" ")} aria-label={ariaLabel}>
        <button
          type="button"
          className="cw-collapsed-trigger"
          onClick={() => onCollapsedChange?.(false)}
          aria-label="Open agent conversation"
          aria-expanded="false"
        >
          <Sparkles aria-hidden="true" size={18} />
        </button>
      </section>
    );
  }

  return (
    <section className={["cw-floating-dock", "cw-conversation-dock", className].filter(Boolean).join(" ")} aria-label={ariaLabel}>
      <header className="cw-dock-header">
        <div className="cw-dock-title">
          <span className="cw-dock-mark"><Sparkles aria-hidden="true" size={16} /></span>
          <strong>{title}</strong>
        </div>
        <div className="cw-dock-header-actions">
          <button type="button" onClick={onCreateConversation} aria-label="New conversation" title="New conversation">
            <Plus aria-hidden="true" size={17} />
          </button>
          {onCollapsedChange && (
            <button type="button" onClick={() => onCollapsedChange(true)} aria-label="Collapse conversation" aria-expanded="true">
              <ChevronLeft aria-hidden="true" size={17} />
            </button>
          )}
        </div>
      </header>

      <div className="cw-conversation-controls">
        <label className="cw-conversation-select">
          <MessageSquare aria-hidden="true" size={15} />
          <span className="cw-sr-only">Conversation</span>
          <select
            value={activeConversationId ?? ""}
            onChange={(event) => onConversationChange(event.target.value)}
            disabled={conversations.length === 0}
            aria-label="Conversation"
          >
            {conversations.length === 0 && <option value="">No conversations</option>}
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title}{conversation.unreadCount ? ` (${conversation.unreadCount})` : ""}
              </option>
            ))}
          </select>
        </label>
        {usage && <UsagePill usage={usage} />}
      </div>

      {headerSlot && <div className="cw-dock-slot">{headerSlot}</div>}

      <ConversationTimeline
        items={items}
        emptyState={emptyState}
        followLatest={followLatest}
        onToolEventSelect={onToolEventSelect}
        onStatusAction={onStatusAction}
      />

      <footer className="cw-composer-region">
        {attachment && (
          <div className="cw-composer-attachment">
            {attachment.previewUrl ? <img src={attachment.previewUrl} alt="" /> : <ImagePlus aria-hidden="true" size={16} />}
            <span>
              <strong>{attachment.name}</strong>
              {attachment.metadata && <small>{attachment.metadata}</small>}
            </span>
            {onRemoveAttachment && (
              <button type="button" onClick={onRemoveAttachment} aria-label={`Remove ${attachment.name}`}>
                <X aria-hidden="true" size={15} />
              </button>
            )}
          </div>
        )}
        {composerSlot}
        <form className="cw-composer" onSubmit={submit}>
          <textarea
            ref={composerRef}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={placeholder}
            aria-label="Message to agent"
            rows={1}
            disabled={disabled}
          />
          <div className="cw-composer-actions">
            <div className="cw-composer-options">
              {onAttach && (
                <button type="button" onClick={onAttach} aria-label="Attach image" title="Attach image" disabled={disabled || running}>
                  <ImagePlus aria-hidden="true" size={17} />
                </button>
              )}
              <label className="cw-reasoning-mode">
                <span className="cw-sr-only">Reasoning mode</span>
                <select
                  value={reasoningMode}
                  onChange={(event) => onReasoningModeChange(event.target.value)}
                  disabled={disabled || running}
                  aria-label="Reasoning mode"
                >
                  {reasoningModes.map((mode) => (
                    <option key={mode.value} value={mode.value} disabled={mode.disabled} title={mode.description}>
                      {mode.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {running ? (
              <button type="button" className="cw-stop-button" onClick={onStop} aria-label="Stop agent">
                <Square aria-hidden="true" size={14} fill="currentColor" />
                <span>Stop</span>
              </button>
            ) : (
              <button type="submit" className="cw-send-button" disabled={!canSubmit} aria-label="Send message">
                <Send aria-hidden="true" size={16} />
              </button>
            )}
          </div>
        </form>
      </footer>

    </section>
  );
}
