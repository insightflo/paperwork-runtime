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
  if (pct >= 75) return "bg-[#d97706] shadow-[0_0_6px_rgba(217,119,6,0.35)] dark:bg-[#f59e0b] dark:shadow-[0_0_6px_rgba(245,158,11,0.5)]";
  return "bg-[#65a30d] shadow-[0_0_6px_rgba(101,163,13,0.32)] dark:bg-[#a3e635] dark:shadow-[0_0_6px_rgba(163,230,53,0.55)]";
}

function quotaDotColor(usedPct: number): string {
  if (usedPct >= 90) return "bg-rose-500";
  if (usedPct >= 70) return "bg-[#d97706] dark:bg-[#f59e0b]";
  return "bg-[#65a30d] dark:bg-[#a3e635]";
}

function quotaTextColor(usedPct: number | null): string {
  if (usedPct === null) return "text-muted-foreground";
  if (usedPct >= 90) return "text-rose-500 dark:text-rose-400";
  if (usedPct >= 70) return "text-[#b45309] dark:text-[#f59e0b]";
  return "text-[#4d7c0f] dark:text-[#a3e635]";
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
        "tactile-card border flex flex-col justify-between gap-3 rounded-[12px] border-slate-200/90 bg-white p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]",
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
            <span className="rounded border border-[#60a5fa]/35 bg-[#60a5fa]/10 px-1.5 py-0.5 font-mono text-[10px] text-[#2563eb] dark:text-[#60a5fa]">
              dgate live
            </span>
          )}
        </div>

        <div
          role="tablist"
          aria-label="텔레메트리 시간 범위"
          className="inline-flex items-center rounded-md border border-slate-200/90 bg-slate-100/90 p-0.5 dark:border-white/[0.08] dark:bg-[#07090d]"
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
                  "rounded px-2.5 py-1 text-[11px] font-medium transition-colors tabular-nums",
                  selected
                    ? "bg-white text-slate-950 shadow-sm ring-1 ring-[#a3e635]/60 dark:bg-[#141c2b] dark:text-[#a3e635] dark:ring-[#a3e635]/45"
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
        <div className="rounded-md border border-slate-200/80 bg-slate-50/75 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">CPU</span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {loading ? "—" : cpuPct !== null ? `${Math.round(cpuPct)}%` : "N/A"}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/[0.08]">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-300",
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
        <div className="rounded-md border border-slate-200/80 bg-slate-50/75 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">메모리</span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {loading ? "—" : memPct !== null ? `${Math.round(memPct)}%` : "N/A"}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/[0.08]">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-300",
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
        <div className="rounded-md border border-slate-200/80 bg-slate-50/75 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">활성 실행</span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {loading ? "—" : activeRuns}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/[0.08]">
            <div
              className="h-full rounded-full bg-[#2563eb] shadow-[0_0_6px_rgba(37,99,235,0.3)] transition-[width] duration-300 dark:bg-[#60a5fa] dark:shadow-[0_0_6px_rgba(96,165,250,0.5)]"
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
                className="h-[74px] animate-pulse rounded-md border border-slate-200/80 bg-slate-100/80 dark:border-white/[0.07] dark:bg-[#07090d]"
              />
            ))}
          </div>
        ) : quotaCards.length === 0 ? (
          <div className="flex items-center justify-between rounded-md border border-dashed border-slate-300/90 bg-slate-50/70 px-3 py-3 text-xs text-muted-foreground dark:border-white/[0.1] dark:bg-[#07090d]">
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
                  className="flex flex-col justify-between rounded-md border border-slate-200/80 bg-slate-50/75 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
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
                        "text-right font-bold leading-none tabular-nums",
                        pct === null ? "min-w-0 max-w-[68%] truncate text-[11px]" : "shrink-0 text-base", quotaTextColor(pct),
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
                              : "bg-slate-300/70 dark:bg-white/[0.08]",
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
