import { cn } from "../lib/utils";

export type FallbackSkipReason = "auth_fatal" | "circuit_open" | "cooling_down";

export interface FallbackRouteIndicatorProps {
  usedFallback: boolean;
  selectedAdapter: string;
  selectedModel: string;
  skippedCount?: number;
  primarySkipReason?: FallbackSkipReason | null;
  className?: string;
}

const SKIP_REASON_LABELS: Record<FallbackSkipReason, string> = {
  auth_fatal: "인증 오류",
  circuit_open: "서킷 차단",
  cooling_down: "쿨다운 대기",
};

export function formatFallbackSkipReason(reason: FallbackSkipReason): string {
  return SKIP_REASON_LABELS[reason];
}

const PILL_CLASS =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border border-chart-3/30 bg-chart-3/10 px-2 py-0.5 text-[11px] font-semibold leading-4 text-chart-3 shadow-sm";
const DOT_CLASS = "h-1.5 w-1.5 shrink-0 rounded-full bg-chart-3";
const META_CLASS = "shrink-0 font-medium text-chart-3/80";

export function FallbackRouteIndicator({
  usedFallback,
  selectedAdapter,
  selectedModel,
  skippedCount = 0,
  primarySkipReason = null,
  className,
}: FallbackRouteIndicatorProps) {
  if (!usedFallback) return null;

  const reasonLabel = primarySkipReason ? formatFallbackSkipReason(primarySkipReason) : null;
  const normalizedSkippedCount = skippedCount > 0 ? Math.floor(skippedCount) : 0;
  const skippedLabel = normalizedSkippedCount > 0 ? `기본 어댑터 ${normalizedSkippedCount}개 건너뜀` : null;
  const stateSummary = [reasonLabel, skippedLabel].filter(Boolean).join(", ");
  const ariaLabel = `폴백 라우팅: ${selectedAdapter} / ${selectedModel}${stateSummary ? `, ${stateSummary}` : ""}`;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      title={ariaLabel}
      data-fallback-adapter={selectedAdapter}
      data-fallback-model={selectedModel}
      className={cn(PILL_CLASS, className)}
    >
      <span aria-hidden className={DOT_CLASS} />
      <span className="min-w-0 truncate">폴백 전환 · {selectedModel}</span>
      {reasonLabel ? <span className={META_CLASS}>({reasonLabel})</span> : null}
      {normalizedSkippedCount > 0 ? <span className={META_CLASS}>+{normalizedSkippedCount} 생략</span> : null}
    </span>
  );
}
