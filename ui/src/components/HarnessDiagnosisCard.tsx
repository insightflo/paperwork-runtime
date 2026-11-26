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
  high: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:border-rose-400/35 dark:bg-rose-500/10 dark:text-rose-300",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]",
  low: "border-slate-200/80 bg-slate-100/80 text-slate-600 dark:border-white/[0.07] dark:bg-[#07090d] dark:text-[#8b97ad]",
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
    <li className="space-y-1 rounded-lg border border-slate-200/80 bg-slate-50/75 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
            SEVERITY_STYLE[item.severity],
          )}
        >
          {item.severity}
        </span>
        <span className="inline-flex items-center rounded-full border border-slate-200/80 bg-white px-2 py-0.5 text-[11px] font-mono text-muted-foreground dark:border-white/[0.07] dark:bg-[#0e131d]">
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
    <section aria-label="Harness diagnosis" className="space-y-3 tactile-card dark:bg-[#0e131d] dark:[background-image:none] p-4 tabular-nums">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-blue-600 dark:text-[#60a5fa]" />
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
                <p className="truncate text-sm font-semibold tabular-nums text-slate-950 dark:text-[#edf2fb]">{m.value}</p>
                <p className="text-[11px] text-muted-foreground">{m.label}</p>
              </div>
            ))}
          </div>

          {bottlenecks.length === 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-lime-600 dark:text-[#a3e635]" />
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
