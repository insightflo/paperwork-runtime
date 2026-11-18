import { describe, expect, it } from "vitest";
import type { HeartbeatRun, HeartbeatRunEvent } from "@paperclipai/shared";
import { buildRunTraceSpans, filterTraceSpansAtCursor, summarizeTraceSteps } from "./trace-spans";

function makeEvent(partial: Partial<HeartbeatRunEvent> & { id: number; seq: number; createdAt: Date }): HeartbeatRunEvent {
  return {
    companyId: "c1",
    runId: "r1",
    agentId: "a1",
    eventType: "lifecycle",
    stream: "system",
    level: "info",
    color: null,
    message: null,
    payload: null,
    ...partial,
  };
}

describe("trace-spans", () => {
  const t0 = new Date("2026-11-18T10:00:00.000Z");
  const run = {
    id: "r1",
    status: "succeeded",
    startedAt: t0,
    finishedAt: new Date(t0.getTime() + 10_000),
    createdAt: t0,
    usageJson: null,
    resultJson: null,
    error: null,
  } as unknown as HeartbeatRun;

  it("derives spans, detects slowest bottleneck span, and rolls up tokens/cost", () => {
    const events: HeartbeatRunEvent[] = [
      makeEvent({ id: 1, seq: 1, eventType: "model_turn", payload: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }, createdAt: t0 }),
      makeEvent({ id: 2, seq: 2, eventType: "tool_call", payload: { toolName: "read_file" }, createdAt: new Date(t0.getTime() + 1500) }),
      makeEvent({ id: 3, seq: 3, eventType: "model_turn", payload: { inputTokens: 400, outputTokens: 200, costUsd: 0.03 }, createdAt: new Date(t0.getTime() + 2000) }),
      makeEvent({ id: 4, seq: 4, eventType: "handoff_delegate", message: "Delegate to Synthesis", createdAt: new Date(t0.getTime() + 9000) }),
    ];

    const spans = buildRunTraceSpans(run, events);
    expect(spans).toHaveLength(4);
    expect(spans.find((s) => s.isSlowest)?.id).toBe("3");

    const summary = summarizeTraceSteps(spans);
    expect(summary.modelCalls).toBe(2);
    expect(summary.toolCalls).toBe(1);
    expect(summary.handoffs).toBe(1);
    expect(summary.totalTokens).toBe(750);
    expect(summary.totalCostUsd).toBeCloseTo(0.04, 5);
    expect(summary.slowestSpanId).toBe("3");
  });

  it("filters and clips running spans cleanly during timeline replay", () => {
    const events: HeartbeatRunEvent[] = [
      makeEvent({ id: 1, seq: 1, eventType: "model_turn", createdAt: t0 }),
      makeEvent({ id: 2, seq: 2, eventType: "tool_call", payload: { toolName: "grep" }, createdAt: new Date(t0.getTime() + 3000) }),
    ];
    const spans = buildRunTraceSpans(run, events);
    const at2s = filterTraceSpansAtCursor(spans, 2000);
    expect(at2s).toHaveLength(1);
    expect(at2s[0]?.durationMs).toBe(2000);
    expect(at2s[0]?.running).toBe(true);
  });
});
