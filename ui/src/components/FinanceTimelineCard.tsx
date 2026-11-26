import type { FinanceEvent } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  cn,
  financeDirectionDisplayName,
  financeEventKindDisplayName,
  formatCents,
  formatDateTime,
  providerDisplayName,
} from "@/lib/utils";

const TACTILE_CARD_CLASS =
  "tactile-card overflow-hidden border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)] tabular-nums";

const TIMELINE_ROW_CLASS =
  "rounded-xl border border-slate-200/85 bg-slate-50/75 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-white/[0.07] dark:bg-[#07090d]/80 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";

interface FinanceTimelineCardProps {
  rows: FinanceEvent[];
  emptyMessage?: string;
}

export function FinanceTimelineCard({
  rows,
  emptyMessage = "No financial events in this period.",
}: FinanceTimelineCardProps) {
  return (
    <Card className={TACTILE_CARD_CLASS}>
      <CardHeader className="px-4 pb-1 pt-4">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_7px_rgba(37,99,235,0.35)] dark:bg-[#60a5fa] dark:shadow-[0_0_8px_rgba(96,165,250,0.7)]"
          />
          <CardTitle className="text-base text-slate-950 dark:text-[#eef2f8]">Recent financial events</CardTitle>
        </div>
        <CardDescription className="text-slate-500 dark:text-[#8b97ad]">
          Top-ups, fees, credits, commitments, and other non-request charges.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 pt-3">
        {rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200/90 bg-slate-50/70 px-3 py-4 text-sm text-slate-500 dark:border-white/[0.09] dark:bg-[#07090d]/60 dark:text-[#8b97ad]">
            {emptyMessage}
          </p>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              className={TIMELINE_ROW_CLASS}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className="border-blue-500/25 bg-blue-500/10 font-mono text-[11px] text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]"
                    >
                      {financeEventKindDisplayName(row.eventKind)}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={cn(
                        "font-mono text-[11px]",
                        row.direction === "credit"
                          ? "border-lime-500/30 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#a3e635]"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]",
                      )}
                    >
                      {financeDirectionDisplayName(row.direction)}
                    </Badge>
                    <span className="text-xs text-slate-500 dark:text-[#8b97ad]">{formatDateTime(row.occurredAt)}</span>
                  </div>
                  <div className="text-sm font-medium text-slate-950 dark:text-[#eef2f8]">
                    {providerDisplayName(row.biller)}
                    {row.provider ? ` -> ${providerDisplayName(row.provider)}` : ""}
                    {row.model ? <span className="ml-1 font-mono text-xs text-slate-500 dark:text-[#8b97ad]">{row.model}</span> : null}
                  </div>
                  {(row.description || row.externalInvoiceId || row.region || row.pricingTier) && (
                    <div className="space-y-1 text-xs text-slate-500 dark:text-[#8b97ad]">
                      {row.description ? <div>{row.description}</div> : null}
                      {row.externalInvoiceId ? <div className="font-mono">invoice {row.externalInvoiceId}</div> : null}
                      {row.region ? <div className="font-mono">region {row.region}</div> : null}
                      {row.pricingTier ? <div className="font-mono">tier {row.pricingTier}</div> : null}
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right tabular-nums">
                  <div className="font-mono text-sm font-semibold text-slate-950 dark:text-[#eef2f8]">{formatCents(row.amountCents)}</div>
                  <div className="text-xs text-slate-500 dark:text-[#8b97ad]">{row.currency}</div>
                  {row.estimated ? (
                    <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-[#f59e0b]">
                      estimated
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
