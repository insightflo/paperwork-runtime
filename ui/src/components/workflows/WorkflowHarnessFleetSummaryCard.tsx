import { cn } from "@/lib/utils";

export interface WorkflowHarnessFleetSummaryCardProps {
  readonly totalRuns: number;
  readonly healthyRuns: number;
  readonly stalledRuns: number;
  readonly timedOutRuns: number;
  readonly sharpRuns: number;
  readonly splitRuns: number;
  readonly escalatedRuns: number;
  readonly pendingAdvisorGates: number;
  readonly challengedAdvisorGates: number;
  /** Mean success rate across runs, in percent. `null` when no run has finished. */
  readonly avgSuccessRatePct: number | null;
  /** Longest time any run has sat without progress, in milliseconds. */
  readonly maxIdleMs: number;
}

type Tone = "neutral" | "good" | "warning" | "danger";

const TONE_CLASS: Record<Tone, string> = {
  neutral:
    "border-slate-200/80 bg-slate-50 text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#a7b3c6]",
  good: "border-[#65a30d]/30 bg-[#65a30d]/10 text-[#4d7c0f] dark:border-[#a3e635]/35 dark:bg-[#a3e635]/10 dark:text-[#a3e635]",
  warning:
    "border-amber-600/30 bg-amber-50 text-amber-800 dark:border-[#f59e0b]/40 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]",
  danger:
    "border-red-600/30 bg-red-50 text-red-700 dark:border-red-400/40 dark:bg-red-500/10 dark:text-red-300",
};

const CARD_CLASS =
  "@container tactile-card flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 overflow-hidden rounded-[12px] border border-slate-200/90 px-3 py-2 tabular-nums text-xs text-slate-950 dark:border-white/[0.08] dark:text-[#edf2fb]";

const DIVIDER_CLASS = "h-4 w-px shrink-0 bg-slate-200/90 dark:bg-white/[0.08]";

/** Formats a percent with one decimal place; `null` (or non-finite) renders as an em dash. */
function formatSuccessRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

/** Compact duration for idle time: `42s`, `3m 5s`, `2h 14m`. */
function formatIdleDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function warningTone(count: number, tone: Tone = "warning"): Tone {
  return count > 0 ? tone : "neutral";
}

function Metric({ id, label, value, tone }: { readonly id: string; readonly label: string; readonly value: string; readonly tone: Tone }) {
  return (
    <span
      data-metric={id}
      data-tone={tone}
      className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 whitespace-nowrap", TONE_CLASS[tone])}
    >
      <span className="text-[11px] tracking-wide uppercase opacity-80">{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  );
}

function Divider() {
  return <span aria-hidden="true" className={DIVIDER_CLASS} />;
}

export function WorkflowHarnessFleetSummaryCard(props: WorkflowHarnessFleetSummaryCardProps) {
  const {
    totalRuns,
    healthyRuns,
    stalledRuns,
    timedOutRuns,
    sharpRuns,
    splitRuns,
    escalatedRuns,
    pendingAdvisorGates,
    challengedAdvisorGates,
    avgSuccessRatePct,
    maxIdleMs,
  } = props;
  const empty = totalRuns === 0;

  return (
    <section className={CARD_CLASS} aria-label="Workflow harness fleet summary">
      <h3 className="mr-1 text-xs font-semibold text-slate-950 dark:text-[#edf2fb]">Harness fleet</h3>
      {empty ? (
        <p className="text-slate-500 dark:text-[#8f9db3]">No runs yet</p>
      ) : (
        <>
          <Metric id="total" label="Total" value={String(totalRuns)} tone="neutral" />
          <Metric id="healthy" label="Healthy" value={String(healthyRuns)} tone={healthyRuns > 0 ? "good" : "neutral"} />
          <Metric id="stalled" label="Stalled" value={String(stalledRuns)} tone={warningTone(stalledRuns)} />
          <Metric id="timed-out" label="Timed out" value={String(timedOutRuns)} tone={warningTone(timedOutRuns)} />
          <Divider />
          <Metric id="sharp" label="Sharp" value={String(sharpRuns)} tone="neutral" />
          <Metric id="split" label="Split" value={String(splitRuns)} tone="neutral" />
          <Metric id="escalated" label="Escalate" value={String(escalatedRuns)} tone={warningTone(escalatedRuns)} />
          <Divider />
          <Metric id="advisor-pending" label="Gates" value={String(pendingAdvisorGates)} tone={warningTone(pendingAdvisorGates)} />
          <Metric id="advisor-challenged" label="Challenged" value={String(challengedAdvisorGates)} tone={warningTone(challengedAdvisorGates, "danger")} />
          <Divider />
          <Metric id="idle" label="Max idle" value={formatIdleDuration(maxIdleMs)} tone="neutral" />
        </>
      )}
      <Metric id="success-rate" label="Success" value={formatSuccessRate(avgSuccessRatePct)} tone="neutral" />
    </section>
  );
}
