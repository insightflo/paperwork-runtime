import { Database, Gauge, ReceiptText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const TACTILE_CARD_CLASS =
  "tactile-card relative overflow-hidden border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)] tabular-nums";

const SURFACES = [
  {
    title: "Inference ledger",
    description: "Request-scoped usage and billed runs from cost_events.",
    icon: Database,
    points: ["tokens + billed dollars", "provider, biller, model", "subscription and overage aware"],
    tone: "border-blue-500/25 bg-blue-500/5 dark:border-[#60a5fa]/25 dark:bg-[#60a5fa]/10",
    iconTone: "text-blue-600 dark:text-[#60a5fa]",
    dot: "bg-blue-500 dark:bg-[#60a5fa] dark:shadow-[0_0_8px_rgba(96,165,250,0.55)]",
  },
  {
    title: "Finance ledger",
    description: "Account-level charges that are not one prompt-response pair.",
    icon: ReceiptText,
    points: ["top-ups, refunds, fees", "Bedrock provisioned or training charges", "credit expiries and adjustments"],
    tone: "border-amber-500/25 bg-amber-500/5 dark:border-[#f59e0b]/25 dark:bg-[#f59e0b]/10",
    iconTone: "text-amber-700 dark:text-[#f59e0b]",
    dot: "bg-amber-500 dark:bg-[#f59e0b] dark:shadow-[0_0_8px_rgba(245,158,11,0.55)]",
  },
  {
    title: "Live quotas",
    description: "Provider or biller windows that can stop traffic in real time.",
    icon: Gauge,
    points: ["provider quota windows", "biller credit systems", "errors surfaced directly"],
    tone: "border-lime-500/25 bg-lime-500/5 dark:border-[#a3e635]/25 dark:bg-[#a3e635]/10",
    iconTone: "text-lime-700 dark:text-[#a3e635]",
    dot: "bg-lime-500 dark:bg-[#a3e635] dark:shadow-[0_0_8px_rgba(163,230,53,0.55)]",
  },
] as const;

export function AccountingModelCard() {
  return (
    <Card className={TACTILE_CARD_CLASS}>
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(37,99,235,0.08),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(101,163,13,0.07),transparent_34%)] dark:bg-[radial-gradient(circle_at_top_left,rgba(96,165,250,0.10),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(163,230,53,0.08),transparent_34%)]"
      />
      <CardHeader className="relative px-5 pb-3 pt-5">
        <CardTitle className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-600 dark:text-[#8b97ad]">
          Accounting model
        </CardTitle>
        <CardDescription className="max-w-2xl text-sm leading-6 text-slate-600 dark:text-[#9aa7bd]">
          Paperwork now separates request-level inference usage from account-level finance events.
          That keeps provider reporting honest when the biller is OpenRouter, Cloudflare, Bedrock, or another intermediary.
        </CardDescription>
      </CardHeader>
      <CardContent className="relative grid gap-3 px-5 pb-5 md:grid-cols-3">
        {SURFACES.map((surface) => {
          const Icon = surface.icon;
          return (
            <div
              key={surface.title}
              className={cn(
                "rounded-xl border border-slate-200/85 bg-slate-50/80 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-white/[0.07] dark:bg-[#07090d]/85 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
                surface.tone,
              )}
            >
              <div className="mb-3 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                  <Icon className={cn("h-4 w-4", surface.iconTone)} />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-950 dark:text-[#eef2f8]">{surface.title}</div>
                  <div className="text-xs leading-5 text-slate-500 dark:text-[#8b97ad]">{surface.description}</div>
                </div>
              </div>
              <div className="space-y-1.5 text-xs text-slate-600 dark:text-[#8b97ad]">
                {surface.points.map((point) => (
                  <div key={point} className="flex items-center gap-2">
                    <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", surface.dot)} />
                    <span>{point}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
