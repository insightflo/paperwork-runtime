import { cn } from "@/lib/utils";

interface QuotaBarProps {
  label: string;
  // value between 0 and 100
  percentUsed: number;
  leftLabel: string;
  rightLabel?: string;
  // shows a 2px destructive notch at the fill tip when true
  showDeficitNotch?: boolean;
  className?: string;
}

function fillColor(pct: number): string {
  if (pct > 90) {
    return "bg-gradient-to-r from-rose-500 to-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.28)] dark:from-[#fb7185] dark:to-[#f43f5e] dark:shadow-[0_0_8px_rgba(244,63,94,0.5)]";
  }
  if (pct > 70) {
    return "bg-gradient-to-r from-amber-500 to-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.24)] dark:from-[#f59e0b] dark:to-[#fbbf24] dark:shadow-[0_0_8px_rgba(245,158,11,0.48)]";
  }
  return "bg-gradient-to-r from-lime-500 to-lime-400 shadow-[0_0_8px_rgba(132,204,22,0.22)] dark:from-[#a3e635] dark:to-[#bef264] dark:shadow-[0_0_8px_rgba(163,230,53,0.48)]";
}

export function QuotaBar({
  label,
  percentUsed,
  leftLabel,
  rightLabel,
  showDeficitNotch = false,
  className,
}: QuotaBarProps) {
  const clampedPct = Math.min(100, Math.max(0, percentUsed));
  // keep the notch visible even near the edges
  const notchLeft = Math.min(clampedPct, 97);

  return (
    <div className={cn("space-y-1.5 tabular-nums", className)}>
      {/* row header */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-[#8b97ad]">
          {label}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-xs font-semibold tabular-nums text-slate-950 dark:text-[#edf2fb]">
            {leftLabel}
          </span>
          {rightLabel && (
            <span className="font-mono text-[11px] text-slate-500 tabular-nums dark:text-[#8b97ad]">
              {rightLabel}
            </span>
          )}
        </div>
      </div>

      {/* track — recessed cockpit meter with a 1px specular edge in dark mode */}
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clampedPct)}
        className="relative h-2 w-full overflow-hidden rounded-full border border-slate-200/90 bg-slate-100 shadow-[inset_0_1px_1px_rgba(15,23,42,0.06)] dark:border-white/[0.08] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]"
      >
        {/* fill */}
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-150 motion-reduce:transition-none",
            fillColor(clampedPct),
          )}
          style={{ width: `${clampedPct}%` }}
        />
        {/* deficit notch — 2px wide, sits at the fill tip */}
        {showDeficitNotch && clampedPct > 0 && (
          <div
            className="absolute inset-y-0 z-10 w-[2px] bg-rose-600 shadow-[0_0_6px_rgba(225,29,72,0.45)] dark:bg-[#fb7185]"
            style={{ left: `${notchLeft}%` }}
          />
        )}
      </div>
    </div>
  );
}
