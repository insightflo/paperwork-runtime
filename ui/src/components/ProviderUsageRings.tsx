import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { useAfterInitialPaint } from "../hooks/useAfterInitialPaint";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const RING = { size: 34, stroke: 2.25, spacing: 4.5 };

export interface QuotaRingEntry {
  provider: string;
  windows: QuotaWindow[];
  maxUsedPercent: number;
}

function numericUsedPercent(win: QuotaWindow): number | null {
  return typeof win.usedPercent === "number" && Number.isFinite(win.usedPercent)
    ? Math.max(0, Math.min(100, win.usedPercent))
    : null;
}

export function sortQuotaProvidersByDepletion(results: readonly ProviderQuotaResult[]): QuotaRingEntry[] {
  const entries: QuotaRingEntry[] = [];
  for (const item of results) {
    if (!item.ok || !Array.isArray(item.windows) || item.windows.length === 0) continue;
    const pcts = item.windows.map(numericUsedPercent).filter((v): v is number => v !== null);
    if (pcts.length === 0) continue;
    entries.push({
      provider: item.provider,
      windows: item.windows,
      maxUsedPercent: Math.max(...pcts),
    });
  }
  return entries.sort((a, b) => b.maxUsedPercent - a.maxUsedPercent || a.provider.localeCompare(b.provider));
}

function ringStrokeVar(usedPercent: number): string {
  if (usedPercent >= 95) return "var(--openbot-danger)";
  if (usedPercent >= 80) return "var(--openbot-warning)";
  return "var(--openbot-provider-current)";
}

function providerShortMark(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized.startsWith("antigravity")) return "AG";
  if (normalized.startsWith("claude") || normalized === "anthropic") return "CL";
  if (normalized.startsWith("codex") || normalized === "openai") return "CX";
  if (normalized.startsWith("pi")) return "PI";
  if (normalized.startsWith("hermes")) return "HM";
  return provider.slice(0, 2).toUpperCase();
}

export function ProviderUsageRingItem({ entry }: { entry: QuotaRingEntry }) {
  const displayWindows = useMemo(() => [...entry.windows].slice(0, 2), [entry.windows]);
  const outerRadius = (RING.size - RING.stroke) / 2;

  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <div
          data-provider={entry.provider}
          role="img"
          aria-label={`${entry.provider} quota ${Math.round(entry.maxUsedPercent)}% used`}
          className="relative flex h-[34px] w-[34px] items-center justify-center rounded-full"
          style={{ color: "var(--openbot-provider-current)" }}
        >
          <svg
            viewBox={`0 0 ${RING.size} ${RING.size}`}
            className="h-[34px] w-[34px] -rotate-90"
            fill="none"
            aria-hidden="true"
          >
            {displayWindows.map((win, index) => {
              const used = numericUsedPercent(win) ?? 0;
              const remaining = Math.max(0, Math.min(100, Math.round(100 - used)));
              const radius = outerRadius - index * RING.spacing;
              return (
                <g key={win.label}>
                  <circle
                    cx={RING.size / 2}
                    cy={RING.size / 2}
                    r={radius}
                    strokeWidth={RING.stroke}
                    style={{ stroke: "var(--openbot-border-strong)" }}
                  />
                  {remaining > 0 && (
                    <circle
                      cx={RING.size / 2}
                      cy={RING.size / 2}
                      r={radius}
                      strokeWidth={RING.stroke}
                      strokeLinecap="round"
                      pathLength={100}
                      strokeDasharray={`${remaining} 100`}
                      style={{ stroke: ringStrokeVar(used) }}
                    />
                  )}
                </g>
              );
            })}
          </svg>
          <span className="pointer-events-none absolute text-[9px] font-bold tracking-tight">
            {providerShortMark(entry.provider)}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="space-y-1 text-xs">
        <div className="font-semibold capitalize">{entry.provider.replace(/_/g, " ")}</div>
        {entry.windows.map((win) => {
          const used = numericUsedPercent(win);
          const left = used !== null ? Math.round(100 - used) : null;
          return (
            <div key={win.label} className="flex items-center justify-between gap-3 text-[11px]">
              <span className="text-muted-foreground">{win.label}</span>
              <span className="font-mono">
                {left !== null ? `${left}% left · 남음` : win.valueLabel ?? "n/a"}
              </span>
            </div>
          );
        })}
      </TooltipContent>
    </Tooltip>
  );
}

export function ProviderUsageRings({ companyId }: { companyId: string | null }) {
  const ready = useAfterInitialPaint(900);
  const { data } = useQuery({
    queryKey: companyId ? queryKeys.usageQuotaWindows(companyId) : ["usage-quota-windows", "none"],
    queryFn: () => costsApi.quotaWindows(companyId!),
    enabled: Boolean(companyId) && ready,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const sorted = useMemo(() => sortQuotaProvidersByDepletion(data ?? []), [data]);
  if (sorted.length === 0) return null;

  const visible = sorted.slice(0, 3);
  const overflowCount = sorted.length - visible.length;

  return (
    <div className="flex flex-col items-center gap-1.5 py-1.5 shrink-0" aria-label="Provider quota rings">
      {visible.map((entry) => (
        <ProviderUsageRingItem key={entry.provider} entry={entry} />
      ))}
      {overflowCount > 0 && (
        <span
          className="rounded-full px-1.5 py-0.5 font-mono text-[10px]"
          style={{
            backgroundColor: "var(--openbot-bg-surface)",
            color: "var(--openbot-text-muted)",
          }}
        >
          +{overflowCount}
        </span>
      )}
    </div>
  );
}
