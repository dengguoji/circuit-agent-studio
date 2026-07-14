import { describe, expect, it } from "vitest";

import {
  advanceAgentRunProgress,
  createAgentRunProgress,
  getAgentRunBudgetViolation,
  hasExplicitClearIntent,
  isRunResponseCurrent,
  isToolExecutionAuthorized,
  resolveClearCanvasPermission,
} from "../src/agentRunPolicy";

describe("clear_canvas authorization", () => {
  it.each([
    "清空画布重新画一张",
    "请重置当前画布",
    "新建一个画布",
    "这个方案不对，从头重画",
    "全部重画",
    "clear the canvas and redraw it",
    "start over with a new circuit",
    "redraw from scratch",
  ])("opens clear_canvas for explicit intent: %s", (message) => {
    expect(hasExplicitClearIntent(message)).toBe(true);
  });

  it.each([
    "把 R1 移到右边并重新连接",
    "重新布局，但保留现在的元件",
    "继续画后面的导线",
    "调整电阻位置",
    "修改当前画布",
    "不要清空画布，只改 R1",
    "do not clear the canvas; reconnect R1",
  ])("keeps clear_canvas closed for edit or negated intent: %s", (message) => {
    expect(hasExplicitClearIntent(message)).toBe(false);
  });

  it("requires both explicit user intent and provider permission", () => {
    expect(resolveClearCanvasPermission("清空画布", true)).toBe(true);
    expect(resolveClearCanvasPermission("清空画布", false)).toBe(false);
    expect(resolveClearCanvasPermission("调整布局", true)).toBe(false);
  });

  it("enforces the permission again at tool execution", () => {
    expect(isToolExecutionAuthorized("move_component", false)).toBe(true);
    expect(isToolExecutionAuthorized("clear_canvas", false)).toBe(false);
    expect(isToolExecutionAuthorized("clear_canvas", true)).toBe(true);
  });
});

describe("run identity and late responses", () => {
  it("accepts only the active non-stopped run", () => {
    expect(isRunResponseCurrent({ runId: 7, activeRunId: 7 })).toBe(true);
    expect(isRunResponseCurrent({ runId: 6, activeRunId: 7 })).toBe(false);
    expect(isRunResponseCurrent({ runId: 7, activeRunId: 7, stopped: true })).toBe(false);
    expect(isRunResponseCurrent({ runId: 7, activeRunId: 7, aborted: true })).toBe(false);
    expect(isRunResponseCurrent({ runId: 7, activeRunId: null })).toBe(false);
  });
});

describe("hard run budgets", () => {
  it("allows the exact 32-step boundary and rejects step 33", () => {
    expect(getAgentRunBudgetViolation({ modelSteps: 31, toolCalls: 0, repairCycles: 0 }, { modelSteps: 1 })).toBeNull();
    expect(getAgentRunBudgetViolation({ modelSteps: 32, toolCalls: 0, repairCycles: 0 }, { modelSteps: 1 })).toBe("round_limit");
  });

  it("allows exactly 160 tools and rejects the next one", () => {
    expect(getAgentRunBudgetViolation({ modelSteps: 1, toolCalls: 155, repairCycles: 0 }, { toolCalls: 5 })).toBeNull();
    expect(getAgentRunBudgetViolation({ modelSteps: 1, toolCalls: 160, repairCycles: 0 }, { toolCalls: 1 })).toBe("tool_limit");
  });

  it("allows three repair attempts and rejects a fourth", () => {
    expect(getAgentRunBudgetViolation({ modelSteps: 2, toolCalls: 2, repairCycles: 2 }, { repairCycles: 1 })).toBeNull();
    expect(getAgentRunBudgetViolation({ modelSteps: 3, toolCalls: 3, repairCycles: 3 }, { repairCycles: 1 })).toBe("repair_budget");
  });
});

describe("progress circuit breakers", () => {
  it("does not count catalog, detail or inspection-only steps as stalled canvas work", () => {
    const initial = createAgentRunProgress("canvas-a", "issues-a");
    const catalog = advanceAgentRunProgress(initial, {
      canvasFingerprint: "canvas-a",
      issueFingerprint: "issues-a",
      issueCount: 1,
      mutationAttempted: false,
    });
    const detail = advanceAgentRunProgress(catalog.progress, {
      canvasFingerprint: "canvas-a",
      issueFingerprint: "issues-a",
      issueCount: 1,
      mutationAttempted: false,
    });

    expect(catalog.stopReason).toBeNull();
    expect(detail.stopReason).toBeNull();
    expect(detail.progress.stalledRounds).toBe(0);
    expect(detail.progress.repeatedIssueRounds).toBe(0);
  });

  it("stops after two consecutive steps with no canvas or issue change", () => {
    const initial = createAgentRunProgress("canvas-a", "issues-a");
    const first = advanceAgentRunProgress(initial, {
      canvasFingerprint: "canvas-a",
      issueFingerprint: "issues-a",
      issueCount: 1,
    });
    const second = advanceAgentRunProgress(first.progress, {
      canvasFingerprint: "canvas-a",
      issueFingerprint: "issues-a",
      issueCount: 1,
    });

    expect(first.stopReason).toBeNull();
    expect(first.progress.stalledRounds).toBe(1);
    expect(second.stopReason).toBe("no_progress");
    expect(second.progress.stalledRounds).toBe(2);
  });

  it("stops when the same issue set survives three inspections", () => {
    let decision = {
      progress: createAgentRunProgress("canvas-0", "same-issues"),
      stopReason: null,
    };

    for (let index = 1; index <= 3; index += 1) {
      decision = advanceAgentRunProgress(decision.progress, {
        canvasFingerprint: `canvas-${index}`,
        issueFingerprint: "same-issues",
        issueCount: 2,
        repairCycles: 1,
      });
    }

    expect(decision.progress.repeatedIssueRounds).toBe(3);
    expect(decision.stopReason).toBe("repair_budget");
  });

  it("stops at step 32 only when another model continuation is required", () => {
    const initial = {
      ...createAgentRunProgress("canvas-a", ""),
      modelSteps: 31,
    };
    const finalResponse = advanceAgentRunProgress(initial, {
      canvasFingerprint: "canvas-final",
      issueFingerprint: "",
      issueCount: 0,
      requiresContinuation: false,
    });
    const toolResponse = advanceAgentRunProgress(initial, {
      canvasFingerprint: "canvas-tool",
      issueFingerprint: "",
      issueCount: 0,
      requiresContinuation: true,
    });

    expect(finalResponse.stopReason).toBeNull();
    expect(toolResponse.stopReason).toBe("round_limit");
  });

  it("does not apply a tool batch that would exceed the tool budget", () => {
    const initial = {
      ...createAgentRunProgress("canvas-a", ""),
      toolCalls: 159,
    };
    const decision = advanceAgentRunProgress(initial, {
      canvasFingerprint: "canvas-b",
      issueFingerprint: "",
      issueCount: 0,
      toolCalls: 2,
    });

    expect(decision.stopReason).toBe("tool_limit");
    expect(decision.progress).toBe(initial);
  });
});
