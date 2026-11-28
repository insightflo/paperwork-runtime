import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export type FleetQueueHealthLevel = "healthy" | "degraded" | "critical";

export interface FleetQueueHealthPillProps {
  level: FleetQueueHealthLevel;
  headline: string;
  utilizationPercent: number;
  signals?: readonly string[];
  onClick?: () => void;
}

const LEVEL_LABELS: Record<FleetQueueHealthLevel, string> = {
  healthy: "큐 정상",
  degraded: "큐 혼잡",
  critical: "큐 경보",
};

const LEVEL_STYLES: Record<FleetQueueHealthLevel, CSSProperties> = {
  healthy: {
    borderColor: "var(--pw-emerald)",
    backgroundColor: "var(--pw-lime-soft)",
    color: "var(--pw-emerald)",
  },
  degraded: {
    borderColor: "var(--pw-amber)",
    backgroundColor: "var(--pw-amber-soft)",
    color: "var(--pw-amber)",
  },
  critical: {
    borderColor: "var(--pw-crimson)",
    backgroundColor: "var(--pw-crimson-soft)",
    color: "var(--pw-crimson)",
  },
};

const BASE_CLASS =
  "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-4 transition-colors";

export function formatQueueHealthLevelLabel(level: FleetQueueHealthLevel): string {
  return LEVEL_LABELS[level];
}

function clampUtilizationPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function buildAccessibilityLabel(
  headline: string,
  levelLabel: string,
  percent: number,
  signals: readonly string[] | undefined,
): string {
  const joinedSignals = signals?.join(", ") ?? "";
  return [headline, levelLabel, `이용률 ${percent}%`, joinedSignals].filter(Boolean).join(" · ");
}

export function FleetQueueHealthPill({
  level,
  headline,
  utilizationPercent,
  signals,
  onClick,
}: FleetQueueHealthPillProps) {
  const percent = clampUtilizationPercent(utilizationPercent);
  const levelLabel = formatQueueHealthLevelLabel(level);
  const accessibilityLabel = buildAccessibilityLabel(headline, levelLabel, percent, signals);
  const sharedProps = {
    "aria-label": accessibilityLabel,
    title: accessibilityLabel,
    "data-health-level": level,
    style: LEVEL_STYLES[level],
    className: cn(BASE_CLASS, onClick && "cursor-pointer"),
  };
  const content = (
    <>
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span>{levelLabel}</span>
      <span className="tabular-nums opacity-80">{percent}%</span>
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} {...sharedProps}>
        {content}
      </button>
    );
  }

  return (
    <span role="status" {...sharedProps}>
      {content}
    </span>
  );
}
