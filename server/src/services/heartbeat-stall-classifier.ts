export type RunStallVerdict = "active" | "slow_tool_grace" | "stalled";

export interface RunStallInput {
  lastOutputAtMs: number;
  startedAtMs: number;
  nowMs: number;
  activeToolCall?: boolean;
  idleThresholdMs?: number;
  toolGraceThresholdMs?: number;
}

export interface RunStallAssessment {
  verdict: RunStallVerdict;
  idleMs: number;
  effectiveThresholdMs: number;
  reason: string;
}

const DEFAULT_IDLE_THRESHOLD_MS = 300_000;
const DEFAULT_TOOL_GRACE_THRESHOLD_MS = 900_000;

export function assessRunStall(input: RunStallInput): RunStallAssessment {
  const idleThresholdMs = input.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const toolGraceThresholdMs = input.toolGraceThresholdMs ?? DEFAULT_TOOL_GRACE_THRESHOLD_MS;
  const lastActivityAtMs = Math.max(input.lastOutputAtMs, input.startedAtMs);
  const idleMs = Math.max(0, input.nowMs - lastActivityAtMs);

  if (idleMs < idleThresholdMs) {
    return {
      verdict: "active",
      idleMs,
      effectiveThresholdMs: idleThresholdMs,
      reason: `Run produced output ${idleMs}ms ago, below the ${idleThresholdMs}ms idle threshold.`,
    };
  }

  if (input.activeToolCall && idleMs < toolGraceThresholdMs) {
    return {
      verdict: "slow_tool_grace",
      idleMs,
      effectiveThresholdMs: toolGraceThresholdMs,
      reason: `Run has an active tool call and is inside the ${toolGraceThresholdMs}ms tool grace threshold.`,
    };
  }

  const effectiveThresholdMs = input.activeToolCall ? toolGraceThresholdMs : idleThresholdMs;
  return {
    verdict: "stalled",
    idleMs,
    effectiveThresholdMs,
    reason: input.activeToolCall
      ? `Run has been idle for ${idleMs}ms, meeting or exceeding the ${effectiveThresholdMs}ms tool grace threshold.`
      : `Run has been idle for ${idleMs}ms, meeting or exceeding the ${effectiveThresholdMs}ms idle threshold.`,
  };
}
