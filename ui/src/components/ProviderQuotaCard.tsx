import { useMemo, type ReactNode } from "react";
import type { CostByProviderModel, CostWindowSpendRow, QuotaWindow } from "@paperclipai/shared";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QuotaBar } from "./QuotaBar";
import { ClaudeSubscriptionPanel } from "./ClaudeSubscriptionPanel";
import { CodexSubscriptionPanel } from "./CodexSubscriptionPanel";
import { billingTypeDisplayName, cn, formatCents, formatTokens, providerDisplayName, quotaSourceDisplayName } from "@/lib/utils";

// ordered display labels for rolling-window rows
const ROLLING_WINDOWS = ["5h", "24h", "7d"] as const;

const CARD_CLASS = "gap-0 overflow-hidden rounded-xl border border-slate-200/90 bg-white py-0 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_28px_-12px_rgba(0,0,0,0.72)]";
const INSET_CLASS = "rounded-lg border border-slate-200/80 bg-slate-50/75 shadow-[inset_0_1px_1px_rgba(15,23,42,0.045)] dark:border-white/[0.065] dark:bg-[#090d14]/85 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]";
const DIVIDER_CLASS = "border-t border-slate-200/80 dark:border-white/[0.065]";
const SECTION_LABEL_CLASS = "text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]";
const COBALT_FILL = "bg-gradient-to-r from-blue-600 to-blue-400 shadow-[0_0_7px_rgba(37,99,235,0.24)] dark:from-[#60a5fa] dark:to-[#93c5fd] dark:shadow-[0_0_8px_rgba(96,165,250,0.42)]";
const LIME_FILL = "bg-gradient-to-r from-lime-600 to-lime-400 shadow-[0_0_7px_rgba(101,163,13,0.22)] dark:from-[#a3e635] dark:to-[#bef264] dark:shadow-[0_0_8px_rgba(163,230,53,0.46)]";
const AMBER_FILL = "bg-gradient-to-r from-amber-600 to-amber-400 shadow-[0_0_7px_rgba(217,119,6,0.22)] dark:from-[#f59e0b] dark:to-[#fbbf24] dark:shadow-[0_0_8px_rgba(245,158,11,0.45)]";

interface ProviderQuotaCardProps {
  provider: string;
  rows: CostByProviderModel[];
  /** company monthly budget in cents (0 means unlimited) */
  budgetMonthlyCents: number;
  /** total company spend in this period in cents, all providers */
  totalCompanySpendCents: number;
  /** spend in the current calendar week in cents, this provider only */
  weekSpendCents: number;
  /** rolling window rows for this provider: 5h, 24h, 7d */
  windowRows: CostWindowSpendRow[];
  showDeficitNotch: boolean;
  /** live subscription quota windows from the provider's own api */
  quotaWindows?: QuotaWindow[];
  quotaError?: string | null;
  quotaSource?: string | null;
  quotaLoading?: boolean;
}

