import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export type ModelCostTier = "economy" | "balanced" | "frontier";

export interface ModelCostTierBadgeProps {
  tier: ModelCostTier;
  selectedModel: string;
  downgradedForBudget?: boolean;
  className?: string;
}

const TIER_LABELS: Record<ModelCostTier, string> = {
  economy: "절약형",
  balanced: "균형형",
  frontier: "고성능",
};

const TIER_STYLES: Record<ModelCostTier, CSSProperties> = {
  economy: {
    borderColor: "var(--pw-token-success)",
    backgroundColor: "var(--pw-token-success-soft)",
    color: "var(--pw-token-success-text)",
  },
  balanced: {
    borderColor: "var(--pw-token-info-text)",
    backgroundColor: "var(--pw-token-info-soft)",
    color: "var(--pw-token-info-text)",
  },
  frontier: {
    borderColor: "var(--pw-token-accent)",
    backgroundColor: "var(--pw-token-accent-soft)",
    color: "var(--pw-token-accent-text)",
  },
};

const BUDGET_TAG_STYLE: CSSProperties = {
  borderColor: "var(--pw-token-warning)",
  backgroundColor: "var(--pw-token-warning-soft)",
  color: "var(--pw-token-warning-text)",
};

export function formatModelCostTierLabel(tier: ModelCostTier): string {
  return TIER_LABELS[tier];
}

export function ModelCostTierBadge({
  tier,
  selectedModel,
  downgradedForBudget = false,
  className,
}: ModelCostTierBadgeProps) {
  const tierLabel = formatModelCostTierLabel(tier);
  const ariaParts = [`모델 비용 등급 ${tierLabel}`, `선택 모델 ${selectedModel}`];

  if (downgradedForBudget) {
    ariaParts.push("예산 보호 전환");
  }

  return (
    <span
      role="status"
      aria-label={ariaParts.join(", ")}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap shadow-sm",
        className,
      )}
      style={TIER_STYLES[tier]}
    >
      <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-current opacity-80" />
      <span>{tierLabel}</span>
      <span aria-hidden="true" className="opacity-50">
        ·
      </span>
      <span className="max-w-48 truncate font-medium" title={selectedModel}>
        {selectedModel}
      </span>
      {downgradedForBudget ? (
        <span
          className="inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-bold leading-4"
          style={BUDGET_TAG_STYLE}
        >
          예산 전환
        </span>
      ) : null}
    </span>
  );
}
