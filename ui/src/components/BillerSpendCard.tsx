import { useMemo } from "react";
import type { CostByBiller, CostByProviderModel } from "@paperclipai/shared";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { QuotaBar } from "./QuotaBar";
import { billingTypeDisplayName, formatCents, formatTokens, providerDisplayName } from "@/lib/utils";

const TACTILE_CARD_CLASS =
  "tactile-card overflow-hidden border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)] tabular-nums";

const INNER_ROW_CLASS =
  "rounded-lg border border-slate-200/80 bg-slate-50/75 px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-white/[0.06] dark:bg-[#07090d]/75 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]";

interface BillerSpendCardProps {
  row: CostByBiller;
  weekSpendCents: number;
  budgetMonthlyCents: number;
  totalCompanySpendCents: number;
  providerRows: CostByProviderModel[];
}

export function BillerSpendCard({
  row,
  weekSpendCents,
  budgetMonthlyCents,
  totalCompanySpendCents,
  providerRows,
}: BillerSpendCardProps) {
  const providerBreakdown = useMemo(() => {
    const map = new Map<string, { provider: string; costCents: number; inputTokens: number; outputTokens: number }>();
    for (const entry of providerRows) {
      const current = map.get(entry.provider) ?? {
        provider: entry.provider,
        costCents: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      current.costCents += entry.costCents;
      current.inputTokens += entry.inputTokens + entry.cachedInputTokens;
      current.outputTokens += entry.outputTokens;
      map.set(entry.provider, current);
    }
    return Array.from(map.values()).sort((a, b) => b.costCents - a.costCents);
  }, [providerRows]);

  const billingTypeBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of providerRows) {
      map.set(entry.billingType, (map.get(entry.billingType) ?? 0) + entry.costCents);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [providerRows]);

  const providerBudgetShare =
    budgetMonthlyCents > 0 && totalCompanySpendCents > 0
      ? (row.costCents / totalCompanySpendCents) * budgetMonthlyCents
      : budgetMonthlyCents;
  const budgetPct =
    providerBudgetShare > 0
      ? Math.min(100, (row.costCents / providerBudgetShare) * 100)
      : 0;

  return (
    <Card className={TACTILE_CARD_CLASS}>
      <CardHeader className="gap-1 px-4 pb-0 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full bg-lime-500 shadow-[0_0_7px_rgba(101,163,13,0.35)] dark:bg-[#a3e635] dark:shadow-[0_0_8px_rgba(163,230,53,0.7)]"
              />
              <CardTitle className="truncate text-sm font-semibold text-slate-950 dark:text-[#eef2f8]">
                {providerDisplayName(row.biller)}
              </CardTitle>
            </div>
            <CardDescription className="mt-0.5 text-xs text-slate-500 dark:text-[#8b97ad]">
              <span className="font-mono tabular-nums">{formatTokens(row.inputTokens + row.cachedInputTokens)}</span> in
              {" · "}
              <span className="font-mono tabular-nums">{formatTokens(row.outputTokens)}</span> out
              {" · "}
              {row.providerCount} provider{row.providerCount === 1 ? "" : "s"}
              {" · "}
              {row.modelCount} model{row.modelCount === 1 ? "" : "s"}
            </CardDescription>
          </div>
          <span className="shrink-0 font-mono text-xl font-bold tabular-nums text-slate-950 dark:text-[#edf2fb]">
            {formatCents(row.costCents)}
          </span>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-4 pb-4 pt-3">
        {budgetMonthlyCents > 0 && (
          <div className="rounded-xl border border-slate-200/85 bg-slate-50/80 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-white/[0.07] dark:bg-[#07090d]/85 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
            <QuotaBar
              label="Period spend"
              percentUsed={budgetPct}
              leftLabel={formatCents(row.costCents)}
              rightLabel={`${Math.round(budgetPct)}% of allocation`}
            />
          </div>
        )}

        <div className="text-xs text-slate-500 dark:text-[#8b97ad]">
          {row.apiRunCount > 0 ? `${row.apiRunCount} metered run${row.apiRunCount === 1 ? "" : "s"}` : "0 metered runs"}
          {" · "}
          {row.subscriptionRunCount > 0
            ? `${row.subscriptionRunCount} subscription run${row.subscriptionRunCount === 1 ? "" : "s"}`
            : "0 subscription runs"}
          {" · "}
          <span className="font-medium text-amber-700 dark:text-[#f59e0b]">{formatCents(weekSpendCents)}</span> this week
        </div>

        {billingTypeBreakdown.length > 0 && (
          <>
            <div className="border-t border-slate-200/80 dark:border-white/[0.06]" />
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-[#f59e0b] dark:shadow-[0_0_6px_rgba(245,158,11,0.6)]" />
                Billing types
              </p>
              <div className="space-y-1.5">
                {billingTypeBreakdown.map(([billingType, costCents]) => (
                  <div key={billingType} className={`${INNER_ROW_CLASS} flex items-center justify-between gap-2 text-xs`}>
                    <span className="text-slate-600 dark:text-[#8b97ad]">{billingTypeDisplayName(billingType as any)}</span>
                    <span className="font-medium tabular-nums text-slate-950 dark:text-[#eef2f8]">{formatCents(costCents)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {providerBreakdown.length > 0 && (
          <>
            <div className="border-t border-slate-200/80 dark:border-white/[0.06]" />
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-blue-500 dark:bg-[#60a5fa] dark:shadow-[0_0_6px_rgba(96,165,250,0.6)]" />
                Upstream providers
              </p>
              <div className="space-y-1.5">
                {providerBreakdown.map((entry) => (
                  <div key={entry.provider} className={`${INNER_ROW_CLASS} flex items-center justify-between gap-2 text-xs`}>
                    <span className="text-slate-600 dark:text-[#8b97ad]">{providerDisplayName(entry.provider)}</span>
                    <div className="text-right tabular-nums">
                      <div className="font-medium text-slate-950 dark:text-[#eef2f8]">{formatCents(entry.costCents)}</div>
                      <div className="text-slate-500 dark:text-[#8b97ad]">
                        {formatTokens(entry.inputTokens + entry.outputTokens)} tok
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
