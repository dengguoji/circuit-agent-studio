import {
  AGENT_MAX_MODEL_ROUNDS,
  AGENT_MAX_REPAIR_CYCLES,
  AGENT_MAX_STALLED_ROUNDS,
  AGENT_MAX_TOOL_CALLS,
} from "./appConfig";
import type { AgentStopReason } from "./appTypes";

export type AgentRunLimits = {
  maxModelSteps: number;
  maxToolCalls: number;
  maxRepairCycles: number;
  maxStalledRounds: number;
  maxRepeatedIssueRounds: number;
};

export type AgentRunCounters = {
  modelSteps: number;
  toolCalls: number;
  repairCycles: number;
};

export type AgentRunProgress = AgentRunCounters & {
  stalledRounds: number;
  repeatedIssueRounds: number;
  previousCanvasFingerprint: string;
  previousIssueFingerprint: string;
};

export type AgentRunProgressObservation = {
  canvasFingerprint: string;
  issueFingerprint: string;
  issueCount: number;
  modelSteps?: number;
  toolCalls?: number;
  repairCycles?: number;
  /** Read-only discovery/inspection steps must not count as stalled canvas work. */
  mutationAttempted?: boolean;
  /** True when another model step is required after applying this observation. */
  requiresContinuation?: boolean;
};

export type AgentRunPolicyDecision = {
  progress: AgentRunProgress;
  stopReason: AgentStopReason | null;
};

export type RunResponseIdentity = {
  runId: number;
  activeRunId: number | null | undefined;
  stopped?: boolean;
  aborted?: boolean;
};

export const DEFAULT_AGENT_RUN_LIMITS: Readonly<AgentRunLimits> = {
  maxModelSteps: AGENT_MAX_MODEL_ROUNDS,
  maxToolCalls: AGENT_MAX_TOOL_CALLS,
  maxRepairCycles: AGENT_MAX_REPAIR_CYCLES,
  maxStalledRounds: AGENT_MAX_STALLED_ROUNDS,
  maxRepeatedIssueRounds: AGENT_MAX_REPAIR_CYCLES,
};

const CHINESE_CLEAR_PATTERNS = [
  /清空(?:整个|当前)?画布/g,
  /清除(?:整个|当前)?画布/g,
  /重置(?:整个|当前)?画布/g,
  /新建(?:一个|一张)?画布/g,
  /从头重画/g,
  /全部重画/g,
  /重新画一张/g,
  /删除(?:所有|全部)元件/g,
];

const ENGLISH_CLEAR_PATTERNS = [
  /\bclear(?: the| this| current)? canvas\b/g,
  /\breset(?: the| this| current)? canvas\b/g,
  /\bnew canvas\b/g,
  /\bstart over\b/g,
  /\bredraw from scratch\b/g,
  /\bdelete all (?:components|parts|elements)\b/g,
];

/**
 * Only direct, affirmative requests open the destructive clear_canvas tool.
 * Editing language such as “重新连接” or a negated phrase such as “不要清空画布”
 * deliberately does not grant permission.
 */
export function hasExplicitClearIntent(message: string): boolean {
  const normalized = message.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return false;

  return [...CHINESE_CLEAR_PATTERNS, ...ENGLISH_CLEAR_PATTERNS].some((pattern) => {
    pattern.lastIndex = 0;
    let match = pattern.exec(normalized);
    while (match) {
      if (!isNegatedClearMatch(normalized, match.index)) return true;
      match = pattern.exec(normalized);
    }
    return false;
  });
}

/** User intent and the provider/backend decision must both allow clearing. */
export function resolveClearCanvasPermission(
  message: string,
  providerClearAllowed: boolean = true
): boolean {
  return hasExplicitClearIntent(message) && providerClearAllowed;
}

/** Executor-side authorization check; non-destructive tools are always allowed. */
export function isToolExecutionAuthorized(toolName: string, clearAllowed: boolean): boolean {
  return toolName !== "clear_canvas" || clearAllowed;
}

/**
 * A response is usable only for the currently active, non-stopped, non-aborted run.
 * Keeping this check pure makes late-response handling deterministic and testable.
 */
