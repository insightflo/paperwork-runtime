import { useMemo, useState } from "react";
import type { DashboardTelemetryBucket, DashboardTelemetryWindow } from "@/api/dashboard";
import { cn, formatCents } from "@/lib/utils";

export interface TokenFlowChartProps {
  buckets: DashboardTelemetryBucket[];
  models: string[];
  avgTokensPerBucket: number;
  window: DashboardTelemetryWindow;
  loading?: boolean;
  className?: string;
}

const MODEL_PALETTE = [
  "var(--pw-amber)", // amber (#f59e0b in dark mode)
  "var(--pw-lime)", // neon lime (#a3e635 in dark mode)
  "var(--pw-cobalt)", // cobalt (#60a5fa in dark mode)
  "#a855f7", // violet
  "#f43f5e", // rose
  "#64748b", // slate
];

const SVG_W = 640;
const SVG_H = 216;
const PAD_TOP = 16;
const PAD_RIGHT = 14;
const PAD_BOTTOM = 26;
const PAD_LEFT = 46;
const PLOT_W = SVG_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = SVG_H - PAD_TOP - PAD_BOTTOM;

function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function formatBucketTime(iso: string, window: DashboardTelemetryWindow): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (window === "24h") {
    return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
}

function shortModelName(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1] || model;
}

