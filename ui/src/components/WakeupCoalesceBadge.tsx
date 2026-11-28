import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export type CoalesceLane = "interactive" | "recovery" | "workflow" | "scheduled";

export interface WakeupCoalesceBadgeProps {
  coalescedCount: number;
  lane: CoalesceLane;
  windowSec?: number;
  className?: string;
}

const LANE_LABELS: Record<CoalesceLane, string> = {
  interactive: "대화형",
  recovery: "복구",
  workflow: "워크플로",
  scheduled: "예약",
};

const LANE_STYLES: Record<CoalesceLane, CSSProperties> = {
  interactive: {
    borderColor: "var(--pw-token-border)",
    backgroundColor: "var(--pw-token-accent-soft)",
    color: "var(--pw-token-accent-text)",
  },
  recovery: {
    borderColor: "var(--pw-token-border)",
    backgroundColor: "var(--pw-token-danger-soft)",
    color: "var(--pw-token-danger-text)",
  },
  workflow: {
    borderColor: "var(--pw-token-border)",
    backgroundColor: "var(--pw-token-info-soft)",
    color: "var(--pw-token-info-text)",
  },
  scheduled: {
    borderColor: "var(--pw-token-border)",
    backgroundColor: "var(--pw-token-warning-soft)",
    color: "var(--pw-token-warning-text)",
  },
};

export function formatCoalesceSummary(coalescedCount: number): string {
  if (coalescedCount <= 1) return "";
  return `중복 요청 ${coalescedCount}건 병합`;
}

function formatWindowLabel(windowSec: number | undefined): string {
  if (typeof windowSec !== "number" || !Number.isFinite(windowSec) || windowSec <= 0) return "";
  return `${windowSec}초 창`;
}

export function WakeupCoalesceBadge({
  coalescedCount,
  lane,
  windowSec,
  className,
}: WakeupCoalesceBadgeProps) {
  const summary = formatCoalesceSummary(coalescedCount);
  if (!summary) return null;

  const laneLabel = LANE_LABELS[lane];
  const windowLabel = formatWindowLabel(windowSec);
  const ariaLabel = `${summary} · ${laneLabel} 우선순위 레인 유지${windowLabel ? ` · ${windowLabel}` : ""}`;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      title={ariaLabel}
      data-lane={lane}
      style={LANE_STYLES[lane]}
      className={cn(
        "inline-flex w-fit max-w-full shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-none whitespace-nowrap tabular-nums shadow-sm",
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current opacity-80" />
      <span>{summary}</span>
      <span aria-hidden="true" className="opacity-50">·</span>
      <span className="font-medium">{laneLabel}</span>
      {windowLabel ? <span className="font-normal opacity-75">{windowLabel}</span> : null}
    </span>
  );
}
