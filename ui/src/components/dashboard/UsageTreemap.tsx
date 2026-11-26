import { useMemo, useState } from "react";
import type { DashboardUsageShare } from "@/api/dashboard";
import { cn, formatCents } from "@/lib/utils";

export interface UsageTreemapProps {
  projectShares: DashboardUsageShare[];
  agentShares: DashboardUsageShare[];
  loading?: boolean;
  className?: string;
}

type TreemapMode = "project" | "agent";

interface TreemapRect {
  item: DashboardUsageShare;
  x: number;
  y: number;
  w: number;
  h: number;
  colorIdx: number;
}

const TILE_STYLES = [
  { bg: "bg-[#3b82f6]/15 dark:bg-[#3b82f6]/18", border: "border-[#3b82f6]/45", accent: "text-[#2563eb] dark:text-[#60a5fa]" },
  { bg: "bg-[#10b981]/15 dark:bg-[#10b981]/18", border: "border-[#10b981]/45", accent: "text-[#059669] dark:text-[#34d399]" },
  { bg: "bg-[#f59e0b]/15 dark:bg-[#f59e0b]/18", border: "border-[#f59e0b]/45", accent: "text-[#d97706] dark:text-[#fbbf24]" },
  { bg: "bg-[#a855f7]/15 dark:bg-[#a855f7]/18", border: "border-[#a855f7]/45", accent: "text-[#9333ea] dark:text-[#c084fc]" },
  { bg: "bg-[#84cc16]/15 dark:bg-[#84cc16]/18", border: "border-[#84cc16]/45", accent: "text-[#65a30d] dark:text-[#a3e635]" },
  { bg: "bg-[#f43f5e]/15 dark:bg-[#f43f5e]/18", border: "border-[#f43f5e]/45", accent: "text-[#e11d48] dark:text-[#fb7185]" },
  { bg: "bg-[#06b6d4]/15 dark:bg-[#06b6d4]/18", border: "border-[#06b6d4]/45", accent: "text-[#0891b2] dark:text-[#22d3ee]" },
  { bg: "bg-slate-500/15 dark:bg-slate-500/20", border: "border-slate-500/40", accent: "text-slate-600 dark:text-slate-300" },
];

function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

/**
 * Simple proportional squarified/row-packed treemap layout in percentage space (0..100).
 * Splits along the longer axis to preserve readable aspect ratios.
 */
function layoutTreemap(
  items: DashboardUsageShare[],
  x = 0,
  y = 0,
  w = 100,
  h = 100,
  offsetIdx = 0,
): TreemapRect[] {
  if (items.length === 0 || w <= 0 || h <= 0) return [];
  if (items.length === 1) {
    return [{ item: items[0], x, y, w, h, colorIdx: offsetIdx }];
  }

  const total = items.reduce((acc, it) => acc + Math.max(0, it.tokens), 0);
  if (total <= 0) return [];

  // Partition into two balanced halves by cumulative weight (binary space partition)
  let accum = 0;
  let splitIdx = 1;
  const half = total / 2;
  for (let i = 0; i < items.length - 1; i++) {
    accum += Math.max(0, items[i].tokens);
    splitIdx = i + 1;
    if (accum >= half) break;
  }

  const first = items.slice(0, splitIdx);
  const second = items.slice(splitIdx);
  const firstSum = first.reduce((acc, it) => acc + Math.max(0, it.tokens), 0);
  const ratio = Math.max(0.08, Math.min(0.92, firstSum / total));

  if (w >= h) {
    const w1 = w * ratio;
    return [
      ...layoutTreemap(first, x, y, w1, h, offsetIdx),
      ...layoutTreemap(second, x + w1, y, w - w1, h, offsetIdx + first.length),
    ];
  } else {
    const h1 = h * ratio;
    return [
      ...layoutTreemap(first, x, y, w, h1, offsetIdx),
      ...layoutTreemap(second, x, y + h1, w, h - h1, offsetIdx + first.length),
    ];
  }
}

