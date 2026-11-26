import { useState } from "react";
import type { BudgetIncident } from "@paperclipai/shared";
import { AlertOctagon, ArrowUpRight, PauseCircle } from "lucide-react";
import { formatCents } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { humanLabel } from "../lib/humanLabels";

const TACTILE_ALERT_CARD_CLASS =
  "tactile-card overflow-hidden border-red-200/90 bg-red-50/70 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-red-500/30 dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)] tabular-nums";

function centsInputValue(value: number) {
  return (value / 100).toFixed(2);
}

function parseDollarInput(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export function BudgetIncidentCard({
  incident,
  onRaiseAndResume,
  onKeepPaused,
  isMutating,
}: {
  incident: BudgetIncident;
  onRaiseAndResume: (amountCents: number) => void;
  onKeepPaused: () => void;
  isMutating?: boolean;
}) {
  const lang = useCompanyLanguage();
  const scope = humanLabel(lang, "budgetScope", incident.scopeType).label;
  const [draftAmount, setDraftAmount] = useState(
    centsInputValue(Math.max(incident.amountObserved + 1000, incident.amountLimit)),
  );
  const parsed = parseDollarInput(draftAmount);

  return (
    <Card className={TACTILE_ALERT_CARD_CLASS}>
      <CardHeader className="px-5 pb-3 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-red-700 dark:text-red-200/80">
              {L(lang, { en: `${scope} budget hard stop`, ko: `${scope} 예산 초과 자동 정지` })}
            </div>
            <CardTitle className="mt-1 text-base text-red-950 dark:text-red-50">{incident.scopeName}</CardTitle>
            <CardDescription className="mt-1 text-red-800/80 dark:text-red-100/70">
              {L(lang, { en: `Spending reached ${formatCents(incident.amountObserved)} against a limit of ${formatCents(incident.amountLimit)}.`, ko: `지출 ${formatCents(incident.amountObserved)}이 상한 ${formatCents(incident.amountLimit)}에 도달해 작업이 자동으로 멈췄습니다.` })}
            </CardDescription>
          </div>
          <div className="rounded-lg border border-red-300/70 bg-white/80 p-2 text-red-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-200 dark:shadow-none">
            <AlertOctagon className="h-4 w-4" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        <div className="flex items-start gap-2 rounded-xl border border-red-200/90 bg-white/75 px-3 py-2 text-sm text-red-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-red-400/20 dark:bg-red-500/10 dark:text-red-50/90 dark:shadow-none">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {incident.scopeType === "project"
              ? L(lang, { en: "Work-context execution is paused. New work in this context will not start until you resolve the budget incident.", ko: "이 프로젝트의 작업 실행이 정지되었습니다. 예산 초과를 해결하기 전에는 새 작업이 시작되지 않습니다." })
              : L(lang, { en: "This scope is paused. New heartbeats will not start until you resolve the budget incident.", ko: "이 범위의 작업이 정지되었습니다. 예산 초과를 해결하기 전에는 새 정기 실행이 시작되지 않습니다." })}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200/85 bg-white/85 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.07] dark:bg-[#07090d]/85 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
          <label className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">
            {L(lang, { en: "New budget (USD)", ko: "새 상한(달러)" })}
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Input
              value={draftAmount}
              onChange={(event) => setDraftAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className="border-slate-200/90 bg-white font-mono tabular-nums text-slate-950 shadow-none focus-visible:border-blue-500 dark:border-white/[0.1] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:focus-visible:border-[#60a5fa]"
            />
            <Button
              className="gap-2 bg-lime-600 font-semibold text-white hover:bg-lime-600/90 dark:bg-[#a3e635] dark:text-[#0b0f05] dark:hover:bg-[#a3e635]/90"
              disabled={isMutating || parsed === null || parsed <= incident.amountObserved}
              onClick={() => {
                if (typeof parsed === "number") onRaiseAndResume(parsed);
              }}
            >
              <ArrowUpRight className="h-4 w-4" />
              {isMutating ? L(lang, { en: "Applying…", ko: "적용 중…" }) : L(lang, { en: "Raise budget & resume", ko: "상한 올리고 재개" })}
            </Button>
          </div>
          {parsed !== null && parsed <= incident.amountObserved ? (
            <p className="mt-2 text-xs text-red-700 dark:text-red-200/80">
              {L(lang, { en: "The new budget must exceed current observed spend.", ko: "새 상한은 현재 지출보다 커야 합니다." })}
            </p>
          ) : null}
        </div>

        <div className="flex justify-end">
          <Button
            variant="ghost"
            className="text-slate-500 hover:bg-white/70 hover:text-slate-900 dark:text-[#8b97ad] dark:hover:bg-white/[0.06] dark:hover:text-[#eef2f8]"
            disabled={isMutating}
            onClick={onKeepPaused}
          >
            {L(lang, { en: "Keep paused", ko: "정지 유지" })}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
