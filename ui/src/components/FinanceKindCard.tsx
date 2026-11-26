import type { FinanceByKind } from "@paperclipai/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { financeEventKindDisplayName, formatCents } from "@/lib/utils";

interface FinanceKindCardProps {
  rows: FinanceByKind[];
}

const TACTILE_CARD_CLASS =
  "tactile-card rounded-[12px] border border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]";

export function FinanceKindCard({ rows }: FinanceKindCardProps) {
  return (
    <Card className={`${TACTILE_CARD_CLASS} gap-0 overflow-hidden py-0 tabular-nums`}>
      <CardHeader className="border-b border-slate-200/80 px-4 pb-3 pt-4 dark:border-white/[0.07]">
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-blue-600 shadow-[0_0_6px_rgba(37,99,235,0.28)] dark:bg-[#60a5fa] dark:shadow-[0_0_8px_rgba(96,165,250,0.45)]" />
          <CardTitle className="text-sm font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Financial event mix</CardTitle>
        </div>
        <CardDescription className="text-xs text-slate-500 dark:text-[#8f9db3]">Account-level charges grouped by event kind.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-4 pb-4 pt-3">
        {rows.length === 0 ? (
          <p className="rounded-[10px] border border-slate-200/80 bg-slate-50/85 px-3 py-2.5 text-sm text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.07] dark:bg-[#090c12] dark:text-[#8f9db3] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">No finance events in this period.</p>
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-slate-200/80 bg-slate-50/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
            <div className="divide-y divide-slate-200/75 dark:divide-white/[0.06]">
              {rows.map((row) => (
                <div
                  key={row.eventKind}
                  className="flex items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600 dark:bg-[#60a5fa]" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-950 dark:text-[#edf2fb]">{financeEventKindDisplayName(row.eventKind)}</div>
                      <div className="text-xs tabular-nums text-slate-500 dark:text-[#8f9db3]">
                        {row.eventCount} event{row.eventCount === 1 ? "" : "s"} · {row.billerCount} biller{row.billerCount === 1 ? "" : "s"}
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <div className="text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">{formatCents(row.netCents)}</div>
                    <div className="text-xs text-rose-700/90 dark:text-[#f43f5e]/90">
                      {formatCents(row.debitCents)} debits
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
