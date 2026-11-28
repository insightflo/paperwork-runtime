import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export type FleetFairnessRating = "balanced" | "skewed" | "monopolized";

export interface FleetFairnessBadgeProps {
  jainIndex: number;
  rating: FleetFairnessRating;
  starvedCount?: number;
  className?: string;
}

const RATING_LABELS: Record<FleetFairnessRating, string> = {
  balanced: "분배 균형",
  skewed: "분배 편중",
  monopolized: "슬롯 독점",
};

const RATING_STYLES: Record<FleetFairnessRating, CSSProperties> = {
  balanced: {
    backgroundColor: "var(--pw-token-success-soft)",
    borderColor: "var(--pw-token-success)",
    color: "var(--pw-token-success-text)",
  },
  skewed: {
    backgroundColor: "var(--pw-token-warning-soft)",
    borderColor: "var(--pw-token-warning)",
    color: "var(--pw-token-warning-text)",
  },
  monopolized: {
    backgroundColor: "var(--pw-token-danger-soft)",
    borderColor: "var(--pw-token-danger)",
    color: "var(--pw-token-danger-text)",
  },
};

export function formatFairnessRatingLabel(rating: FleetFairnessRating): string {
  return RATING_LABELS[rating];
}

function clampUnitInterval(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function FleetFairnessBadge({
  jainIndex,
  rating,
  starvedCount,
  className,
}: FleetFairnessBadgeProps) {
  const label = formatFairnessRatingLabel(rating);
  const percent = Math.round(clampUnitInterval(jainIndex) * 100);
  const hasStarvedAgents = starvedCount !== undefined && starvedCount > 0;
  const starvedSuffix = hasStarvedAgents ? ` · 기아 ${starvedCount}명` : "";
  const visibleText = `${label} ${percent}%${starvedSuffix}`;
  const ariaLabel = `슬롯 분배 공정성: ${label}, Jain 지수 ${percent}%${
    hasStarvedAgents ? `, 기아 에이전트 ${starvedCount}명` : ""
  }`;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex w-fit items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-4 shadow-sm tabular-nums",
        className,
      )}
      style={RATING_STYLES[rating]}
    >
      {visibleText}
    </span>
  );
}
