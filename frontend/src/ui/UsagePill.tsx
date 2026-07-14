import { Activity, ChevronDown } from "lucide-react";
import type { ContextUsage } from "./timelineTypes";

export type UsagePillProps = {
  usage: ContextUsage;
  label?: string;
  className?: string;
};

function formatTokenCount(value: number | undefined): string {
  if (value === undefined) return "—";
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function resolveContextPercent(usage: ContextUsage): number | null {
  if (!usage.contextWindow || usage.contextWindow <= 0 || usage.inputTokens === undefined) return null;
  return Math.max(0, (usage.inputTokens / usage.contextWindow) * 100);
}

export function UsagePill({ usage, label = "Context", className = "" }: UsagePillProps) {
  const percent = resolveContextPercent(usage);
  const level = percent === null ? "unknown" : percent >= 90 ? "critical" : percent >= 70 ? "warning" : "normal";

  return (
    <details className={["cw-usage-pill", `is-${level}`, className].filter(Boolean).join(" ")}>
      <summary aria-label={`${label} usage details`}>
        <Activity aria-hidden="true" size={14} />
        <span>{label}</span>
        <strong>{percent === null ? formatTokenCount(usage.inputTokens) : `${Math.min(percent, 999).toFixed(0)}%`}</strong>
        <ChevronDown className="cw-usage-chevron" aria-hidden="true" size={13} />
      </summary>
      <div className="cw-usage-popover">
        <div><span>Input</span><strong>{formatTokenCount(usage.inputTokens)}</strong></div>
        <div><span>Output</span><strong>{formatTokenCount(usage.outputTokens)}</strong></div>
        <div><span>Step total</span><strong>{formatTokenCount(usage.totalTokens)}</strong></div>
        {usage.cachedTokens !== undefined && <div><span>Cached</span><strong>{formatTokenCount(usage.cachedTokens)}</strong></div>}
        {usage.reasoningTokens !== undefined && <div><span>Reasoning</span><strong>{formatTokenCount(usage.reasoningTokens)}</strong></div>}
        {usage.imageTokens !== undefined && <div><span>Image</span><strong>{formatTokenCount(usage.imageTokens)}</strong></div>}
        {usage.sessionTotalTokens !== undefined && <div><span>Session</span><strong>{formatTokenCount(usage.sessionTotalTokens)}</strong></div>}
        {usage.contextWindow !== undefined && <div><span>Window</span><strong>{formatTokenCount(usage.contextWindow)}</strong></div>}
      </div>
    </details>
  );
}
