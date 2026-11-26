import type { FinanceByBiller } from "@paperclipai/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents, providerDisplayName } from "@/lib/utils";

interface FinanceBillerCardProps {
  row: FinanceByBiller;
}

const TACTILE_CARD_CLASS =
  "tactile-card rounded-[12px] border border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]";
const METRIC_TILE_CLASS =
  "rounded-[10px] border border-slate-200/80 bg-slate-50/85 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";

export function FinanceBillerCard({ row }: FinanceBillerCardProps) {
  return (
    <Card className={`${TACTILE_CARD_CLASS} gap-0 overflow-hidden py-0 tabular-nums`}>
      <CardHeader className="border-b border-slate-200/80 px-4 pb-3 pt-4 dark:border-white/[0.07]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-blue-600 shadow-[0_0_6px_rgba(37,99,235,0.28)] dark:bg-[#60a5fa] dark:shadow-[0_0_8px_rgba(96,165,250,0.45)]" />
              <CardTitle className="truncate text-sm font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">{providerDisplayName(row.biller)}</CardTitle>
            </div>
            <CardDescription className="mt-1 text-xs tabular-nums text-slate-500 dark:text-[#8f9db3]">
              {row.eventCount} event{row.eventCount === 1 ? "" : "s"} across {row.kindCount} kind{row.kindCount === 1 ? "" : "s"}
            </CardDescription>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-xl font-semibold tracking-tight tabular-nums text-slate-950 dark:text-[#edf2fb]">{formatCents(row.netCents)}</div>
            <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8f9db3]">net</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 pt-3">
        <div className="grid gap-2.5 text-sm sm:grid-cols-3">
          <div className={METRIC_TILE_CLASS}>
            <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8f9db3]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-rose-600 dark:bg-[#f43f5e]" />
              debits
            </div>
            <div className="mt-1.5 font-semibold tabular-nums text-rose-700 dark:text-[#f43f5e]">{formatCents(row.debitCents)}</div>
          </div>
          <div className={METRIC_TILE_CLASS}>
            <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8f9db3]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-lime-600 dark:bg-[#a3e635]" />
              credits
            </div>
            <div className="mt-1.5 font-semibold tabular-nums text-lime-700 dark:text-[#a3e635]">{formatCents(row.creditCents)}</div>
          </div>
          <div className={METRIC_TILE_CLASS}>
            <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8f9db3]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-blue-600 dark:bg-[#60a5fa]" />
              estimated
            </div>
            <div className="mt-1.5 font-semibold tabular-nums text-blue-700 dark:text-[#60a5fa]">{formatCents(row.estimatedDebitCents)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
