// ui/src/components/HarnessDiagnosisCard.tsx
//
// [파일 목적] 회사 하네스 텔레메트리 진단 요약 카드 (읽기 전용 — 뮤테이션·자동 적용 없음).
//   24h 지표 행 + 상위 병목(최대 5개, 심각도 배지/컴포넌트 pill/가설/권장 조치)을 렌더한다.
//   data/isLoading/error를 주입하면 쿼리 없이 순수 렌더(테스트용); 미주입 시 useQuery로 로드.
import { useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2 } from "lucide-react";
import {
  harnessRsiApi,
  type HarnessBottleneck,
  type HarnessDiagnosisResponse,
} from "../api/harnessRsi";
import { cn } from "../lib/utils";

export interface HarnessDiagnosisCardProps {
  companyId: string;
  windowHours?: number;
  data?: HarnessDiagnosisResponse;
  isLoading?: boolean;
  error?: Error | null;
}

const SEVERITY_STYLE: Record<HarnessBottleneck["severity"], string> = {
  high: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "border-border bg-muted/40 text-muted-foreground",
};

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const minutes = ms / 60_000;
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h`;
  if (minutes >= 1) return `${minutes.toFixed(1)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

function BottleneckRow({ item }: { item: HarnessBottleneck }) {
  return (
    <li className="space-y-1 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
            SEVERITY_STYLE[item.severity],
          )}
        >
          {item.severity}
        </span>
        <span className="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-mono text-muted-foreground">
          {item.component.replace(/_/g, " ")}
        </span>
        <span className="text-[11px] font-mono text-muted-foreground">{item.metric}</span>
      </div>
      <p className="text-xs text-foreground">{item.hypothesis}</p>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium">Action: </span>
        {item.recommendedAction}
      </p>
    </li>
  );
}

interface ViewProps {
  windowHours: number;
  data?: HarnessDiagnosisResponse;
  isLoading: boolean;
  error: Error | null;
}

function HarnessDiagnosisView({ windowHours, data, isLoading, error }: ViewProps) {
  const report = data?.report;
  const summary = report?.summary;
  const bottlenecks = report?.bottlenecks ?? [];
  const metrics = summary
    ? [
        { label: "Runs", value: String(summary.totalRuns) },
        { label: "Success", value: formatRate(summary.successRate) },
        { label: "Avg", value: formatDurationMs(summary.avgDurationMs) },
        { label: "P90", value: formatDurationMs(summary.p90DurationMs) },
        { label: "Slow", value: String(summary.slowRuns) },
        { label: "High-token", value: String(summary.highTokenRuns) },
        { label: "Lock t/o", value: String(summary.lockTimeouts) },
      ]
    : [];

  return (
    <section aria-label="Harness diagnosis" className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Harness Diagnosis
          </h3>
        </div>
        <span className="text-[11px] text-muted-foreground">last {windowHours}h · read-only</span>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading diagnosis…</p>
      ) : error ? (
        <p className="text-xs text-muted-foreground">
          Diagnosis unavailable{error.message ? `: ${error.message}` : "."}
        </p>
      ) : !summary ? (
        <p className="text-xs text-muted-foreground">No diagnosis data for this window.</p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
            {metrics.map((m) => (
              <div key={m.label} className="min-w-0">
                <p className="truncate text-sm font-semibold tabular-nums">{m.value}</p>
                <p className="text-[11px] text-muted-foreground">{m.label}</p>
              </div>
            ))}
          </div>

          {bottlenecks.length === 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              No bottlenecks detected in this window.
            </p>
          ) : (
            <ul className="space-y-2">
              {bottlenecks.slice(0, 5).map((item, i) => (
                <BottleneckRow key={`${item.component}:${item.metric}:${i}`} item={item} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function HarnessDiagnosisCardLive({ companyId, windowHours }: { companyId: string; windowHours: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["harness-rsi-diagnose", companyId, windowHours],
    queryFn: () => harnessRsiApi.diagnose(companyId, windowHours),
    enabled: !!companyId,
    retry: false,
    staleTime: 60_000,
  });
  return <HarnessDiagnosisView windowHours={windowHours} data={data} isLoading={isLoading} error={error} />;
}

export function HarnessDiagnosisCard({ companyId, windowHours = 24, data, isLoading, error }: HarnessDiagnosisCardProps) {
  if (data !== undefined || isLoading !== undefined || error !== undefined) {
    return (
      <HarnessDiagnosisView
        windowHours={windowHours}
        data={data}
        isLoading={isLoading ?? false}
        error={error ?? null}
      />
    );
  }
  return <HarnessDiagnosisCardLive companyId={companyId} windowHours={windowHours} />;
}
