import { useId, useMemo } from "react";
import { cn } from "@/lib/utils";

export interface RadialVelocityGaugeProps {
  tokensPerHour: number;
  peakTokensPerHour: number;
  totalTokens: number;
  avgTokensPerBucket?: number;
  activeWorkers?: number;
  hostLabel?: string | null;
  loading?: boolean;
  className?: string;
}

const SEGMENT_COUNT = 36;
const START_ANGLE_DEG = 150;
const SWEEP_ANGLE_DEG = 240;
const CX = 130;
const CY = 122;
const INNER_R = 78;
const OUTER_R = 98;

function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function segmentColor(index: number, total: number): string {
  const t = total > 1 ? index / (total - 1) : 0;
  if (t < 0.45) return "var(--pw-cobalt)"; // cobalt baseline (#60a5fa in dark mode)
  if (t < 0.8) return "var(--pw-lime)"; // neon lime active band (#a3e635 in dark mode)
  return "var(--pw-amber)"; // amber peak band (#f59e0b in dark mode)
}

function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

export function RadialVelocityGauge({
  tokensPerHour,
  peakTokensPerHour,
  totalTokens,
  avgTokensPerBucket = 0,
  activeWorkers = 0,
  hostLabel,
  loading = false,
  className,
}: RadialVelocityGaugeProps) {
  const filterId = useId().replace(/:/g, "");

  const safeRate = Number.isFinite(tokensPerHour) && tokensPerHour > 0 ? tokensPerHour : 0;
  const safePeak = Number.isFinite(peakTokensPerHour) && peakTokensPerHour > 0 ? peakTokensPerHour : 0;
  const safeTotal = Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0;
  const safeAvg = Number.isFinite(avgTokensPerBucket) && avgTokensPerBucket > 0 ? avgTokensPerBucket : 0;

  const fillRatio = safeRate > 0 ? Math.min(1, Math.max(0, safeRate / Math.max(safePeak, safeRate, 1))) : 0;
  const litSegments = safeRate > 0 ? Math.max(1, Math.round(fillRatio * SEGMENT_COUNT)) : 0;

  const segments = useMemo(() => {
    const step = SWEEP_ANGLE_DEG / (SEGMENT_COUNT - 1);
    return Array.from({ length: SEGMENT_COUNT }, (_, idx) => {
      const angle = START_ANGLE_DEG + idx * step;
      const p1 = polarToCartesian(CX, CY, INNER_R, angle);
      const p2 = polarToCartesian(CX, CY, OUTER_R, angle);
      return {
        idx,
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        color: segmentColor(idx, SEGMENT_COUNT),
      };
    });
  }, []);

  if (loading) {
    return (
      <div
        className={cn(
          "tactile-card border flex flex-col justify-between rounded-[12px] border-slate-200/90 bg-white p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]",
          className,
        )}
        aria-busy="true"
        aria-label="토큰 속도 게이지 로딩 중"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="h-3.5 w-24 animate-pulse rounded bg-muted" />
          <div className="h-5 w-20 animate-pulse rounded-full bg-muted" />
        </div>
        <div className="my-3 flex flex-col items-center justify-center">
          <div className="h-40 w-40 animate-pulse rounded-full border-8 border-muted/50" />
        </div>
        <div className="flex items-center justify-between">
          <div className="h-3 w-12 animate-pulse rounded bg-muted" />
          <div className="h-3 w-16 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  const isLive = activeWorkers > 0 || safeRate > 0;
  const badgeText = hostLabel
    ? `${hostLabel}${activeWorkers > 0 ? ` · ${activeWorkers}` : ""}`
    : activeWorkers > 0
      ? `워커 ${activeWorkers}`
      : "대기 중";

  return (
    <div
      className={cn(
        "tactile-card border flex flex-col justify-between rounded-[12px] border-slate-200/90 bg-white p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]",
        className,
      )}
    >
      {/* Card Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              "inline-block h-2 w-2 shrink-0 rounded-full",
              isLive
                ? "bg-[#65a30d] shadow-[0_0_8px_rgba(101,163,13,0.35)] dark:bg-[#a3e635] dark:shadow-[0_0_8px_rgba(163,230,53,0.8)]"
                : "bg-muted-foreground/40",
            )}
          />
          <h3 className="truncate text-xs font-semibold tracking-tight text-foreground">
            토큰 속도
          </h3>
        </div>
        <span
          className={cn(
            "inline-flex max-w-[10.5rem] items-center gap-1.5 truncate rounded-full border px-2 py-0.5 text-[10px] font-medium tabular-nums",
            activeWorkers > 0
              ? "border-[#a3e635]/35 bg-[#a3e635]/12 text-[#4d7c0f] dark:text-[#a3e635]"
              : "border-slate-200/90 bg-slate-100/80 text-slate-500 dark:border-white/[0.08] dark:bg-[#07090d] dark:text-[#8b97ad]",
          )}
          title={badgeText}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              activeWorkers > 0 ? "bg-[#65a30d] dark:bg-[#a3e635]" : "bg-muted-foreground/50",
            )}
          />
          <span className="truncate">{badgeText}</span>
        </span>
      </div>

      {/* Radial Segmented Arc SVG */}
      <div className="relative mx-auto my-1 w-full max-w-[260px]">
        <svg
          viewBox="0 0 260 198"
          className="h-auto w-full overflow-visible"
          role="img"
          aria-label={`토큰 속도 ${formatCompactTokens(safeRate)} tokens/시간, 최대 ${formatCompactTokens(safePeak)}`}
        >
          <defs>
            <filter id={`glow-${filterId}`} x="-25%" y="-25%" width="150%" height="150%">
              <feGaussianBlur stdDeviation="2.6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Subtle inner reference ring */}
          <path
            d={`M ${polarToCartesian(CX, CY, INNER_R - 7, START_ANGLE_DEG).x.toFixed(1)} ${polarToCartesian(CX, CY, INNER_R - 7, START_ANGLE_DEG).y.toFixed(1)} A ${INNER_R - 7} ${INNER_R - 7} 0 1 1 ${polarToCartesian(CX, CY, INNER_R - 7, START_ANGLE_DEG + SWEEP_ANGLE_DEG).x.toFixed(1)} ${polarToCartesian(CX, CY, INNER_R - 7, START_ANGLE_DEG + SWEEP_ANGLE_DEG).y.toFixed(1)}`}
            fill="none"
            className="stroke-slate-300/80 dark:stroke-white/[0.09]"
            strokeWidth={1}
            strokeDasharray="2 4"
          />

          {/* 36 Segmented Radial Ticks */}
          {segments.map((seg) => {
            const isLit = seg.idx < litSegments;
            return (
              <line
                key={seg.idx}
                x1={seg.x1.toFixed(2)}
                y1={seg.y1.toFixed(2)}
                x2={seg.x2.toFixed(2)}
                y2={seg.y2.toFixed(2)}
                stroke={isLit ? seg.color : undefined}
                className={cn(
                  "transition-opacity duration-300",
                  !isLit && "stroke-slate-300/75 dark:stroke-white/[0.12]",
                )}
                strokeWidth={isLit ? 4.4 : 3.6}
                strokeLinecap="round"
                filter={isLit ? `url(#glow-${filterId})` : undefined}
              />
            );
          })}

          {/* Center Digital Readout */}
          <text
            x={CX}
            y={CY - 4}
            textAnchor="middle"
            className={cn(
              "fill-foreground text-[32px] font-bold tracking-tight tabular-nums",
              safeRate === 0 && "fill-muted-foreground",
            )}
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {formatCompactTokens(safeRate)}
          </text>
          <text
            x={CX}
            y={CY + 16}
            textAnchor="middle"
            className="fill-muted-foreground text-[11px] font-medium"
          >
            tokens/시간
          </text>
          <text
            x={CX}
            y={CY + 37}
            textAnchor="middle"
            className="fill-muted-foreground/85 text-[10px] tabular-nums"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {safeTotal > 0
              ? `Total ${formatCompactTokens(safeTotal)} · 평균 ${formatCompactTokens(safeAvg)}`
              : "최근 버킷 토큰 활동 없음"}
          </text>
        </svg>
      </div>

      {/* Footer Scale */}
      <div className="flex items-center justify-between border-t border-slate-200/80 pt-2 text-[10px] text-muted-foreground tabular-nums dark:border-white/[0.07]">
        <span>0</span>
        <span className="font-mono text-[10px] text-muted-foreground/80">
          {Math.round(fillRatio * 100)}% of peak
        </span>
        <span>Peak {formatCompactTokens(safePeak)}</span>
      </div>
    </div>
  );
}
