import {
  Bot,
  Brain,
  Check,
  CircleAlert,
  CircleStop,
  Clock,
  Loader2,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ConversationTimelineItem,
  ReasoningTimelineItem,
  StatusTimelineItem,
  TimelineItemStatus,
  ToolTimelineEvent,
  ToolTimelineItem,
} from "./timelineTypes";

export type ConversationTimelineProps = {
  items: ConversationTimelineItem[];
  emptyState?: ReactNode;
  followLatest?: boolean;
  onToolEventSelect?: (event: ToolTimelineEvent, group: ToolTimelineItem) => void;
  onStatusAction?: (item: StatusTimelineItem) => void;
  className?: string;
};

function StatusIcon({ status }: { status: TimelineItemStatus }) {
  if (status === "running") return <Loader2 className="cw-spin" aria-hidden="true" size={14} />;
  if (status === "success") return <Check aria-hidden="true" size={14} />;
  if (status === "stopped") return <CircleStop aria-hidden="true" size={14} />;
  if (status === "error") return <X aria-hidden="true" size={14} />;
  return <Clock aria-hidden="true" size={14} />;
}

function ToolEventRow({
  event,
  group,
  onSelect,
}: {
  event: ToolTimelineEvent;
  group: ToolTimelineItem;
  onSelect?: ConversationTimelineProps["onToolEventSelect"];
}) {
  const content = (
    <>
      <span className={`cw-tool-status is-${event.status}`}><StatusIcon status={event.status} /></span>
      <span className="cw-tool-copy">
        <strong>{event.name}</strong>
        {event.summary && <span>{event.summary}</span>}
        {event.detail && <code>{event.detail}</code>}
      </span>
    </>
  );

  if (!onSelect) return <div className="cw-tool-event">{content}</div>;

  return (
    <button type="button" className="cw-tool-event is-actionable" onClick={() => onSelect(event, group)}>
      {content}
    </button>
  );
}

function ReasoningCard({ item }: { item: ReasoningTimelineItem }) {
  const [open, setOpen] = useState(Boolean(item.defaultExpanded));

  useEffect(() => {
    if (item.status === "running") setOpen(true);
  }, [item.status]);

  return (
    <details className="cw-event-card is-reasoning" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="cw-event-icon"><Brain aria-hidden="true" size={15} /></span>
        <span>{item.title ?? "Reasoning summary"}</span>
        {item.status && <span className={`cw-event-state is-${item.status}`}><StatusIcon status={item.status} /></span>}
      </summary>
      <p>{item.summary}</p>
    </details>
  );
}

function ToolCard({
  item,
  onToolEventSelect,
}: {
  item: ToolTimelineItem;
  onToolEventSelect?: ConversationTimelineProps["onToolEventSelect"];
}) {
  const failed = item.events.filter((event) => event.status === "error").length;
  const running = item.events.some((event) => event.status === "running");
  const [open, setOpen] = useState(Boolean(item.defaultExpanded || running || failed > 0));

  useEffect(() => {
    if (running || failed > 0) setOpen(true);
  }, [failed, running]);

  return (
    <details className="cw-event-card is-tool" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="cw-event-icon"><Wrench aria-hidden="true" size={15} /></span>
        <span>{item.title ?? "Tool calls"}</span>
        <span className="cw-event-count">{item.events.length}</span>
        {failed > 0 && <span className="cw-event-error-count">{failed} failed</span>}
      </summary>
      <div className="cw-tool-events">
        {item.events.map((event) => (
          <ToolEventRow key={event.id} event={event} group={item} onSelect={onToolEventSelect} />
        ))}
      </div>
    </details>
  );
}

export function ConversationTimeline({
  items,
  emptyState,
  followLatest = true,
  onToolEventSelect,
  onStatusAction,
  className = "",
}: ConversationTimelineProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pinnedToLatestRef = useRef(true);
  const firstItemId = items[0]?.id;

  useEffect(() => {
    pinnedToLatestRef.current = true;
  }, [firstItemId]);

  useEffect(() => {
    if (!followLatest || !pinnedToLatestRef.current || !viewportRef.current) return;
    viewportRef.current.scrollTo({ top: viewportRef.current.scrollHeight, behavior: "smooth" });
  }, [followLatest, items]);

  function handleTimelineScroll() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distanceFromLatest = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    pinnedToLatestRef.current = distanceFromLatest <= 32;
  }

  return (
    <div
      ref={viewportRef}
      className={["cw-timeline", className].filter(Boolean).join(" ")}
      onScroll={handleTimelineScroll}
      tabIndex={0}
      aria-label="Conversation history"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {items.length === 0 ? (
        <div className="cw-timeline-empty">{emptyState}</div>
      ) : (
        items.map((item) => {
          if (item.kind === "message") {
            return (
              <article key={item.id} className={`cw-message is-${item.role} is-${item.status ?? "complete"}`}>
                <div className="cw-message-avatar" aria-hidden="true">
                  {item.role === "user" ? <UserRound size={15} /> : <Bot size={15} />}
                </div>
                <div className="cw-message-body">
                  <header>
                    <strong>{item.role === "user" ? "You" : "Agent"}</strong>
                    {item.createdAt && <time>{item.createdAt}</time>}
                  </header>
                  <p>{item.content}</p>
                </div>
              </article>
            );
          }

          if (item.kind === "reasoning") {
            return <ReasoningCard key={item.id} item={item} />;
          }

          if (item.kind === "tool") {
            return <ToolCard key={item.id} item={item} onToolEventSelect={onToolEventSelect} />;
          }

          return (
            <article key={item.id} className={`cw-status-event is-${item.tone ?? "neutral"}`}>
              <CircleAlert aria-hidden="true" size={15} />
              <div>
                <strong>{item.label}</strong>
                {item.detail && <p>{item.detail}</p>}
              </div>
              {item.actionLabel && onStatusAction && (
                <button type="button" onClick={() => onStatusAction(item)}>{item.actionLabel}</button>
              )}
            </article>
          );
        })
      )}
    </div>
  );
}
