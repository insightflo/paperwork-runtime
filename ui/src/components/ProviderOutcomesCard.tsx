import type { ProviderModelOutcomeRow } from "@paperclipai/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatCents, providerDisplayName } from "../lib/utils";

function formatDuration(seconds: number): string {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function successRateTone(rate: number): string {
  if (rate >= 0.9) return "text-[#4d7c0f] dark:text-[#a3e635]";
  if (rate >= 0.75) return "text-[#b45309] dark:text-[#f59e0b]";
  return "text-[#be123c] dark:text-[#f43f5e]";
}

/**
 * Route memory for adapter/model choices: per (provider, model) run outcomes,
 * latency percentiles, and cost per successful run. The population is runs
 * that reported provider usage in the selected range.
 */
export function ProviderOutcomesCard({ rows }: { rows: ProviderModelOutcomeRow[] }) {
  return (
    <Card className="tactile-card gap-0 overflow-hidden rounded-[12px] border-slate-200/90 dark:border-white/[0.08] dark:bg-[#0e131d]">
      <CardHeader className="px-5 pb-2 pt-5">
        <CardTitle className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-700 dark:text-[#eef2f8]">
          Provider × model outcomes
        </CardTitle>
        <CardDescription className="max-w-3xl text-xs leading-5 text-slate-500 dark:text-[#8f9db3]">
          How runs actually ended on each provider + model — success rate, run-time percentiles, and
          cost per successful run. Check this before assigning adapters or models (route memory).
          Covers runs that reported provider usage in this period.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-2">
        {rows.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-slate-300/90 bg-slate-50/80 px-4 py-5 text-sm text-slate-500 dark:border-white/[0.08] dark:bg-[#090c12]/70 dark:text-[#8f9db3]">
            No provider usage recorded in this period.
          </div>
        ) : (
          <div className="overflow-x-auto overscroll-x-contain rounded-[10px] border border-slate-200/90 bg-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.08] dark:bg-[#090c12]/75 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
            <table className="min-w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-200/90 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:border-white/[0.08] dark:text-[#8f9db3]">
                  <th className="px-3 py-2.5 font-semibold">Provider</th>
                  <th className="px-3 py-2.5 font-semibold">Model</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Runs</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Success</th>
                  <th className="px-3 py-2.5 text-right font-semibold">p50 / p95</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Cost</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Cost / OK run</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/80 dark:divide-white/[0.06]">
                {rows.map((row) => (
                  <tr
                    key={`${row.provider}/${row.model}`}
                    className="transition-colors duration-150 hover:bg-[#2563eb]/[0.04] dark:hover:bg-[#60a5fa]/[0.06]"
                  >
                    <td className="whitespace-nowrap px-3 py-2.5 font-medium text-slate-800 dark:text-[#eef2f8]">
                      <span className="inline-flex items-center gap-2">
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#2563eb] dark:bg-[#60a5fa]" />
                        {providerDisplayName(row.provider)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-600 dark:text-[#8f9db3]">
                      <span className="rounded-md border border-slate-200/80 bg-slate-50 px-1.5 py-0.5 dark:border-white/[0.08] dark:bg-white/[0.04]">
                        {row.model}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-[#eef2f8]">{row.runs}</td>
                    <td className={cn("px-3 py-2.5 text-right font-semibold tabular-nums", successRateTone(row.successRate))}>
                      {(row.successRate * 100).toFixed(1)}%
                      <span className="block text-xs font-normal text-slate-500 dark:text-[#8f9db3]">
                        {row.succeededRuns} ok · {row.failedRuns} fail · {row.timedOutRuns + row.cancelledRuns + row.otherRuns} other
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-xs tabular-nums text-slate-600 dark:text-[#b6c2d6]">
                      {formatDuration(row.medianDurationSec)} / {formatDuration(row.p95DurationSec)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-[#eef2f8]">{formatCents(row.costCents)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums text-[#1d4ed8] dark:text-[#60a5fa]">
                      {row.succeededRuns > 0 ? formatCents(Math.round(row.costPerSucceededRunCents)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
