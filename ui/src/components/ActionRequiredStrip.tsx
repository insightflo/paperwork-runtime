import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { agentUrl } from "../lib/utils";
import type { Agent, DashboardSummary, Issue } from "@paperclipai/shared";

const ACTION_CHIP = "inline-flex h-7 min-w-0 max-w-[16rem] items-center gap-1.5 truncate rounded-md border border-slate-200/90 bg-white/85 px-2 text-xs no-underline text-inherit shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] transition-colors hover:border-[#f59e0b]/50 hover:bg-white dark:border-white/[0.08] dark:bg-[#07090d] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:hover:border-[#f59e0b]/50 dark:hover:bg-[#0b0f18]";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Inline strip for anything waiting on the operator. Shown only when non-empty. */
export function ActionRequiredStrip({ data, agents, issues }: { data: DashboardSummary; agents?: Agent[]; issues?: Issue[] }) {
  const approvals = data.pendingApprovals + data.budgets.pendingApprovals;
  const erroredAgents = (agents ?? []).filter((agent) => agent.status === "error");
  const blockedIssues = issues
    ? issues.filter((issue) => issue.status === "blocked").sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    : [];
  const chips: ReactNode[] = [];

  if (approvals > 0) {
    chips.push(
      <Link key="approvals" to="/approvals" className={ACTION_CHIP} title={`${plural(approvals, "approval")} waiting`}>
        <span className="font-mono font-semibold text-[#b45309] tabular-nums dark:text-[#f59e0b]">{approvals}</span>
        <span className="truncate">{approvals === 1 ? "approval waiting" : "approvals waiting"}</span>
      </Link>,
    );
  }
  if (data.budgets.activeIncidents > 0) {
    chips.push(
      <Link key="incidents" to="/costs" className={ACTION_CHIP} title={`Budget incidents · ${plural(data.budgets.pausedProjects, "work context")} paused`}>
        <span className="font-mono font-semibold text-[#dc2626] tabular-nums dark:text-[#fb7185]">{data.budgets.activeIncidents}</span>
        <span className="truncate">budget {data.budgets.activeIncidents === 1 ? "incident" : "incidents"} · {plural(data.budgets.pausedAgents, "agent")} paused{data.budgets.pausedProjects > 0 ? ` · ${plural(data.budgets.pausedProjects, "context")}` : ""}</span>
      </Link>,
    );
  }
  for (const agent of erroredAgents.slice(0, 2)) {
    chips.push(
      <Link key={`agent:${agent.id}`} to={agentUrl(agent)} className={ACTION_CHIP}>
        <span className="font-mono font-semibold text-[#dc2626] dark:text-[#fb7185]">error</span>
        <span className="truncate">{agent.name}</span>
      </Link>,
    );
  }
  if (erroredAgents.length === 0 && data.agents.error > 0) {
    chips.push(
      <Link key="agent-errors" to="/agents" className={ACTION_CHIP}>
        <span className="font-mono font-semibold text-[#dc2626] tabular-nums dark:text-[#fb7185]">{data.agents.error}</span>
        <span className="truncate">{data.agents.error === 1 ? "agent has" : "agents have"} errors</span>
      </Link>,
    );
  }
  for (const issue of blockedIssues.slice(0, 3)) {
    chips.push(
      <Link key={`issue:${issue.id}`} to={`/issues/${issue.identifier ?? issue.id}`} className={ACTION_CHIP} title={issue.title}>
        <span className="font-mono font-semibold text-[#b45309] dark:text-[#f59e0b]">{issue.identifier ?? issue.id.slice(0, 8)}</span>
        <span className="truncate">{issue.title}</span>
      </Link>,
    );
  }
  if (blockedIssues.length > 3 || (!issues && data.tasks.blocked > 0)) {
    const more = issues ? blockedIssues.length - 3 : data.tasks.blocked;
    chips.push(
      <Link key="blocked" to="/issues" className={ACTION_CHIP}>
        <span className="font-mono font-semibold text-[#b45309] tabular-nums dark:text-[#f59e0b]">{more}</span>
        <span className="truncate">blocked {more === 1 ? "work" : "work items"}</span>
      </Link>,
    );
  }
  if (chips.length === 0) return null;

  return (
    <section
      aria-label="Action required"
      data-testid="dashboard-action-required"
      className="tactile-card flex flex-wrap items-center gap-2 rounded-[12px] border border-amber-500/35 bg-amber-500/[0.06] px-3 py-2 tabular-nums text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-[#f59e0b]/35 dark:bg-[#0e131d] dark:bg-none dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]"
    >
      <span className="inline-flex shrink-0 items-center gap-2 text-xs font-semibold text-[#b45309] dark:text-[#f59e0b]">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60 motion-reduce:animate-none dark:bg-[#f59e0b]" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.45)] dark:bg-[#f59e0b]" />
        </span>
        Action required
      </span>
      {chips}
      <Link to="/inbox" className="ml-auto shrink-0 text-xs font-medium text-[#2563eb] underline underline-offset-2 transition-colors hover:text-[#b45309] dark:text-[#60a5fa] dark:hover:text-[#f59e0b]">
        Review in Inbox →
      </Link>
    </section>
  );
}
