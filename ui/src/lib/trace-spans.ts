import type { HeartbeatRun, HeartbeatRunEvent } from "@paperclipai/shared";

export type TraceSpanKind = "model" | "tool" | "waiting" | "handoff" | "error" | "lifecycle";

export interface TraceSpan {
  id: string;
  label: string;
  detail?: string;
  kind: TraceSpanKind;
  startOffsetMs: number;
  durationMs: number;
  endOffsetMs: number;
  running: boolean;
  failed: boolean;
  tokens: number;
  costUsd: number;
  subtreeTokens: number;
  subtreeCostUsd: number;
  isSlowest: boolean;
}

export interface TraceSummary {
  totalSteps: number;
  modelCalls: number;
  toolCalls: number;
  waitSteps: number;
  handoffs: number;
  errors: number;
  totalDurationMs: number;
  totalTokens: number;
  totalCostUsd: number;
  slowestSpanId: string | null;
}

function asNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readCostAndTokens(payload: Record<string, unknown> | null): { tokens: number; costUsd: number } {
  if (!payload) return { tokens: 0, costUsd: 0 };
  const input = asNum(payload.inputTokens) + asNum(payload.input_tokens);
  const output = asNum(payload.outputTokens) + asNum(payload.output_tokens);
  const cached = asNum(payload.cachedInputTokens) + asNum(payload.cached_input_tokens);
  const explicitTotal = asNum(payload.totalTokens) + asNum(payload.tokens);
  const tokens = explicitTotal > 0 ? explicitTotal : input + output + cached;
  const costUsd = asNum(payload.costUsd) || asNum(payload.total_cost_usd) || asNum(payload.costCents) / 100;
  return { tokens, costUsd };
}

function classifyEventKind(event: HeartbeatRunEvent): TraceSpanKind {
  const type = event.eventType.toLowerCase();
  const level = (event.level ?? "").toLowerCase();
  const msg = (event.message ?? "").toLowerCase();
  if (level === "error" || type.includes("error") || type.includes("fail") || event.stream === "stderr") return "error";
  if (type.includes("handoff") || type.includes("delegate") || type.includes("wakeup") || msg.includes("handoff")) {
    return "handoff";
  }
  if (type.includes("wait") || type.includes("approval") || type.includes("held") || type.includes("defer")) {
    return "waiting";
  }
  if (type.includes("tool") || Boolean(asRecord(event.payload)?.toolName ?? asRecord(event.payload)?.tool)) {
    return "tool";
  }
  if (type.includes("model") || type.includes("llm") || type.includes("assistant") || type.includes("thinking") || type.includes("turn")) {
    return "model";
  }
  return "lifecycle";
}

function eventLabel(event: HeartbeatRunEvent, kind: TraceSpanKind): string {
  const payload = asRecord(event.payload);
  const toolName = typeof payload?.toolName === "string" ? payload.toolName : typeof payload?.name === "string" ? payload.name : null;
  if (toolName) return toolName;
  if (event.message && event.message.trim().length > 0) {
    const firstLine = event.message.trim().split(/\r?\n/, 1)[0] ?? "";
    return firstLine.length > 64 ? `${firstLine.slice(0, 61)}…` : firstLine;
  }
  return `${kind}:${event.eventType}`;
}

