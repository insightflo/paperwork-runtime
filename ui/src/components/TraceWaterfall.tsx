import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Pause, Play, RotateCcw, Clock } from "lucide-react";
import type { HeartbeatRun } from "@paperclipai/shared";
import { heartbeatsApi } from "../api/heartbeats";
import {
  buildRunTraceSpans,
  filterTraceSpansAtCursor,
  summarizeTraceSteps,
  type TraceSpanKind,
} from "../lib/trace-spans";
import { formatTokens, cn } from "../lib/utils";

const REPLAY_SPEEDS = [1, 2, 5, 10] as const;

function spanBarColor(kind: TraceSpanKind): string {
  switch (kind) {
    case "model":
      return "var(--openbot-span-model)";
    case "tool":
      return "var(--openbot-span-tool)";
    case "waiting":
      return "var(--openbot-span-wait)";
    case "handoff":
      return "var(--openbot-span-handoff)";
    case "error":
      return "var(--openbot-span-error)";
    default:
      return "var(--openbot-span-lifecycle)";
  }
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return `${min}m ${rem}s`;
}

export function TraceWaterfall({ run, adapterType }: { run: HeartbeatRun; adapterType: string }) {
  const [open, setOpen] = useState(true);
  const [speed, setSpeed] = useState<(typeof REPLAY_SPEEDS)[number]>(1);
  const [playing, setPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);

  const { data: events } = useQuery({
    queryKey: ["heartbeat-run-trace-events", run.id],
    queryFn: () => heartbeatsApi.events(run.id, 0, 200),
    enabled: Boolean(run.id),
    refetchInterval: run.status === "running" || run.status === "queued" ? 3000 : false,
  });

  const allSpans = useMemo(() => buildRunTraceSpans(run, events ?? []), [run, events]);
  const fullSummary = useMemo(() => summarizeTraceSteps(allSpans), [allSpans]);
  const totalMs = Math.max(1, fullSummary.totalDurationMs);

  useEffect(() => {
    setPlaying(false);
    setPlayheadMs(null);
  }, [run.id]);

  useEffect(() => {
    if (!playing) return;
    const stepMs = Math.max(25, Math.round((totalMs / 60) * speed));
    const timer = setInterval(() => {
      setPlayheadMs((prev) => {
        const next = (prev ?? 0) + stepMs;
        if (next >= totalMs) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, 50);
    return () => clearInterval(timer);
  }, [playing, speed, totalMs]);

  const visibleSpans = useMemo(() => filterTraceSpansAtCursor(allSpans, playheadMs), [allSpans, playheadMs]);
  const visibleSummary = useMemo(() => summarizeTraceSteps(visibleSpans), [visibleSpans]);

  return (
    <div
      data-provider={adapterType}
      className="rounded-lg border overflow-hidden"
      style={{
        borderColor: "var(--openbot-border-strong)",
        backgroundColor: "var(--openbot-bg-surface)",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b" style={{ borderColor: "var(--openbot-border)" }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 text-xs font-medium hover:opacity-80"
          style={{ color: "var(--openbot-text-primary)" }}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span>Trace Waterfall</span>
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[10px]"
            style={{ backgroundColor: "var(--openbot-accent-soft)", color: "var(--openbot-accent-text)" }}
          >
            {visibleSummary.totalSteps} steps
          </span>
          {visibleSummary.toolCalls > 0 && (
            <span className="text-[11px]" style={{ color: "var(--openbot-text-muted)" }}>
              · {visibleSummary.toolCalls} tools
            </span>
          )}
          {visibleSummary.errors > 0 && (
            <span className="text-[11px]" style={{ color: "var(--openbot-danger-text)" }}>
              · {visibleSummary.errors} errors
            </span>
          )}
        </button>

        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px]" style={{ color: "var(--openbot-text-muted)" }}>
            <Clock className="mr-1 inline h-3 w-3" />
            {formatDurationMs(playheadMs ?? fullSummary.totalDurationMs)}
          </span>
          <button
            type="button"
            onClick={() => {
              if (!playing && playheadMs === null) setPlayheadMs(0);
              setPlaying((p) => !p);
            }}
            aria-label={playing ? "Pause trace replay" : "Play trace replay"}
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] hover:opacity-80"
            style={{ borderColor: "var(--openbot-border-strong)", color: "var(--openbot-text-secondary)" }}
          >
            {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            <span>{playing ? "Pause" : "Replay"}</span>
          </button>
          <div className="inline-flex rounded border overflow-hidden" style={{ borderColor: "var(--openbot-border-strong)" }}>
            {REPLAY_SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                className={cn("px-1.5 py-0.5 font-mono text-[10px]", s === speed && "font-semibold")}
                style={
                  s === speed
                    ? { backgroundColor: "var(--openbot-accent-soft)", color: "var(--openbot-accent-text)" }
                    : { color: "var(--openbot-text-muted)" }
                }
              >
                {s}x
              </button>
            ))}
          </div>
          {playheadMs !== null && (
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                setPlayheadMs(null);
              }}
              aria-label="Reset trace replay"
              className="rounded p-1 hover:opacity-80"
              style={{ color: "var(--openbot-text-muted)" }}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="max-h-64 overflow-y-auto divide-y" style={{ borderColor: "var(--openbot-border)" }}>
          {visibleSpans.map((span) => {
            const leftPct = Math.min(98, (span.startOffsetMs / totalMs) * 100);
            const widthPct = Math.max(2, ((span.endOffsetMs - span.startOffsetMs) / totalMs) * 100);
            return (
              <div
                key={span.id}
                className="grid grid-cols-[minmax(120px,1fr)_minmax(120px,1.4fr)_auto] items-center gap-3 px-3 py-1.5 text-xs"
              >
                <div className="min-w-0 flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: spanBarColor(span.kind) }}
                  />
                  <span className="truncate font-mono text-[11px]" style={{ color: "var(--openbot-text-secondary)" }}>
                    {span.label}
                  </span>
                  {span.isSlowest && (
                    <span
                      className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase shrink-0"
                      style={{ backgroundColor: "var(--openbot-warning-soft)", color: "var(--openbot-warning-text)" }}
                    >
                      Slowest
                    </span>
                  )}
                </div>
                <div className="relative h-2.5 rounded-full overflow-hidden" style={{ backgroundColor: "var(--openbot-bg-surface-raised)" }}>
                  <div
                    className={cn("absolute top-0 bottom-0 rounded-full", span.running && "animate-pulse")}
                    style={{
                      left: `${leftPct}%`,
                      width: `${Math.min(100 - leftPct, widthPct)}%`,
                      backgroundColor: spanBarColor(span.kind),
                    }}
                  />
                </div>
                <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums shrink-0" style={{ color: "var(--openbot-text-muted)" }}>
                  <span>{formatDurationMs(span.durationMs)}</span>
                  {span.subtreeTokens > 0 && <span>{formatTokens(span.subtreeTokens)} tok</span>}
                  {span.subtreeCostUsd > 0 && <span>${span.subtreeCostUsd.toFixed(4)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