export function isRunResponseCurrent(identity: RunResponseIdentity): boolean {
  return (
    identity.activeRunId != null &&
    identity.runId === identity.activeRunId &&
    identity.stopped !== true &&
    identity.aborted !== true
  );
}

export function createAgentRunProgress(
  previousCanvasFingerprint: string,
  previousIssueFingerprint: string
): AgentRunProgress {
  return {
    modelSteps: 0,
    toolCalls: 0,
    repairCycles: 0,
    stalledRounds: 0,
    repeatedIssueRounds: 0,
    previousCanvasFingerprint,
    previousIssueFingerprint,
  };
}

/**
 * Checks whether scheduling more work would exceed a hard budget. Values equal to
 * the configured maximum are valid; the next unit is rejected.
 */
export function getAgentRunBudgetViolation(
  counters: AgentRunCounters,
  pending: Partial<AgentRunCounters> = {},
  limits: Readonly<AgentRunLimits> = DEFAULT_AGENT_RUN_LIMITS
): AgentStopReason | null {
  if (counters.modelSteps + (pending.modelSteps ?? 0) > limits.maxModelSteps) {
    return "round_limit";
  }
  if (counters.toolCalls + (pending.toolCalls ?? 0) > limits.maxToolCalls) {
    return "tool_limit";
  }
  if (counters.repairCycles + (pending.repairCycles ?? 0) > limits.maxRepairCycles) {
    return "repair_budget";
  }
  return null;
}

/**
 * Applies one completed model/tool observation and evaluates all automatic circuit
 * breakers. A rejected over-budget observation is not applied, because its work
 * must not have started.
 */
export function advanceAgentRunProgress(
  current: AgentRunProgress,
  observation: AgentRunProgressObservation,
  limits: Readonly<AgentRunLimits> = DEFAULT_AGENT_RUN_LIMITS
): AgentRunPolicyDecision {
  const pending: AgentRunCounters = {
    modelSteps: observation.modelSteps ?? 1,
    toolCalls: observation.toolCalls ?? 0,
    repairCycles: observation.repairCycles ?? 0,
  };
  const budgetViolation = getAgentRunBudgetViolation(current, pending, limits);
  if (budgetViolation) {
    return { progress: current, stopReason: budgetViolation };
  }

  const canvasUnchanged = observation.canvasFingerprint === current.previousCanvasFingerprint;
  const issuesUnchanged = observation.issueFingerprint === current.previousIssueFingerprint;
  const mutationAttempted = observation.mutationAttempted !== false;
  const stalledRounds = mutationAttempted
    ? canvasUnchanged && issuesUnchanged
      ? current.stalledRounds + 1
      : 0
    : current.stalledRounds;
  const repeatedIssueRounds =
    mutationAttempted && pending.repairCycles > 0 && observation.issueCount > 0
      ? issuesUnchanged
        ? current.repeatedIssueRounds + 1
        : 0
      : current.repeatedIssueRounds;

  const progress: AgentRunProgress = {
    modelSteps: current.modelSteps + pending.modelSteps,
    toolCalls: current.toolCalls + pending.toolCalls,
    repairCycles: current.repairCycles + pending.repairCycles,
    stalledRounds,
    repeatedIssueRounds,
    previousCanvasFingerprint: observation.canvasFingerprint,
    previousIssueFingerprint: observation.issueFingerprint,
  };

  if (stalledRounds >= limits.maxStalledRounds) {
    return { progress, stopReason: "no_progress" };
  }
  if (repeatedIssueRounds >= limits.maxRepeatedIssueRounds) {
    return { progress, stopReason: "repair_budget" };
  }
  if (observation.requiresContinuation === true && progress.modelSteps >= limits.maxModelSteps) {
    return { progress, stopReason: "round_limit" };
  }

  return { progress, stopReason: null };
}

function isNegatedClearMatch(message: string, matchIndex: number): boolean {
  const prefix = message.slice(Math.max(0, matchIndex - 24), matchIndex);
  return (
    /(?:不要|别|无需|不用|禁止|避免|不能|不可)(?:再|去|直接|把|将)?\s*$/.test(prefix) ||
    /\b(?:do not|don't|dont|never|without|not)\s+(?:ever\s+)?$/.test(prefix)
  );
}