export function ProviderQuotaCard({
  provider, rows, budgetMonthlyCents, totalCompanySpendCents, weekSpendCents, windowRows,
  showDeficitNotch, quotaWindows = [], quotaError = null, quotaSource = null, quotaLoading = false,
}: ProviderQuotaCardProps) {
  // single-pass aggregation over rows — memoized so the 8 derived values are not
  // recomputed on every parent render tick (providers tab polls every 30s, and each
  // card is mounted twice: once in the "all" tab grid and once in its per-provider tab).
  const totals = useMemo(() => {
    let inputTokens = 0, outputTokens = 0, costCents = 0;
    let apiRunCount = 0, subRunCount = 0, subInputTokens = 0, subOutputTokens = 0;
    for (const r of rows) {
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      costCents += r.costCents;
      apiRunCount += r.apiRunCount;
      subRunCount += r.subscriptionRunCount;
      subInputTokens += r.subscriptionInputTokens;
      subOutputTokens += r.subscriptionOutputTokens;
    }
    const totalTokens = inputTokens + outputTokens;
    const subTokens = subInputTokens + subOutputTokens;
    // denominator: api-billed tokens (from cost_events) + subscription tokens (from heartbeat_runs)
    const allTokens = totalTokens + subTokens;
    return {
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      totalTokens,
      totalCostCents: costCents,
      totalApiRuns: apiRunCount,
      totalSubRuns: subRunCount,
      totalSubInputTokens: subInputTokens,
      totalSubOutputTokens: subOutputTokens,
      totalSubTokens: subTokens,
      subSharePct: allTokens > 0 ? (subTokens / allTokens) * 100 : 0,
    };
  }, [rows]);

  const {
    totalInputTokens, totalOutputTokens, totalTokens, totalCostCents, totalApiRuns,
    totalSubRuns, totalSubInputTokens, totalSubOutputTokens, totalSubTokens, subSharePct,
  } = totals;

  // budget bars: use this provider's own spend vs its pro-rata share of budget
  // pro-rata: if a provider is 40% of total spend, it gets 40% of the budget allocated.
  // falls back to raw provider spend vs total budget when totalCompanySpend is 0.
  const providerBudgetShare = budgetMonthlyCents > 0 && totalCompanySpendCents > 0 ? (totalCostCents / totalCompanySpendCents) * budgetMonthlyCents : budgetMonthlyCents;
  const budgetPct =
    providerBudgetShare > 0
      ? Math.min(100, (totalCostCents / providerBudgetShare) * 100)
      : 0;

  // 4.33 = average weeks per calendar month (52 / 12)
  const weeklyBudgetShare = providerBudgetShare > 0 ? providerBudgetShare / 4.33 : 0;
  const weekPct =
    weeklyBudgetShare > 0 ? Math.min(100, (weekSpendCents / weeklyBudgetShare) * 100) : 0;
  const hasBudget = budgetMonthlyCents > 0;

  // memoized so the Map and max are not reconstructed on every parent render tick
  const windowMap = useMemo(
    () => new Map(windowRows.map((r) => [r.window, r])),
    [windowRows],
  );
  const maxWindowCents = useMemo(
    () => Math.max(...windowRows.map((r) => r.costCents), 0),
    [windowRows],
  );
  const isClaudeQuotaPanel = provider === "anthropic";
  const isCodexQuotaPanel = provider === "openai" && quotaSource?.startsWith("codex-");
  const supportsSubscriptionQuota = provider === "anthropic" || provider === "openai";
  const showSubscriptionQuotaSection =
    supportsSubscriptionQuota && (quotaLoading || quotaWindows.length > 0 || quotaError != null);

  return (
    <Card className={CARD_CLASS}>
      <CardHeader className="gap-1 border-b-[1px] border-slate-200/80 bg-slate-50/85 px-4 py-3 dark:border-white/[0.065] dark:bg-[#090d14]/90">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-[#aab6c9]">
              {providerDisplayName(provider)}
            </CardTitle>
            <CardDescription className="mt-1 text-xs text-slate-500 dark:text-[#8b97ad]">
              <span className="font-mono tabular-nums">{formatTokens(totalInputTokens)}</span> in
              {" · "}
              <span className="font-mono tabular-nums">{formatTokens(totalOutputTokens)}</span> out
              {(totalApiRuns > 0 || totalSubRuns > 0) && (
                <span className="ml-1.5 tabular-nums">
                  ·{" "}
                  {totalApiRuns > 0 && `~${totalApiRuns} api`}
                  {totalApiRuns > 0 && totalSubRuns > 0 && " / "}
                  {totalSubRuns > 0 && `~${totalSubRuns} sub`}
                  {" runs"}
                </span>
              )}
            </CardDescription>
          </div>
          <span className="shrink-0 font-mono text-xl font-bold tabular-nums text-slate-950 dark:text-[#edf2fb]">
            {formatCents(totalCostCents)}
          </span>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-4 pb-4 pt-4 tabular-nums">
        {hasBudget && (
          <div className={cn(INSET_CLASS, "space-y-3 px-3 py-3")}>
            <QuotaBar
              label="Period spend"
              percentUsed={budgetPct}
              leftLabel={formatCents(totalCostCents)}
              rightLabel={`${Math.round(budgetPct)}% of allocation`}
              showDeficitNotch={showDeficitNotch}
            />
            <QuotaBar
              label="This week"
              percentUsed={weekPct}
              leftLabel={formatCents(weekSpendCents)}
              rightLabel={`~${formatCents(Math.round(weeklyBudgetShare))} / wk`}
              showDeficitNotch={weekPct >= 100}
            />
          </div>
        )}

        {/* rolling window consumption — always shown when data is available */}
        {windowRows.length > 0 && (
          <>
            <div className={DIVIDER_CLASS} />
            <div className="space-y-2">
              <SectionLabel>Rolling windows</SectionLabel>
              <div className={cn(INSET_CLASS, "divide-y divide-slate-200/75 dark:divide-white/[0.055]")}>
                {ROLLING_WINDOWS.map((w) => {
                  const row = windowMap.get(w);
                  // omit windows with no data rather than showing false $0.00 zeros
                  if (!row) return null;
                  const cents = row.costCents;
                  const tokens = row.inputTokens + row.outputTokens;
                  const barPct = maxWindowCents > 0 ? (cents / maxWindowCents) * 100 : 0;
                  return (
                    <div key={w} className="space-y-1.5 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="w-7 shrink-0 font-mono font-semibold text-blue-700 dark:text-[#60a5fa]">{w}</span>
                        <span className="flex-1 font-mono text-slate-500 dark:text-[#8b97ad]">
                          {formatTokens(tokens)} tok
                        </span>
                        <span className="font-mono font-semibold tabular-nums text-slate-950 dark:text-[#edf2fb]">{formatCents(cents)}</span>
                      </div>
                      <Meter percent={barPct} fillClassName={COBALT_FILL} label={`${w} rolling spend`} />
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* subscription usage — shown when any subscription-billed runs exist */}
        {totalSubRuns > 0 && (
          <>
            <div className={DIVIDER_CLASS} />
            <div className="space-y-2">
              <SectionLabel>Subscription</SectionLabel>
              <div className={cn(INSET_CLASS, "space-y-2.5 px-3 py-2.5")}>
                <p className="text-xs text-slate-500 dark:text-[#8b97ad]">
                  <span className="font-mono font-semibold text-slate-950 dark:text-[#edf2fb]">{totalSubRuns}</span> runs
                  {" · "}
                  {totalSubTokens > 0 && (
                    <>
                      <span className="font-mono text-slate-700 dark:text-[#c7d0df]">{formatTokens(totalSubTokens)}</span> total
                      {" · "}
                    </>
                  )}
                  <span className="font-mono text-slate-700 dark:text-[#c7d0df]">{formatTokens(totalSubInputTokens)}</span> in
                  {" · "}
                  <span className="font-mono text-slate-700 dark:text-[#c7d0df]">{formatTokens(totalSubOutputTokens)}</span> out
                </p>
                {subSharePct > 0 && (
                  <>
                    <Meter percent={subSharePct} fillClassName={LIME_FILL} label="Subscription token share" />
                    <p className="text-xs text-slate-500 dark:text-[#8b97ad]">
                      <span className="font-mono font-semibold text-lime-700 dark:text-[#a3e635]">{Math.round(subSharePct)}%</span> of token usage via subscription
                    </p>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {/* model breakdown — always shown, with token-share bars */}
        {rows.length > 0 && (
          <>
            <div className={DIVIDER_CLASS} />
            <div className="space-y-3">
              {rows.map((row) => {
                const rowTokens = row.inputTokens + row.outputTokens;
                const tokenPct = totalTokens > 0 ? (rowTokens / totalTokens) * 100 : 0;
                const costPct = totalCostCents > 0 ? (row.costCents / totalCostCents) * 100 : 0;
                return (
                  <div key={`${row.provider}:${row.model}`} className="space-y-1.5">
                    {/* model name and cost */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="block truncate font-mono text-xs font-medium text-slate-700 dark:text-[#c7d0df]">
                          {row.model}
                        </span>
                        <span className="block truncate text-[11px] text-slate-500 dark:text-[#8b97ad]">
                          {providerDisplayName(row.biller)} · {billingTypeDisplayName(row.billingType)}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums">
                        <span className="font-mono text-slate-500 dark:text-[#8b97ad]">
                          {formatTokens(rowTokens)} tok
                        </span>
                        <span className="font-mono font-semibold text-slate-950 dark:text-[#edf2fb]">{formatCents(row.costCents)}</span>
                      </div>
                    </div>
                    {/* token share bar with cost share overlay */}
                    <Meter
                      percent={tokenPct}
                      fillClassName={COBALT_FILL}
                      overlayPercent={costPct}
                      overlayClassName={AMBER_FILL}
                      label={`${row.model} token and cost share`}
                    />
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* subscription quota windows from provider api — shown when data is available */}
        {showSubscriptionQuotaSection && (
          <>
            <div className={DIVIDER_CLASS} />
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <SectionLabel>Subscription quota</SectionLabel>
                {quotaSource && !isClaudeQuotaPanel && !isCodexQuotaPanel ? (
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">
                    {quotaSourceDisplayName(quotaSource)}
                  </span>
                ) : null}
              </div>
              {quotaLoading ? (
                <QuotaPanelSkeleton />
              ) : isClaudeQuotaPanel ? (
                <ClaudeSubscriptionPanel windows={quotaWindows} source={quotaSource} error={quotaError} />
              ) : isCodexQuotaPanel ? (
                <CodexSubscriptionPanel windows={quotaWindows} source={quotaSource} error={quotaError} />
              ) : (
                <>
                  {quotaError ? (
                    <p className="text-xs text-rose-600 dark:text-[#fb7185]">
                      {quotaError}
                    </p>
                  ) : null}
                  <div className={cn(INSET_CLASS, "divide-y divide-slate-200/75 dark:divide-white/[0.055]")}>
                    {quotaWindows.map((qw) => {
                      const fillColor =
                        qw.usedPercent == null
                          ? null
                          : quotaStatusFill(qw.usedPercent);
                      return (
                        <div key={qw.label} className="space-y-1.5 px-3 py-2.5">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="shrink-0 font-mono font-medium text-slate-500 dark:text-[#8b97ad]">{qw.label}</span>
                            <span className="flex-1" />
                            {qw.valueLabel != null ? (
                              <span className="font-mono font-semibold tabular-nums text-slate-950 dark:text-[#edf2fb]">{qw.valueLabel}</span>
                            ) : qw.usedPercent != null ? (
                              <span className="font-mono font-semibold tabular-nums text-slate-950 dark:text-[#edf2fb]">{qw.usedPercent}% used</span>
                            ) : null}
                          </div>
                          {qw.usedPercent != null && fillColor != null && (
                            <Meter percent={qw.usedPercent} fillClassName={fillColor} label={`${qw.label} quota`} />
                          )}
                          {qw.detail ? (
                            <p className="text-xs text-slate-500 dark:text-[#8b97ad]">
                              {qw.detail}
                            </p>
                          ) : qw.resetsAt ? (
                            <p className="text-xs text-slate-500 dark:text-[#8b97ad]">
                              resets {new Date(qw.resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className={SECTION_LABEL_CLASS}>{children}</p>;
}

function quotaStatusFill(pct: number): string {
  if (pct >= 90) {
    return "bg-gradient-to-r from-rose-500 to-rose-400 shadow-[0_0_7px_rgba(244,63,94,0.25)] dark:from-[#fb7185] dark:to-[#f43f5e] dark:shadow-[0_0_8px_rgba(244,63,94,0.46)]";
  }
  if (pct >= 70) return AMBER_FILL;
  return LIME_FILL;
}

function Meter({
  percent,
  fillClassName,
  overlayPercent,
  overlayClassName,
  label,
}: {
  percent: number;
  fillClassName: string;
  overlayPercent?: number;
  overlayClassName?: string;
  label: string;
}) {
  const width = Math.min(100, Math.max(0, percent));
  const overlayWidth = overlayPercent == null ? null : Math.min(100, Math.max(0, overlayPercent));
  return (
    <div
      role="img"
      aria-label={label}
      className="relative h-2 w-full overflow-hidden rounded-full border border-slate-200/90 bg-slate-100 shadow-[inset_0_1px_1px_rgba(15,23,42,0.06)] dark:border-white/[0.08] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]"
    >
      <div
        className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-150 motion-reduce:transition-none", fillClassName)}
        style={{ width: `${width}%` }}
      />
      {overlayWidth != null && overlayClassName ? (
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-150 motion-reduce:transition-none", overlayClassName)}
          style={{ width: `${overlayWidth}%` }}
        />
      ) : null}
    </div>
  );
}

function QuotaPanelSkeleton() {
  return (
    <div className={cn(INSET_CLASS, "px-4 py-4")}>
      <div className="flex items-start justify-between gap-3 border-b border-slate-200/80 pb-3 dark:border-white/[0.065]">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-7 w-28" />
      </div>
      <div className="mt-4 space-y-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="rounded-lg border border-slate-200/80 bg-white/70 px-3.5 py-3 dark:border-white/[0.065] dark:bg-[#0e131d]/80"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-44 max-w-full" />
              </div>
              <Skeleton className="h-4 w-20" />
            </div>
            <Skeleton className="mt-3 h-2 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
