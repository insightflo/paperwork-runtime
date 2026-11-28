import { cn } from "@/lib/utils";

export type ResumeStrategy = "resume_session" | "fresh_with_carryover" | "escalate_operator";

export interface RunResumeStrategyBadgeProps {
  strategy: ResumeStrategy;
  attempt: number;
  maxAttempts?: number;
  reason?: string;
  className?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;

const STRATEGY_LABELS: Record<ResumeStrategy, string> = {
  resume_session: "세션 재개",
  fresh_with_carryover: "체크포인트 이어받기",
  escalate_operator: "운영자 확인 필요",
};

const STRATEGY_TONES: Record<ResumeStrategy, string> = {
  resume_session: "border-[var(--pw-cobalt)]/30 bg-[var(--pw-cobalt-soft)] text-[var(--pw-cobalt)]",
  fresh_with_carryover: "border-[var(--pw-lime)]/30 bg-[var(--pw-lime-soft)] text-[var(--pw-lime)]",
  escalate_operator: "border-[var(--pw-amber)]/30 bg-[var(--pw-amber-soft)] text-[var(--pw-amber)]",
};

export function formatResumeStrategyLabel(strategy: ResumeStrategy): string {
  return STRATEGY_LABELS[strategy];
}

export function RunResumeStrategyBadge({
  strategy,
  attempt,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  reason,
  className,
}: RunResumeStrategyBadgeProps) {
  const label = formatResumeStrategyLabel(strategy);
  const progress = `${attempt}/${maxAttempts}회`;
  const trimmedReason = reason?.trim();
  const ariaLabel = `재개 전략: ${label}, 시도 ${progress}${trimmedReason ? `, 사유: ${trimmedReason}` : ""}`;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap tabular-nums shadow-sm",
        STRATEGY_TONES[strategy],
        className,
      )}
    >
      <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-current" />
      <span className="font-semibold">{label}</span>
      <span aria-hidden="true" className="opacity-75">
        {progress}
      </span>
    </span>
  );
}