export function UsageTreemap({
  projectShares,
  agentShares,
  loading = false,
  className,
}: UsageTreemapProps) {
  const [mode, setMode] = useState<TreemapMode>("project");
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const activeItems = useMemo(() => {
    const raw = mode === "project" ? projectShares : agentShares;
    return [...raw]
      .filter((item) => item.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 12);
  }, [mode, projectShares, agentShares]);

  const totalTokens = useMemo(
    () => activeItems.reduce((acc, item) => acc + item.tokens, 0),
    [activeItems],
  );

  const rects = useMemo(() => layoutTreemap(activeItems), [activeItems]);

  const hoveredRect = useMemo(
    () => rects.find((r) => `${r.item.id ?? r.item.name}:${r.colorIdx}` === hoveredKey) ?? null,
    [rects, hoveredKey],
  );

  if (loading) {
    return (
      <div
        className={cn(
          "flex flex-col justify-between rounded-lg border border-border bg-card p-4 dark:border-[#242d3f] dark:bg-[#0f1117]",
          className,
        )}
        aria-busy="true"
        aria-label="사용량 맵 로딩 중"
      >
        <div className="flex items-center justify-between">
          <div className="h-3.5 w-24 animate-pulse rounded bg-muted" />
          <div className="h-6 w-28 animate-pulse rounded bg-muted" />
        </div>
        <div className="mt-3 grid h-[216px] grid-cols-3 grid-rows-2 gap-1.5">
          <div className="col-span-2 row-span-2 animate-pulse rounded bg-muted/60" />
          <div className="animate-pulse rounded bg-muted/50" />
          <div className="animate-pulse rounded bg-muted/40" />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col justify-between rounded-lg border border-border bg-card p-4 dark:border-[#242d3f] dark:bg-[#0f1117]",
        className,
      )}
    >
      {/* Header with Project / Agent Toggle */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-xs font-semibold tracking-tight text-foreground">사용량 맵</h3>
          <span className="rounded border border-border/80 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums dark:border-[#242d3f] dark:bg-[#151b28]">
            {formatCompactTokens(totalTokens)} tok
          </span>
        </div>

        <div
          role="tablist"
          aria-label="사용량 맵 기준"
          className="inline-flex items-center rounded-md border border-border bg-muted/60 p-0.5 dark:border-[#242d3f] dark:bg-[#090c11]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "project"}
            onClick={() => setMode("project")}
            className={cn(
              "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
              mode === "project"
                ? "bg-background text-foreground shadow-sm ring-1 ring-[#5f8dff]/40 dark:bg-[#171f2e] dark:text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            프로젝트
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "agent"}
            onClick={() => setMode("agent")}
            className={cn(
              "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
              mode === "agent"
                ? "bg-background text-foreground shadow-sm ring-1 ring-[#5f8dff]/40 dark:bg-[#171f2e] dark:text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            에이전트
          </button>
        </div>
      </div>

      {/* Treemap Canvas */}
      {rects.length === 0 ? (
        <div className="flex h-[216px] items-center justify-center rounded-md border border-dashed border-border/80 bg-muted/15 text-xs text-muted-foreground dark:border-[#242d3f] dark:bg-[#111520]">
          선택한 기간의 사용량 데이터가 없습니다.
        </div>
      ) : (
        <div
          className="relative h-[216px] w-full overflow-hidden rounded-md"
          onMouseLeave={() => setHoveredKey(null)}
        >
          {rects.map((rect) => {
            const tileKey = `${rect.item.id ?? rect.item.name}:${rect.colorIdx}`;
            const style = TILE_STYLES[rect.colorIdx % TILE_STYLES.length];
            const isLarge = rect.w >= 22 && rect.h >= 24;
            const isMedium = rect.w >= 12 && rect.h >= 14;
            const pctLabel = `${Math.round(rect.item.sharePct)}%`;
            const titleText = `${rect.item.name} · ${formatCompactTokens(rect.item.tokens)} tok (${rect.item.sharePct.toFixed(1)}%) · ${formatCents(rect.item.costCents)} · ${rect.item.runs}건`;

            return (
              <div
                key={tileKey}
                title={titleText}
                onMouseEnter={() => setHoveredKey(tileKey)}
                style={{
                  left: `${rect.x}%`,
                  top: `${rect.y}%`,
                  width: `${rect.w}%`,
                  height: `${rect.h}%`,
                }}
                className="absolute p-[2px]"
              >
                <div
                  className={cn(
                    "flex h-full w-full flex-col justify-between overflow-hidden rounded border p-2 transition-all",
                    style.bg,
                    style.border,
                    hoveredKey === tileKey && "ring-1 ring-foreground/40 brightness-110",
                  )}
                >
                  {isLarge ? (
                    <>
                      <div className="flex items-start justify-between gap-1">
                        <span className="truncate text-[11px] font-semibold text-foreground">
                          {rect.item.name}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 font-mono text-[10px] font-semibold tabular-nums",
                            style.accent,
                          )}
                        >
                          {pctLabel}
                        </span>
                      </div>
                      <div className="mt-auto">
                        <p className="truncate font-mono text-xs font-bold text-foreground tabular-nums">
                          {formatCompactTokens(rect.item.tokens)}
                        </p>
                        <p className="truncate text-[10px] text-muted-foreground tabular-nums">
                          {formatCents(rect.item.costCents)} · {rect.item.runs}건
                        </p>
                      </div>
                    </>
                  ) : isMedium ? (
                    <div className="flex h-full flex-col justify-between">
                      <span className="truncate text-[10px] font-semibold text-foreground">
                        {rect.item.name}
                      </span>
                      <span
                        className={cn(
                          "font-mono text-[10px] font-semibold tabular-nums",
                          style.accent,
                        )}
                      >
                        {pctLabel}
                      </span>
                    </div>
                  ) : (
                    <span
                      className={cn(
                        "truncate font-mono text-[9px] font-semibold tabular-nums",
                        style.accent,
                      )}
                    >
                      {pctLabel}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Compact Hover / Top-Item Footer */}
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-[10px] text-muted-foreground tabular-nums dark:border-[#242d3f]/80">
        {hoveredRect ? (
          <>
            <span className="truncate font-medium text-foreground">
              {hoveredRect.item.name}
            </span>
            <span className="shrink-0 font-mono">
              {formatCompactTokens(hoveredRect.item.tokens)} tok ·{" "}
              {hoveredRect.item.sharePct.toFixed(1)}% · {formatCents(hoveredRect.item.costCents)}
            </span>
          </>
        ) : activeItems.length > 0 ? (
          <>
            <span className="truncate">
              최다 사용: <strong className="text-foreground">{activeItems[0].name}</strong>
            </span>
            <span className="shrink-0 font-mono">
              {activeItems[0].sharePct.toFixed(1)}% · 상위 {activeItems.length}개 표시
            </span>
          </>
        ) : (
          <span>{mode === "project" ? "프로젝트별 비중" : "에이전트별 비중"}</span>
        )}
      </div>
    </div>
  );
}
