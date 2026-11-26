import type { QuotaWindow } from "@paperclipai/shared";
import { cn, quotaSourceDisplayName } from "@/lib/utils";

interface ClaudeSubscriptionPanelProps {
  windows: QuotaWindow[];
  source?: string | null;
  error?: string | null;
}

const WINDOW_ORDER = [
  "currentsession",
  "currentweekallmodels",
  "currentweeksonnetonly",
  "currentweeksonnet",
  "currentweekopusonly",
  "currentweekopus",
  "extrausage",
] as const;

const PANEL_CLASS =
  "tactile-card overflow-hidden rounded-[12px] border border-slate-200/90 bg-white tabular-nums text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]";
const ROW_CLASS =
  "rounded-[10px] border border-slate-200/80 bg-slate-50/85 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
const TRACK_CLASS =
  "mt-3 h-2 overflow-hidden rounded-full border border-slate-200/80 bg-slate-100 dark:border-white/[0.07] dark:bg-[#07090d]";

function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function detailText(window: QuotaWindow): string | null {
  if (typeof window.detail === "string" && window.detail.trim().length > 0) return window.detail.trim();
  if (window.resetsAt) {
    const formatted = new Date(window.resetsAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    return `Resets ${formatted}`;
  }
  return null;
}

function orderedWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort((a, b) => {
    const aIndex = WINDOW_ORDER.indexOf(normalizeLabel(a.label) as (typeof WINDOW_ORDER)[number]);
    const bIndex = WINDOW_ORDER.indexOf(normalizeLabel(b.label) as (typeof WINDOW_ORDER)[number]);
    return (aIndex === -1 ? WINDOW_ORDER.length : aIndex) - (bIndex === -1 ? WINDOW_ORDER.length : bIndex);
  });
}

function fillClass(usedPercent: number | null): string {
  if (usedPercent == null) return "bg-slate-400 dark:bg-[#64748b]";
  if (usedPercent >= 90) return "bg-rose-600 shadow-[0_0_8px_rgba(225,29,72,0.28)] dark:bg-[#f43f5e] dark:shadow-[0_0_8px_rgba(244,63,94,0.45)]";
  if (usedPercent >= 70) return "bg-amber-600 shadow-[0_0_8px_rgba(217,119,6,0.25)] dark:bg-[#f59e0b] dark:shadow-[0_0_8px_rgba(245,158,11,0.42)]";
  return "bg-lime-600 shadow-[0_0_8px_rgba(101,163,13,0.24)] dark:bg-[#a3e635] dark:shadow-[0_0_8px_rgba(163,230,53,0.5)]";
}

export function ClaudeSubscriptionPanel({
  windows,
  source = null,
  error = null,
}: ClaudeSubscriptionPanelProps) {
  const ordered = orderedWindows(windows);

  return (
    <div className={PANEL_CLASS}>
      <div className="flex items-start justify-between gap-3 border-b border-slate-200/80 bg-slate-50/75 px-4 py-3 dark:border-white/[0.07] dark:bg-[#090c12]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-[#8f9db3]">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-blue-600 shadow-[0_0_6px_rgba(37,99,235,0.28)] dark:bg-[#60a5fa] dark:shadow-[0_0_8px_rgba(96,165,250,0.45)]" />
            Anthropic subscription
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-[#8f9db3]">
            Live Claude quota windows.
          </div>
        </div>
        {source ? (
          <span className="shrink-0 rounded-full border border-blue-600/25 bg-blue-600/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]">
            {quotaSourceDisplayName(source)}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="mx-4 mt-4 rounded-[10px] border border-rose-300/80 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-[#f43f5e]/35 dark:bg-[#f43f5e]/10 dark:text-[#fda4af]">
          {error}
        </div>
      ) : null}

      <div className="mt-4 space-y-3 px-4 pb-4">
        {ordered.map((window) => {
          const normalized = normalizeLabel(window.label);
          const detail = detailText(window);
          if (normalized === "extrausage") {
            return (
              <div
                key={window.label}
                className={ROW_CLASS}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-slate-950 dark:text-[#edf2fb]">{window.label}</div>
                  {window.valueLabel ? (
                    <div className="text-sm font-semibold tabular-nums text-blue-700 dark:text-[#60a5fa]">{window.valueLabel}</div>
                  ) : null}
                </div>
                {detail ? (
                  <div className="mt-2 text-xs text-slate-500 dark:text-[#8f9db3]">{detail}</div>
                ) : null}
              </div>
            );
          }

          const width = Math.min(100, Math.max(0, window.usedPercent ?? 0));
          return (
            <div
              key={window.label}
              className={ROW_CLASS}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-950 dark:text-[#edf2fb]">{window.label}</div>
                  {detail ? (
                    <div className="mt-1 text-xs text-slate-500 dark:text-[#8f9db3]">{detail}</div>
                  ) : null}
                </div>
                {window.usedPercent != null ? (
                  <div className="shrink-0 text-sm font-semibold tabular-nums text-slate-950 dark:text-[#edf2fb]">
                    {window.usedPercent}% used
                  </div>
                ) : null}
              </div>

              <div className={TRACK_CLASS}>
                <div
                  className={cn("h-full rounded-full transition-[width] duration-200", fillClass(window.usedPercent))}
                  style={{ width: `${width}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
