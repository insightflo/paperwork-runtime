import { useMemo } from "react";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import type {
  DashboardTelemetryHost,
  DashboardTelemetryWindow,
  DgateDashboardBridgeResponse,
} from "@/api/dashboard";
import { cn, providerDisplayName } from "@/lib/utils";

export interface HealthAndQuotaPanelProps {
  window: DashboardTelemetryWindow;
  onWindowChange: (window: DashboardTelemetryWindow) => void;
  host?: DashboardTelemetryHost | null;
  dgate?: DgateDashboardBridgeResponse | null;
  quotas?: ProviderQuotaResult[];
  loading?: boolean;
  quotasLoading?: boolean;
  className?: string;
}

const WINDOW_OPTIONS: { value: DashboardTelemetryWindow; label: string }[] = [
  { value: "10m", label: "10분" },
  { value: "1h", label: "1시간" },
  { value: "6h", label: "6시간" },
  { value: "24h", label: "1일" },
];

const DOT_SEGMENTS = 20;

interface QuotaCardEntry {
  key: string;
  provider: string;
  providerLabel: string;
  windowLabel: string;
  usedPercent: number | null;
  valueLabel: string | null;
  resetsAt: string | null;
}

function clampPct(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function formatResetCountdown(resetsAt: string | null): string {
  if (!resetsAt) return "초기화 미정";
  const target = new Date(resetsAt).getTime();
  if (!Number.isFinite(target)) return "초기화 미정";
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "곧 초기화";
  const totalMin = Math.floor(diffMs / 60_000);
  if (totalMin < 60) return `${totalMin}분 후`;
  const hours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (hours < 24) return remMin > 0 ? `${hours}시간 ${remMin}분 후` : `${hours}시간 후`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}일 ${remHours}시간 후` : `${days}일 후`;
}

function resourceBarColor(pct: number): string {
  if (pct >= 90) return "bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.55)]";
  if (pct >= 75) return "bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)]";
  return "bg-[#84cc16] shadow-[0_0_6px_rgba(132,204,22,0.55)]";
}

function quotaDotColor(usedPct: number): string {
  if (usedPct >= 90) return "bg-rose-500";
  if (usedPct >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

function quotaTextColor(usedPct: number | null): string {
  if (usedPct === null) return "text-muted-foreground";
  if (usedPct >= 90) return "text-rose-500 dark:text-rose-400";
  if (usedPct >= 70) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

function flattenQuotaCards(results: readonly ProviderQuotaResult[] | undefined): QuotaCardEntry[] {
  if (!Array.isArray(results)) return [];
  const entries: QuotaCardEntry[] = [];
  for (const item of results) {
    if (!item.ok || !Array.isArray(item.windows) || item.windows.length === 0) continue;
    const providerLabel = providerDisplayName(item.provider);
    for (const win of item.windows as QuotaWindow[]) {
      const pct = clampPct(win.usedPercent);
      if (pct === null && !win.valueLabel) continue;
      entries.push({
        key: `${item.provider}:${win.label}`,
        provider: item.provider,
        providerLabel,
        windowLabel: win.label,
        usedPercent: pct,
        valueLabel: win.valueLabel,
        resetsAt: win.resetsAt,
      });
    }
  }
  return entries.sort((a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1));
}

export function HealthAndQuotaPanel({
  window: activeWindow,
  onWindowChange,
  host,
  dgate,
  quotas,
  loading = false,
  quotasLoading = false,
  className,
}: HealthAndQuotaPanelProps) {
  const sys = dgate?.available ? dgate.snapshot?.system ?? null : null;

  const cpuPct = clampPct(sys?.cpu_pct ?? host?.cpuPct ?? null);
  const memPct = clampPct(sys?.mem_pct ?? host?.memPct ?? null);
  const memUsedGb =
    typeof sys?.mem_used_gb === "number" && Number.isFinite(sys.mem_used_gb)
      ? sys.mem_used_gb
      : typeof host?.memUsedGb === "number" && Number.isFinite(host.memUsedGb)
        ? host.memUsedGb
        : null;
  const memTotalGb =
    typeof sys?.mem_total_gb === "number" && Number.isFinite(sys.mem_total_gb)
      ? sys.mem_total_gb
      : typeof host?.memTotalGb === "number" && Number.isFinite(host.memTotalGb)
        ? host.memTotalGb
        : null;

  const activeRuns =
    typeof host?.activeRuns === "number" && Number.isFinite(host.activeRuns)
      ? host.activeRuns
      : dgate?.available && dgate.snapshot
        ? dgate.snapshot.open_forks
        : 0;
  const activeRunsPct = Math.min(100, activeRuns > 0 ? Math.max(12, Math.round((activeRuns / 12) * 100)) : 0);

  const quotaCards = useMemo(() => flattenQuotaCards(quotas), [quotas]);

  return (
    <div
      className={cn(
        "flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-4 dark:border-[#242d3f] dark:bg-[#0f1117]",
        className,
      )}
    >
      {/* Top Strip: Interactive Time Window Scrubber */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold tracking-tight text-foreground">
            시스템 · 프로바이더 쿼터
          </h3>
          {dgate?.available && (
            <span className="rounded border border-[#5f8dff]/35 bg-[#5f8dff]/10 px-1.5 py-0.5 font-mono text-[10px] text-[#3b82f6] dark:text-[#5f8dff]">
              dgate live
            </span>
          )}
        </div>

        <div
          role="tablist"
          aria-label="텔레메트리 시간 범위"
          className="inline-flex items-center rounded-md border border-border bg-muted/60 p-0.5 dark:border-[#242d3f] dark:bg-[#090c11]"
        >
          {WINDOW_OPTIONS.map((opt) => {
            const selected = opt.value === activeWindow;
            return (
              <button
                key={opt.value}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onWindowChange(opt.value)}
                className={cn(
                  "rounded px-2.5 py-1 text-[11px] font-medium transition-all tabular-nums",
                  selected
                    ? "bg-background text-foreground shadow-sm ring-1 ring-[#84cc16]/45 dark:bg-[#171f2e] dark:text-[#a3e635]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Middle Strip: 3 Compact Resource Cards */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {/* CPU Card */}
        <div className="rounded-md border border-border/80 bg-muted/25 px-3 py-2.5 dark:border-[#242d3f] dark:bg-[#131823]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">CPU</span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {loading ? "—" : cpuPct !== null ? `${Math.round(cpuPct)}%` : "N/A"}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted dark:bg-slate-800/90">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300",
                cpuPct !== null ? resourceBarColor(cpuPct) : "bg-muted-foreground/30",
              )}
              style={{ width: `${cpuPct ?? 0}%` }}
            />
          </div>
          <p className="mt-1.5 truncate text-[10px] text-muted-foreground tabular-nums">
            {sys?.load_1m != null
              ? `Load ${Number(sys.load_1m).toFixed(2)}`
              : host?.loadAvg1m != null
                ? `Load ${host.loadAvg1m.toFixed(2)}`
                : "호스트 프로세서"}
          </p>
        </div>

        {/* Memory Card */}
        <div className="rounded-md border border-border/80 bg-muted/25 px-3 py-2.5 dark:border-[#242d3f] dark:bg-[#131823]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">메모리</span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {loading ? "—" : memPct !== null ? `${Math.round(memPct)}%` : "N/A"}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted dark:bg-slate-800/90">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300",
                memPct !== null ? resourceBarColor(memPct) : "bg-muted-foreground/30",
              )}
              style={{ width: `${memPct ?? 0}%` }}
            />
          </div>
          <p className="mt-1.5 truncate text-[10px] text-muted-foreground tabular-nums">
            {memUsedGb !== null && memTotalGb !== null
              ? `${memUsedGb.toFixed(1)} / ${memTotalGb.toFixed(1)} GB`
              : "시스템 메모리"}
          </p>
        </div>

        {/* Active Runs Card */}
        <div className="rounded-md border border-border/80 bg-muted/25 px-3 py-2.5 dark:border-[#242d3f] dark:bg-[#131823]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">활성 실행</span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {loading ? "—" : activeRuns}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted dark:bg-slate-800/90">
            <div
              className="h-full rounded-full bg-[#22c55e] shadow-[0_0_6px_rgba(34,197,94,0.55)] transition-all duration-300"
              style={{ width: `${activeRunsPct}%` }}
            />
          </div>
          <p className="mt-1.5 truncate text-[10px] text-muted-foreground tabular-nums">
            {host?.activeAgents != null
              ? `활성 에이전트 ${host.activeAgents}`
              : dgate?.available && dgate.snapshot
                ? `열린 포크 ${dgate.snapshot.open_forks}`
                : "실시간 실행 세션"}
          </p>
        </div>
      </div>

      {/* Bottom Strip: Provider Quota Dot-Bar Cards */}
      <div>
        {quotasLoading ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((idx) => (
              <div
                key={idx}
                className="h-[74px] animate-pulse rounded-md border border-border/70 bg-muted/30 dark:border-[#242d3f] dark:bg-[#131823]"
              />
            ))}
          </div>
        ) : quotaCards.length === 0 ? (
          <div className="flex items-center justify-between rounded-md border border-dashed border-border/80 bg-muted/15 px-3 py-3 text-xs text-muted-foreground dark:border-[#242d3f] dark:bg-[#111520]">
            <span>연결된 프로바이더 쿼터 창이 없습니다.</span>
            <span className="font-mono text-[10px] text-muted-foreground/70">quota-windows</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {quotaCards.slice(0, 6).map((card) => {
              const pct = card.usedPercent;
              const filledDots = pct !== null ? Math.round((pct / 100) * DOT_SEGMENTS) : 0;
              return (
                <div
                  key={card.key}
                  className="flex flex-col justify-between rounded-md border border-border/80 bg-muted/20 px-3 py-2 dark:border-[#242d3f] dark:bg-[#131823]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-semibold text-foreground">
                        {card.providerLabel}
                      </p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {card.windowLabel} · {formatResetCountdown(card.resetsAt)}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 text-base font-bold leading-none tabular-nums",
                        quotaTextColor(pct),
                      )}
                    >
                      {pct !== null ? `${Math.round(pct)}%` : card.valueLabel ?? "—"}
                    </span>
                  </div>

                  {/* 20-segment 1top-style horizontal dot/block bar */}
                  <div
                    className="mt-2.5 flex items-center gap-[2px]"
                    role="progressbar"
                    aria-valuenow={pct !== null ? Math.round(pct) : undefined}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${card.providerLabel} ${card.windowLabel} 사용률`}
                  >
                    {Array.from({ length: DOT_SEGMENTS }, (_, idx) => {
                      const isFilled = idx < filledDots;
                      return (
                        <span
                          key={idx}
                          className={cn(
                            "h-2 flex-1 rounded-[2px] transition-colors",
                            isFilled && pct !== null
                              ? quotaDotColor(pct)
                              : "bg-muted-foreground/15 dark:bg-slate-800/90",
                          )}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