export function TokenFlowChart({
  buckets,
  models,
  avgTokensPerBucket,
  window: activeWindow,
  loading = false,
  className,
}: TokenFlowChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const orderedModels = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const m of models) {
      if (m && !seen.has(m)) {
        seen.add(m);
        list.push(m);
      }
    }
    for (const b of buckets) {
      for (const m of Object.keys(b.byModel ?? {})) {
        if (m && !seen.has(m)) {
          seen.add(m);
          list.push(m);
        }
      }
    }
    return list;
  }, [models, buckets]);

  const modelColorMap = useMemo(() => {
    const map = new Map<string, string>();
    orderedModels.forEach((m, idx) => {
      map.set(m, MODEL_PALETTE[idx % MODEL_PALETTE.length]);
    });
    return map;
  }, [orderedModels]);

  const modelTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const b of buckets) {
      for (const [m, count] of Object.entries(b.byModel ?? {})) {
        totals.set(m, (totals.get(m) ?? 0) + (Number.isFinite(count) ? count : 0));
      }
    }
    return totals;
  }, [buckets]);

  const totalWindowTokens = useMemo(
    () => buckets.reduce((acc, b) => acc + Math.max(0, b.totalTokens || 0), 0),
    [buckets],
  );

  const maxBucketTokens = useMemo(() => {
    let maxVal = avgTokensPerBucket > 0 ? avgTokensPerBucket : 0;
    for (const b of buckets) {
      if (b.totalTokens > maxVal) maxVal = b.totalTokens;
    }
    return maxVal > 0 ? maxVal * 1.12 : 1;
  }, [buckets, avgTokensPerBucket]);

  if (loading) {
    return (
      <div
        className={cn(
          "tactile-card border flex flex-col justify-between rounded-[12px] border-slate-200/90 bg-white p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]",
          className,
        )}
        aria-busy="true"
        aria-label="토큰 흐름 차트 로딩 중"
      >
        <div className="flex items-center justify-between">
          <div className="h-3.5 w-24 animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-20 animate-pulse rounded bg-muted" />
        </div>
        <div className="my-4 flex h-44 items-end gap-1.5">
          {Array.from({ length: 18 }, (_, i) => (
            <div
              key={i}
              className="flex-1 animate-pulse rounded-t bg-muted/60"
              style={{ height: `${20 + ((i * 29) % 70)}%` }}
            />
          ))}
        </div>
        <div className="h-3 w-48 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const hasData = buckets.length > 0 && totalWindowTokens > 0;
  const slotW = buckets.length > 0 ? PLOT_W / buckets.length : PLOT_W;
  const barW = Math.max(3, Math.min(24, slotW * 0.68));
  const avgY =
    avgTokensPerBucket > 0
      ? PAD_TOP + PLOT_H - Math.min(1, avgTokensPerBucket / maxBucketTokens) * PLOT_H
      : null;

  const xTickStep = Math.max(1, Math.ceil(buckets.length / 5));
  const hoveredBucket = hoveredIdx !== null ? buckets[hoveredIdx] ?? null : null;
  const tooltipOnLeft = hoveredIdx !== null && buckets.length > 1 && hoveredIdx > buckets.length * 0.58;

  return (
    <div
      className={cn(
        "tactile-card border flex flex-col justify-between rounded-[12px] border-slate-200/90 bg-white p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]",
        className,
      )}
    >
      {/* Header */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-xs font-semibold tracking-tight text-foreground">토큰 흐름</h3>
          <span className="rounded border border-slate-200/90 bg-slate-100/80 px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums dark:border-white/[0.08] dark:bg-[#07090d] dark:text-[#8b97ad]">
            {formatCompactTokens(totalWindowTokens)} tok
          </span>
        </div>
        {avgTokensPerBucket > 0 && (
          <span className="inline-flex items-center gap-1 rounded border border-[#a3e635]/35 bg-[#a3e635]/12 px-1.5 py-0.5 text-[10px] font-medium text-[#4d7c0f] tabular-nums dark:text-[#a3e635]">
            평균 {formatCompactTokens(avgTokensPerBucket)}
          </span>
        )}
      </div>

      {/* Chart Area */}
      {!hasData ? (
        <div className="flex h-[216px] items-center justify-center rounded-md border border-dashed border-slate-300/90 bg-slate-50/70 text-xs text-muted-foreground dark:border-white/[0.1] dark:bg-[#07090d]">
          선택한 기간의 토큰 흐름 데이터가 없습니다.
        </div>
      ) : (
        <div
          className="relative w-full rounded-md border border-slate-200/75 bg-slate-50/55 px-1 dark:border-white/[0.06] dark:bg-[#07090d]/85"
          onMouseLeave={() => setHoveredIdx(null)}
        >
          <svg
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            className="h-[216px] w-full overflow-visible"
            role="img"
            aria-label={`토큰 흐름 스택 막대 차트, 총 ${formatCompactTokens(totalWindowTokens)} 토큰`}
          >
            {/* Horizontal Gridlines & Y-Axis Labels */}
            {[0, 0.5, 1].map((ratio) => {
              const y = PAD_TOP + PLOT_H * (1 - ratio);
              const val = maxBucketTokens * ratio;
              return (
                <g key={ratio}>
                  <line
                    x1={PAD_LEFT}
                    y1={y}
                    x2={SVG_W - PAD_RIGHT}
                    y2={y}
                    className="stroke-slate-200/90 dark:stroke-white/[0.08]"
                    strokeWidth={1}
                    strokeDasharray={ratio === 0 ? undefined : "2 3"}
                  />
                  <text
                    x={PAD_LEFT - 6}
                    y={y + 3}
                    textAnchor="end"
                    className="fill-muted-foreground text-[9px] tabular-nums"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatCompactTokens(val)}
                  </text>
                </g>
              );
            })}

            {/* Stacked Bars */}
            {buckets.map((bucket, idx) => {
              const xCenter = PAD_LEFT + idx * slotW + slotW / 2;
              const barX = xCenter - barW / 2;
              const isHovered = hoveredIdx === idx;

              // Build stacked model segments
              const entries = orderedModels
                .map((m) => ({ model: m, value: Math.max(0, bucket.byModel?.[m] ?? 0) }))
                .filter((e) => e.value > 0);

              // Fallback single bar if byModel wasn't populated but totalTokens > 0
              const stackEntries =
                entries.length > 0
                  ? entries
                  : bucket.totalTokens > 0
                    ? [{ model: "other", value: bucket.totalTokens }]
                    : [];

              let currentBottomY = PAD_TOP + PLOT_H;

              return (
                <g
                  key={bucket.bucketStart || idx}
                  onMouseEnter={() => setHoveredIdx(idx)}
                  className="cursor-pointer"
                >
                  {/* Hover column highlight */}
                  <rect
                    x={PAD_LEFT + idx * slotW}
                    y={PAD_TOP}
                    width={slotW}
                    height={PLOT_H}
                    className={cn(
                      "transition-colors",
                      isHovered ? "fill-[#2563eb]/[0.06] dark:fill-[#60a5fa]/[0.07]" : "fill-transparent",
                    )}
                  />

                  {stackEntries.map((seg, segIdx) => {
                    const segH = Math.max(1.5, (seg.value / maxBucketTokens) * PLOT_H);
                    const y = Math.max(PAD_TOP, currentBottomY - segH);
                    const actualH = Math.max(0, currentBottomY - y);
                    currentBottomY = y;
                    const color = modelColorMap.get(seg.model) ?? MODEL_PALETTE[MODEL_PALETTE.length - 1];
                    const isTop = segIdx === stackEntries.length - 1;
                    return (
                      <rect
                        key={seg.model}
                        x={barX}
                        y={y}
                        width={barW}
                        height={actualH}
                        rx={isTop ? 1.5 : 0}
                        fill={color}
                        opacity={hoveredIdx === null || isHovered ? 0.92 : 0.45}
                      />
                    );
                  })}

                  {/* X-axis tick label */}
                  {(idx % xTickStep === 0 || idx === buckets.length - 1) && (
                    <text
                      x={xCenter}
                      y={SVG_H - 6}
                      textAnchor={
                        idx === 0 ? "start" : idx === buckets.length - 1 ? "end" : "middle"
                      }
                      className="fill-muted-foreground text-[9px] tabular-nums"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {formatBucketTime(bucket.bucketStart, activeWindow)}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Dashed Average Reference Line */}
            {avgY !== null && (
              <g pointerEvents="none">
                <line
                  x1={PAD_LEFT}
                  y1={avgY}
                  x2={SVG_W - PAD_RIGHT}
                  y2={avgY}
                  stroke="var(--pw-lime)"
                  strokeWidth={1.25}
                  strokeDasharray="4 4"
                  opacity={0.85}
                />
                <rect
                  x={SVG_W - PAD_RIGHT - 42}
                  y={Math.max(PAD_TOP, avgY - 14)}
                  width={42}
                  height={13}
                  rx={3}
                  className="fill-white dark:fill-[#0e131d]"
                  stroke="var(--pw-lime)"
                  strokeOpacity={0.6}
                  strokeWidth={0.8}
                />
                <text
                  x={SVG_W - PAD_RIGHT - 21}
                  y={Math.max(PAD_TOP + 9.5, avgY - 4.5)}
                  textAnchor="middle"
                  fill="var(--pw-lime)"
                  className="text-[8.5px] font-semibold"
                >
                  평균
                </text>
              </g>
            )}
          </svg>

          {/* Interactive Hover Tooltip */}
          {hoveredBucket && (
            <div
              className={cn(
                "pointer-events-none absolute top-2 z-20 w-52 rounded-md border border-slate-200/90 bg-white/95 p-2.5 text-[11px] shadow-[0_10px_28px_rgba(15,23,42,0.14)] backdrop-blur-sm dark:border-white/[0.09] dark:bg-[#0e131d]/95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]",
                tooltipOnLeft ? "left-12" : "right-3",
              )}
            >
              <div className="flex items-center justify-between gap-2 border-b border-slate-200/80 pb-1 dark:border-white/[0.07]">
                <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                  {formatBucketTime(hoveredBucket.bucketStart, activeWindow)}
                </span>
                <span className="font-semibold text-foreground tabular-nums">
                  {formatCompactTokens(hoveredBucket.totalTokens)} tok
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
                <span>비용 {formatCents(hoveredBucket.costCents)}</span>
                <span>실행 {hoveredBucket.runs}건</span>
              </div>
              {Object.keys(hoveredBucket.byModel ?? {}).length > 0 && (
                <div className="mt-1.5 space-y-1 border-t border-slate-200/75 pt-1.5 dark:border-white/[0.07]">
                  {Object.entries(hoveredBucket.byModel)
                    .filter(([, v]) => v > 0)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([model, count]) => (
                      <div key={model} className="flex items-center justify-between gap-2 text-[10px]">
                        <span className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">
                          <span
                            className="h-2 w-2 shrink-0 rounded-[2px]"
                            style={{
                              backgroundColor:
                                modelColorMap.get(model) ?? MODEL_PALETTE[MODEL_PALETTE.length - 1],
                            }}
                          />
                          <span className="truncate">{shortModelName(model)}</span>
                        </span>
                        <span className="shrink-0 font-mono text-foreground tabular-nums">
                          {formatCompactTokens(count)}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Bottom Model Legend */}
      {orderedModels.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-200/80 pt-2 dark:border-white/[0.07]">
          {orderedModels.slice(0, 6).map((model) => (
            <span
              key={model}
              className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"
              title={model}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: modelColorMap.get(model) }}
              />
              <span className="max-w-[9rem] truncate font-medium text-foreground/90">
                {shortModelName(model)}
              </span>
              <span className="font-mono text-[9.5px] tabular-nums">
                {formatCompactTokens(modelTotals.get(model) ?? 0)}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
