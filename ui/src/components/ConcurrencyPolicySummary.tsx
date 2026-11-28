import { AlertTriangle } from "lucide-react";
import { cn } from "../lib/utils";

export interface ConcurrencyPolicyView {
  maxConcurrentRuns: number;
  reserveInteractiveHeadroom: boolean;
  coalesceWindowMs: number;
  starvationWarningMs: number;
  maxDelegationDepth: number;
  maxActiveChildren: number;
}

export interface ConcurrencyPolicySummaryProps {
  config: ConcurrencyPolicyView;
  warnings?: readonly string[];
  className?: string;
}

function policyItems(config: ConcurrencyPolicyView) {
  return [
    { label: "동시 슬롯", value: String(config.maxConcurrentRuns) },
    {
      label: "대화형 여유 슬롯",
      value: config.reserveInteractiveHeadroom ? "예약" : "미예약",
    },
    { label: "중복 병합", value: `${Math.round(config.coalesceWindowMs / 1000)}초` },
    { label: "장기 대기 경보", value: `${Math.round(config.starvationWarningMs / 60000)}분` },
    { label: "위임 깊이", value: String(config.maxDelegationDepth) },
    { label: "최대 자식", value: String(config.maxActiveChildren) },
  ];
}

export function ConcurrencyPolicySummary({
  config,
  warnings = [],
  className,
}: ConcurrencyPolicySummaryProps) {
  const items = policyItems(config);
  const hasWarnings = warnings.length > 0;

  return (
    <section
      role="region"
      aria-label="동시 실행 정책 요약"
      data-testid="concurrency-policy-summary"
      className={cn("tactile-card px-4 py-4 text-card-foreground", className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">실행 제어</p>
          <h3 className="mt-1 text-sm font-semibold text-card-foreground">동시 실행 정책</h3>
        </div>
        <span
          className={cn(
            "rounded-full border border-border px-2 py-0.5 text-xs font-medium tabular-nums",
            hasWarnings
              ? "bg-[var(--pw-amber-soft)] text-[var(--pw-amber)]"
              : "bg-muted/40 text-muted-foreground",
          )}
        >
          {hasWarnings ? `경고 ${warnings.length}` : "정상"}
        </span>
      </div>

      <dl className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <div key={item.label} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="mt-1 text-sm font-semibold tabular-nums text-card-foreground">{item.value}</dd>
          </div>
        ))}
      </dl>

      {hasWarnings ? (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-border bg-[var(--pw-amber-soft)] px-3 py-2 text-sm text-[var(--pw-amber)]"
        >
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            정책 검증 경고
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
