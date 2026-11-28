import { cn } from "../lib/utils";

export interface ExceptionHuddleTelemetryBarData {
  total: number;
  byStatus: { open: number; timed_out: number; decided: number; cancelled: number };
  averageRoundsOnDecided: number | null;
  timeoutRate: number;
  chairForcedDecisionCount: number;
  resolutionRate: number;
}

export interface ExceptionHuddleTelemetryBarProps {
  summary: ExceptionHuddleTelemetryBarData;
  className?: string;
}

const KPI_CARD = "rounded-[10px] border border-border/70 bg-background/70 px-3 py-2 dark:border-white/[0.08] dark:bg-[#07090d]";
const KPI_LABEL = "font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground dark:text-[#8f9db3]";
const KPI_VALUE = "mt-1 font-mono text-lg font-semibold leading-none text-foreground dark:text-[#eef2f8]";
const TIMED_OUT_ACTIVE = "border-amber-600/30 bg-amber-500/10 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12";
const TIMED_OUT_VALUE_ACTIVE = "text-amber-800 dark:text-[#f59e0b]";

function Kpi({ label, value, className, valueClassName }: { label: string; value: string | number; className?: string; valueClassName?: string }) {
  return (
    <div className={cn(KPI_CARD, className)}>
      <dt className={KPI_LABEL}>{label}</dt>
      <dd className={cn(KPI_VALUE, valueClassName)}>{value}</dd>
    </div>
  );
}

export function ExceptionHuddleTelemetryBar({ summary, className }: ExceptionHuddleTelemetryBarProps) {
  if (summary.total === 0) {
    return (
      <section aria-label="Exception huddle telemetry" className={cn("tactile-card rounded-[12px] border border-border/80 bg-card/90 px-3 py-2 text-card-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_10px_28px_rgba(15,23,42,0.08)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]", className)}>
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground dark:text-[#9aa7bd]">No exception huddles recorded</p>
      </section>
    );
  }

  const timedOut = summary.byStatus.timed_out;
  const resolutionRate = `${Math.round(summary.resolutionRate * 100)}%`;
  const averageRounds = summary.averageRoundsOnDecided !== null ? summary.averageRoundsOnDecided.toFixed(1) : "—";

  return (
    <section aria-label="Exception huddle telemetry" className={cn("tactile-card rounded-[12px] border border-border/80 bg-card/90 px-3 py-2 text-card-foreground tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_10px_28px_rgba(15,23,42,0.08)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]", className)}>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Total huddles" value={summary.total} />
        <Kpi label="Open" value={summary.byStatus.open} />
        <Kpi label="Timed Out" value={timedOut} className={timedOut > 0 ? TIMED_OUT_ACTIVE : undefined} valueClassName={timedOut > 0 ? TIMED_OUT_VALUE_ACTIVE : undefined} />
        <Kpi label="Resolution Rate" value={resolutionRate} />
        <Kpi label="Avg Rounds" value={averageRounds} />
        <Kpi label="Chair Forced" value={summary.chairForcedDecisionCount} />
      </dl>
    </section>
  );
}
