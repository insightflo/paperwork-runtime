import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type RunStallVerdict = "active" | "slow_tool_grace" | "stalled";

export interface RunStallStatusBadgeProps {
  verdict: RunStallVerdict;
  idleMs: number;
  className?: string;
}

const VERDICT_CLASS: Record<RunStallVerdict, string> = {
  active: "border-border bg-[var(--pw-token-success-soft)] text-[var(--pw-token-success-text)]",
  slow_tool_grace: "border-border bg-[var(--pw-token-warning-soft)] text-[var(--pw-token-warning-text)]",
  stalled: "border-border bg-[var(--pw-token-danger-soft)] text-[var(--pw-token-danger-text)]",
};

export function formatStallVerdictLabel(verdict: RunStallVerdict): string {
  switch (verdict) {
    case "active":
      return "정상 실행";
    case "slow_tool_grace":
      return "도구 대기 중";
    case "stalled":
      return "응답 지연";
  }
}

export function formatIdleDuration(idleMs: number): string {
  const safeMs = Number.isFinite(idleMs) ? Math.max(0, idleMs) : 0;
  const minutes = Math.floor(safeMs / 60_000);
  return minutes < 1 ? "<1분" : `${minutes}분`;
}

export function RunStallStatusBadge({
  verdict,
  idleMs,
  className,
}: RunStallStatusBadgeProps) {
  const verdictLabel = formatStallVerdictLabel(verdict);
  const idleDuration = formatIdleDuration(idleMs);

  return (
    <Badge
      variant="outline"
      role="status"
      aria-label={`실행 상태: ${verdictLabel}; 출력 없는 시간 ${idleDuration}`}
      data-verdict={verdict}
      className={cn(
        "gap-1.5 px-2.5 py-1 font-mono text-[11px] font-semibold normal-case tracking-wide tabular-nums",
        VERDICT_CLASS[verdict],
        className,
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span>{verdictLabel}</span>
      <span className="opacity-80">{idleDuration}</span>
    </Badge>
  );
}
