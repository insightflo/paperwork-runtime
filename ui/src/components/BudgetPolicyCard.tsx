import { useEffect, useState } from "react";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { AlertTriangle, PauseCircle, ShieldAlert, Wallet } from "lucide-react";
import { cn, formatCents } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const TACTILE_CARD_CLASS =
  "tactile-card overflow-hidden border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)] tabular-nums";

const METRIC_TILE_CLASS =
  "rounded-xl border border-slate-200/85 bg-slate-50/80 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-white/[0.07] dark:bg-[#07090d]/85 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";

function centsInputValue(value: number) {
  return (value / 100).toFixed(2);
}

function parseDollarInput(value: string) {
  const normalized = value.trim();
  if (normalized.length === 0) return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function windowLabel(windowKind: BudgetPolicySummary["windowKind"]) {
  return windowKind === "lifetime" ? "Lifetime budget" : "Monthly UTC budget";
}

function statusTone(status: BudgetPolicySummary["status"]) {
  if (status === "hard_stop") return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (status === "warning") return "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]";
  return "border-lime-500/30 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#a3e635]";
}

function statusTextTone(status: BudgetPolicySummary["status"]) {
  if (status === "hard_stop") return "text-red-700 dark:text-red-300";
  if (status === "warning") return "text-amber-700 dark:text-[#f59e0b]";
  return "text-lime-700 dark:text-[#a3e635]";
}

export function BudgetPolicyCard({
  summary,
  onSave,
  isSaving,
  compact = false,
  variant = "card",
}: {
  summary: BudgetPolicySummary;
  onSave?: (amountCents: number) => void;
  isSaving?: boolean;
  compact?: boolean;
  variant?: "card" | "plain";
}) {
  const [draftBudget, setDraftBudget] = useState(centsInputValue(summary.amount));

  useEffect(() => {
    setDraftBudget(centsInputValue(summary.amount));
  }, [summary.amount]);

  const parsedDraft = parseDollarInput(draftBudget);
  const canSave = typeof parsedDraft === "number" && parsedDraft !== summary.amount && Boolean(onSave);
  const progress = summary.amount > 0 ? Math.min(100, summary.utilizationPercent) : 0;
  const StatusIcon = summary.status === "hard_stop" ? ShieldAlert : summary.status === "warning" ? AlertTriangle : Wallet;
  const isPlain = variant === "plain";

  const observedBudgetGrid = isPlain ? (
    <div className="grid gap-6 sm:grid-cols-2">
      <div>
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">Observed</div>
        <div className="mt-2 text-xl font-semibold tabular-nums text-slate-950 dark:text-[#eef2f8]">{formatCents(summary.observedAmount)}</div>
        <div className="mt-1 text-xs text-slate-500 dark:text-[#8b97ad]">
          {summary.amount > 0 ? `${summary.utilizationPercent}% of limit` : "No cap configured"}
        </div>
      </div>
      <div>
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">Budget</div>
        <div className="mt-2 text-xl font-semibold tabular-nums text-slate-950 dark:text-[#eef2f8]">
          {summary.amount > 0 ? formatCents(summary.amount) : "Disabled"}
        </div>
        <div className="mt-1 text-xs text-slate-500 dark:text-[#8b97ad]">
          Soft alert at {summary.warnPercent}%{summary.paused && summary.pauseReason ? ` · ${summary.pauseReason} pause` : ""}
        </div>
      </div>
    </div>
  ) : (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className={METRIC_TILE_CLASS}>
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">Observed</div>
        <div className="mt-2 text-xl font-semibold tabular-nums text-slate-950 dark:text-[#eef2f8]">{formatCents(summary.observedAmount)}</div>
        <div className="mt-1 text-xs text-slate-500 dark:text-[#8b97ad]">
          {summary.amount > 0 ? `${summary.utilizationPercent}% of limit` : "No cap configured"}
        </div>
      </div>
      <div className={METRIC_TILE_CLASS}>
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">Budget</div>
        <div className="mt-2 text-xl font-semibold tabular-nums text-slate-950 dark:text-[#eef2f8]">
          {summary.amount > 0 ? formatCents(summary.amount) : "Disabled"}
        </div>
        <div className="mt-1 text-xs text-slate-500 dark:text-[#8b97ad]">
          Soft alert at {summary.warnPercent}%{summary.paused && summary.pauseReason ? ` · ${summary.pauseReason} pause` : ""}
        </div>
      </div>
    </div>
  );

  const progressSection = (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-[#8b97ad]">
        <span>Remaining</span>
        <span className="tabular-nums">{summary.amount > 0 ? formatCents(summary.remainingAmount) : "Unlimited"}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full border border-slate-200/85 bg-slate-100 dark:border-white/[0.07] dark:bg-[#07090d]">
        <div
          className={cn(
            "h-full rounded-full transition-[width,background-color] duration-200",
            summary.status === "hard_stop"
              ? "bg-red-500 dark:bg-red-400"
              : summary.status === "warning"
                ? "bg-amber-500 dark:bg-[#f59e0b] dark:shadow-[0_0_7px_rgba(245,158,11,0.5)]"
                : "bg-lime-500 dark:bg-[#a3e635] dark:shadow-[0_0_8px_rgba(163,230,53,0.55)]",
          )}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );

  const pausedPane = summary.paused ? (
    <div className="flex items-start gap-2 rounded-xl border border-red-200/90 bg-red-50/80 px-3 py-2 text-sm text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">
      <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        {summary.scopeType === "project"
          ? "Execution is paused for this project until the budget is raised or the incident is dismissed."
          : "Heartbeats are paused for this scope until the budget is raised or the incident is dismissed."}
      </div>
    </div>
  ) : null;

  const saveSection = onSave ? (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end", isPlain ? "" : "rounded-xl border border-slate-200/85 bg-slate-50/80 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-white/[0.07] dark:bg-[#07090d]/85 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]")}>
      <div className="min-w-0 flex-1">
        <label className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">
          Budget (USD)
        </label>
        <Input
          value={draftBudget}
          onChange={(event) => setDraftBudget(event.target.value)}
          className="mt-2 border-slate-200/90 bg-white font-mono tabular-nums text-slate-950 shadow-none focus-visible:border-blue-500 dark:border-white/[0.1] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:focus-visible:border-[#60a5fa]"
          inputMode="decimal"
          placeholder="0.00"
        />
      </div>
      <Button
        className="bg-blue-600 font-semibold text-white hover:bg-blue-600/90 dark:bg-[#60a5fa] dark:text-[#07111f] dark:hover:bg-[#60a5fa]/90"
        onClick={() => {
          if (typeof parsedDraft === "number" && onSave) onSave(parsedDraft);
        }}
        disabled={!canSave || isSaving || parsedDraft === null}
      >
        {isSaving ? "Saving..." : summary.amount > 0 ? "Update budget" : "Set budget"}
      </Button>
    </div>
  ) : null;

  if (isPlain) {
    return (
      <div className="space-y-6 text-slate-950 dark:text-[#eef2f8] tabular-nums">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">
              {summary.scopeType}
            </div>
            <div className="mt-2 text-xl font-semibold text-slate-950 dark:text-[#eef2f8]">{summary.scopeName}</div>
            <div className="mt-2 text-sm text-slate-500 dark:text-[#8b97ad]">{windowLabel(summary.windowKind)}</div>
          </div>
          <div
            className={cn(
              "inline-flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.16em]",
              statusTextTone(summary.status),
            )}
          >
            <StatusIcon className="h-3.5 w-3.5" />
            {summary.paused ? "Paused" : summary.status === "warning" ? "Warning" : summary.status === "hard_stop" ? "Hard stop" : "Healthy"}
          </div>
        </div>

        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {parsedDraft === null ? (
          <p className="text-xs text-red-700 dark:text-red-300">Enter a valid non-negative dollar amount.</p>
        ) : null}
      </div>
    );
  }

  return (
    <Card className={TACTILE_CARD_CLASS}>
      <CardHeader className={cn("gap-3", compact ? "px-4 pb-2 pt-4" : "px-5 pb-3 pt-5")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">
              {summary.scopeType}
            </div>
            <CardTitle className="mt-1 text-base text-slate-950 dark:text-[#eef2f8]">{summary.scopeName}</CardTitle>
            <CardDescription className="mt-1 text-slate-500 dark:text-[#8b97ad]">{windowLabel(summary.windowKind)}</CardDescription>
          </div>
          <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.16em]", statusTone(summary.status))}>
            <StatusIcon className="h-3.5 w-3.5" />
            {summary.paused ? "Paused" : summary.status === "warning" ? "Warning" : summary.status === "hard_stop" ? "Hard stop" : "Healthy"}
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn("space-y-4", compact ? "px-4 pb-4 pt-0" : "px-5 pb-5 pt-0")}>
        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {parsedDraft === null ? (
          <p className="text-xs text-red-700 dark:text-red-300">Enter a valid non-negative dollar amount.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
