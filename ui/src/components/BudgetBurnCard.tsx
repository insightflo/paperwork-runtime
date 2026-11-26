import { Link } from "@/lib/router";
import { agentUrl, formatCents } from "../lib/utils";
import type { Agent } from "@paperclipai/shared";

export function budgetUtilization(spent: number, budget: number): number | null {
  if (budget <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((spent / budget) * 100)));
}

export function budgetUtilizationTone(percent: number): string {
  if (percent >= 100) return "bg-[#dc2626] shadow-[0_0_6px_rgba(220,38,38,0.3)] dark:bg-[#fb7185] dark:shadow-[0_0_6px_rgba(251,113,133,0.45)]";
  if (percent >= 80) return "bg-[#d97706] shadow-[0_0_6px_rgba(217,119,6,0.3)] dark:bg-[#f59e0b] dark:shadow-[0_0_6px_rgba(245,158,11,0.45)]";
  return "bg-[#65a30d] shadow-[0_0_6px_rgba(101,163,13,0.28)] dark:bg-[#a3e635] dark:shadow-[0_0_6px_rgba(163,230,53,0.5)]";
}

const CARD_CLASS = "tactile-card min-w-0 overflow-hidden rounded-[12px] border border-slate-200/90 bg-white tabular-nums text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]";
const BAR_TRACK_CLASS = "h-1.5 overflow-hidden rounded-sm border border-slate-200/80 bg-slate-100/90 dark:border-white/[0.07] dark:bg-[#07090d]";

export function BudgetBurnCard({ agents, monthSpendCents, monthBudgetCents }: { agents: Agent[]; monthSpendCents: number; monthBudgetCents: number }) {
  const spenders = agents
    .filter((agent) => agent.spentMonthlyCents > 0)
    .sort((a, b) => b.spentMonthlyCents - a.spentMonthlyCents)
    .slice(0, 6);
  const maxSpend = spenders[0]?.spentMonthlyCents ?? 0;
  const companyPercent = budgetUtilization(monthSpendCents, monthBudgetCents);
  return (
    <section className={CARD_CLASS} aria-label="Budget burn">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200/80 px-3 py-2 dark:border-white/[0.07]">
        <h3 className="text-xs font-semibold text-slate-950 dark:text-[#edf2fb]">Budget burn by agent</h3>
        <span className="text-[11px] text-slate-500 dark:text-[#8f9db3]">This month</span>
      </header>
      {spenders.length === 0 ? (
        <p className="px-3 py-3 text-sm text-slate-500 dark:text-[#8f9db3]">No agent spend recorded this month.</p>
      ) : (
        <ul className="divide-y divide-slate-200/70 dark:divide-white/[0.06]">
          {spenders.map((agent) => {
            const share = monthSpendCents > 0 ? Math.round((agent.spentMonthlyCents / monthSpendCents) * 100) : 0;
            const percent = budgetUtilization(agent.spentMonthlyCents, agent.budgetMonthlyCents);
            return (
              <li key={agent.id} className="px-3 py-1.5">
                <Link to={agentUrl(agent)} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs no-underline text-inherit transition-colors hover:text-[#2563eb] dark:hover:text-[#60a5fa]">
                  <span className="min-w-0 truncate">{agent.name}</span>
                  <span className="shrink-0 tabular-nums">
                    <span className="font-mono font-semibold text-slate-950 dark:text-[#edf2fb]">{formatCents(agent.spentMonthlyCents)}</span>
                    <span className="ml-1.5 text-[11px] text-slate-500 dark:text-[#8f9db3]">{share}%</span>
                  </span>
                </Link>
                <div className={`mt-1 ${BAR_TRACK_CLASS}`} aria-hidden="true">
                  <div className="h-full rounded-sm bg-[#2563eb] shadow-[0_0_6px_rgba(37,99,235,0.28)] dark:bg-[#60a5fa] dark:shadow-[0_0_6px_rgba(96,165,250,0.45)]" style={{ width: `${maxSpend > 0 ? (agent.spentMonthlyCents / maxSpend) * 100 : 0}%` }} />
                </div>
                <p className="mt-0.5 text-[10px] text-slate-500 tabular-nums dark:text-[#8f9db3]">
                  {percent === null ? "No monthly cap" : `${percent}% of ${formatCents(agent.budgetMonthlyCents)} cap`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <footer className="border-t border-slate-200/80 px-3 py-2 text-xs dark:border-white/[0.07]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-slate-500 dark:text-[#8f9db3]">Total month to date</span>
          <span className="font-mono font-semibold tabular-nums text-slate-950 dark:text-[#edf2fb]">{formatCents(monthSpendCents)}</span>
        </div>
        {companyPercent !== null && (
          <>
            <div className={`mt-1.5 ${BAR_TRACK_CLASS}`} aria-hidden="true">
              <div className={`h-full rounded-sm ${budgetUtilizationTone(companyPercent)}`} style={{ width: `${companyPercent}%` }} />
            </div>
            <p className="mt-0.5 text-[10px] text-slate-500 tabular-nums dark:text-[#8f9db3]">{companyPercent}% of {formatCents(monthBudgetCents)} budget</p>
          </>
        )}
      </footer>
    </section>
  );
}
