import { Link } from "@/lib/router";
import { agentUrl } from "../lib/utils";
import type { Agent } from "@paperclipai/shared";
import { budgetUtilization, budgetUtilizationTone } from "./BudgetBurnCard";

const AGENT_HEALTH_ORDER: Record<string, number> = { error: 0, running: 1, paused: 2, active: 3, idle: 3 };

const CARD_CLASS = "@container tactile-card min-w-0 overflow-hidden rounded-[12px] border border-slate-200/90 bg-white tabular-nums text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]";

function agentStatusDot(status: string): string {
  if (status === "error") return "bg-[#dc2626] shadow-[0_0_6px_rgba(220,38,38,0.35)] dark:bg-[#fb7185]";
  if (status === "running") return "bg-[#65a30d] shadow-[0_0_6px_rgba(101,163,13,0.35)] dark:bg-[#a3e635] dark:shadow-[0_0_8px_rgba(163,230,53,0.55)]";
  if (status === "paused") return "bg-[#d97706] shadow-[0_0_6px_rgba(217,119,6,0.32)] dark:bg-[#f59e0b] dark:shadow-[0_0_8px_rgba(245,158,11,0.5)]";
  return "bg-slate-400/70 dark:bg-[#627089]";
}

export function FleetHealthCard({ agents }: { agents: Agent[] }) {
  const ranked = [...agents].sort((a, b) => {
    const order = (AGENT_HEALTH_ORDER[a.status] ?? 4) - (AGENT_HEALTH_ORDER[b.status] ?? 4);
    return order !== 0 ? order : (b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0) - (a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0);
  });
  const counts = { running: 0, idle: 0, paused: 0, error: 0 };
  for (const agent of agents) {
    if (agent.status === "running") counts.running += 1;
    else if (agent.status === "active" || agent.status === "idle") counts.idle += 1;
    else if (agent.status === "paused") counts.paused += 1;
    else if (agent.status === "error") counts.error += 1;
  }
  return (
    <section className={CARD_CLASS} aria-label="Agent fleet health">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-200/80 px-3 py-2 dark:border-white/[0.07]">
        <h3 className="text-xs font-semibold text-slate-950 dark:text-[#edf2fb]">Agent fleet health</h3>
        <span className="text-[11px] text-slate-500 tabular-nums dark:text-[#8f9db3]">
          {counts.running} running · {counts.idle} idle · {counts.paused} paused · {counts.error} error
        </span>
      </header>
      {ranked.length === 0 ? (
        <p className="px-3 py-3 text-sm text-slate-500 dark:text-[#8f9db3]">No agents yet.</p>
      ) : (
        <ul className="divide-y divide-slate-200/70 dark:divide-white/[0.06]">
          {ranked.slice(0, 8).map((agent) => {
            const percent = budgetUtilization(agent.spentMonthlyCents, agent.budgetMonthlyCents);
            return (
              <li key={agent.id}>
                <Link
                  to={agentUrl(agent)}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs no-underline text-inherit transition-colors hover:bg-slate-50/85 dark:hover:bg-white/[0.035] @[19rem]:grid-cols-[minmax(0,1fr)_4.5rem_5rem]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${agentStatusDot(agent.status)}`} />
                    <span className="min-w-0 truncate">{agent.name}</span>
                  </span>
                  {/* Narrow columns: the bar drops to its own full-width row so the
                      agent name keeps the width. Wide: single row like the mockup. */}
                  <span className="col-span-2 row-start-2 h-1.5 overflow-hidden rounded-sm border border-slate-200/80 bg-slate-100/90 dark:border-white/[0.07] dark:bg-[#07090d] @[19rem]:col-span-1 @[19rem]:col-start-2 @[19rem]:row-start-1" aria-hidden="true">
                    <span className={`block h-full rounded-sm ${percent === null ? "bg-transparent" : budgetUtilizationTone(percent)}`} style={{ width: `${percent ?? 0}%` }} />
                  </span>
                  <span className="col-start-2 row-start-1 truncate text-right text-slate-500 tabular-nums dark:text-[#8f9db3] @[19rem]:col-start-3">
                    {percent === null ? agent.status : `${percent}% · ${agent.status}`}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {ranked.length > 8 && (
        <Link to="/agents" className="block border-t border-slate-200/80 px-3 py-1.5 text-xs text-slate-500 no-underline transition-colors hover:text-[#2563eb] dark:border-white/[0.07] dark:text-[#8f9db3] dark:hover:text-[#60a5fa]">
          +{ranked.length - 8} more agents
        </Link>
      )}
    </section>
  );
}
