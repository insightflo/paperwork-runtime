import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

export type AgentStepKind = "model" | "tool" | "waiting" | "handoff";

export interface AgentStep {
  id: string;
  kind: AgentStepKind;
  label: string;
  durationMs?: number | null;
  failed?: boolean;
}

export interface SubagentEntry {
  runId: string;
  agentId: string;
  agentName: string;
  status: "running" | "done" | "failed" | "waiting" | string;
  startedAt?: string | null;
}

export function summarizeSteps(steps: AgentStep[]): { total: number; failed: number; totalSec: number } {
  let failed = 0;
  let ms = 0;
  for (const s of steps) {
    if (s.failed) failed += 1;
    ms += s.durationMs ?? 0;
  }
  return { total: steps.length, failed, totalSec: Math.round(ms / 1000) };
}

export function stepSummaryText(steps: AgentStep[]): string {
  const { total, failed, totalSec } = summarizeSteps(steps);
  const parts = [`${total} steps`];
  if (totalSec > 0) parts.push(`${totalSec}s`);
  if (failed > 0) parts.push(`실패 ${failed}`);
  return parts.join(" · ");
}

export function subagentProgress(entries: SubagentEntry[]): { done: number; total: number } {
  const done = entries.filter((e) => e.status === "done" || e.status === "failed").length;
  return { done, total: entries.length };
}

const STEP_TONE: Record<AgentStepKind, string> = {
  model: "var(--openbot-accent-text)",
  tool: "var(--openbot-success-text)",
  waiting: "var(--openbot-warning-text)",
  handoff: "var(--openbot-info-text)",
};

function useElapsedSeconds(startedAt: string | null | undefined, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, startedAt]);
  if (!startedAt) return 0;
  return Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000));
}

/** Collapsible one-line step summary bar expanding to a per-step breakdown. */
export function AgentStepsDisclosure(props: { steps: AgentStep[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  if (props.steps.length === 0) return null;
  return (
    <div className="rounded-md border border-border/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        aria-expanded={open}
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        {stepSummaryText(props.steps)}
      </button>
      {open && (
        <div className="border-t border-border/60 px-3 py-1.5 space-y-0.5">
          {props.steps.map((step) => (
            <div key={step.id} className="flex items-center gap-2 text-[11px] font-mono">
              <span style={{ color: STEP_TONE[step.kind] }} className="w-14 shrink-0">{step.kind}</span>
              <span className={cn("flex-1 min-w-0 truncate", step.failed && "text-destructive")}>{step.label}</span>
              {step.durationMs != null && (
                <span className="text-muted-foreground shrink-0">{(step.durationMs / 1000).toFixed(1)}s</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Sticky subagent progress header with radial completion ring and elapsed timer. */
export function SubagentDock(props: { entries: SubagentEntry[]; basePath?: string }) {
  const [open, setOpen] = useState(false);
  const { done, total } = subagentProgress(props.entries);
  const anyRunning = props.entries.some((e) => e.status === "running");
  const firstStarted = props.entries.find((e) => e.startedAt)?.startedAt;
  const elapsed = useElapsedSeconds(firstStarted, anyRunning);
  const pct = total === 0 ? 0 : done / total;
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const running = useMemo(() => props.entries.filter((e) => e.status === "running"), [props.entries]);

  if (total === 0) return null;
  return (
    <div
      className="sticky top-0 z-10 rounded-md border border-border backdrop-blur-md"
      style={{ backgroundColor: "var(--openbot-bg-glass)", boxShadow: "var(--openbot-surface-25d-shadow)" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11px] font-medium"
        aria-expanded={open}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={radius} fill="none" stroke="var(--openbot-ring-track)" strokeWidth="2.5" />
          <circle
            cx="9" cy="9" r={radius} fill="none"
            stroke="var(--openbot-ring-fill)" strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - pct)}
            transform="rotate(-90 9 9)"
          />
        </svg>
        <span>{done}/{total} 완료</span>
        {anyRunning && <span className="text-muted-foreground font-mono">{elapsed}s</span>}
        <ChevronRight className={cn("ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="border-t border-border/60">
          {props.entries.map((e) => (
            <Link
              key={e.runId}
              to={`${props.basePath ?? "/agents"}/${e.agentId}/runs/${e.runId}`}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-accent/40 no-underline text-inherit"
            >
              <span className="flex-1 min-w-0 truncate">{e.agentName}</span>
              <span className="text-muted-foreground">{e.status}</span>
            </Link>
          ))}
          {running.length === 0 && !anyRunning && null}
        </div>
      )}
    </div>
  );
}