export function buildRunTraceSpans(
  run: Pick<HeartbeatRun, "id" | "status" | "startedAt" | "finishedAt" | "createdAt" | "usageJson" | "resultJson" | "error">,
  events: readonly HeartbeatRunEvent[],
  nowMs: number = Date.now(),
): TraceSpan[] {
  const startMs = new Date(run.startedAt ?? run.createdAt).getTime();
  const fallbackEndMs = run.finishedAt ? new Date(run.finishedAt).getTime() : Math.max(startMs, nowMs);
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  const rawSpans: Omit<TraceSpan, "subtreeTokens" | "subtreeCostUsd" | "isSlowest">[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const ev = sorted[i]!;
    const evStartMs = Math.max(startMs, new Date(ev.createdAt).getTime());
    const nextEv = sorted[i + 1];
    const evEndMs = nextEv ? Math.max(evStartMs, new Date(nextEv.createdAt).getTime()) : Math.max(evStartMs, fallbackEndMs);
    const kind = classifyEventKind(ev);
    const { tokens, costUsd } = readCostAndTokens(asRecord(ev.payload));
    const startOffsetMs = Math.max(0, evStartMs - startMs);
    const durationMs = Math.max(0, evEndMs - evStartMs);
    rawSpans.push({
      id: String(ev.id),
      label: eventLabel(ev, kind),
      detail: ev.eventType,
      kind,
      startOffsetMs,
      durationMs,
      endOffsetMs: startOffsetMs + durationMs,
      running: !nextEv && (run.status === "running" || run.status === "queued"),
      failed: kind === "error",
      tokens,
      costUsd,
    });
  }

  if (rawSpans.length === 0) {
    const usage = readCostAndTokens(asRecord(run.usageJson));
    const res = readCostAndTokens(asRecord(run.resultJson));
    const durationMs = Math.max(0, fallbackEndMs - startMs);
    const failed = run.status === "failed" || run.status === "timed_out" || Boolean(run.error);
    rawSpans.push({
      id: `${run.id}-exec`,
      label: failed ? "Execution failed" : "Model execution",
      detail: run.status,
      kind: failed ? "error" : "model",
      startOffsetMs: 0,
      durationMs,
      endOffsetMs: durationMs,
      running: run.status === "running" || run.status === "queued",
      failed,
      tokens: usage.tokens || res.tokens,
      costUsd: usage.costUsd || res.costUsd,
    });
  }

  const workSpans = rawSpans.filter((s) => !s.running && (s.kind === "model" || s.kind === "tool") && s.durationMs > 0);
  const slowestId =
    workSpans.length >= 2
      ? workSpans.reduce((max, cur) => (cur.durationMs > max.durationMs ? cur : max)).id
      : null;

  return rawSpans.map((span) => ({
    ...span,
    subtreeTokens: span.tokens,
    subtreeCostUsd: span.costUsd,
    isSlowest: span.id === slowestId,
  }));
}

export function filterTraceSpansAtCursor(spans: readonly TraceSpan[], playheadMs: number | null): TraceSpan[] {
  if (playheadMs === null) return [...spans];
  return spans
    .filter((s) => s.startOffsetMs <= playheadMs)
    .map((s) => {
      if (s.endOffsetMs <= playheadMs) return s;
      const clipped = Math.max(0, playheadMs - s.startOffsetMs);
      return { ...s, durationMs: clipped, endOffsetMs: s.startOffsetMs + clipped, running: true };
    });
}

export function summarizeTraceSteps(spans: readonly TraceSpan[]): TraceSummary {
  let modelCalls = 0;
  let toolCalls = 0;
  let waitSteps = 0;
  let handoffs = 0;
  let errors = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let slowestSpanId: string | null = null;

  for (const span of spans) {
    totalDurationMs = Math.max(totalDurationMs, span.endOffsetMs);
    totalTokens += span.tokens;
    totalCostUsd += span.costUsd;
    if (span.isSlowest) slowestSpanId = span.id;
    if (span.failed) errors += 1;
    if (span.kind === "model") modelCalls += 1;
    else if (span.kind === "tool") toolCalls += 1;
    else if (span.kind === "waiting") waitSteps += 1;
    else if (span.kind === "handoff") handoffs += 1;
  }

  return {
    totalSteps: spans.length,
    modelCalls,
    toolCalls,
    waitSteps,
    handoffs,
    errors,
    totalDurationMs,
    totalTokens,
    totalCostUsd,
    slowestSpanId,
  };
}
