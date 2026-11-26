import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { OperatorDecisionActivity } from "../components/OperatorDecisionActivity";
import { History, Search } from "lucide-react";
import { cn } from "../lib/utils";
import type { Agent, ActivityEvent } from "@paperclipai/shared";

export type ActivityCategory = "all" | "agent" | "mission" | "decision" | "worktree";

/* ── Cockpit strip + toolbar vocabulary ──
 * Categories carry a micro status dot so the 1-row strip, the 40px tab group and the
 * DiffBadge pills below all speak the same emerald/amber/crimson/cobalt language. */
const CATEGORY_PILLS: { id: ActivityCategory; label: string; dot: string }[] = [
  { id: "all", label: "전체", dot: "bg-[#5f8dff]" },
  { id: "agent", label: "에이전트", dot: "bg-[#34d399]" },
  { id: "mission", label: "미션", dot: "bg-[#5f8dff]" },
  { id: "decision", label: "결정", dot: "bg-[#fbbf24]" },
  { id: "worktree", label: "워크트리", dot: "bg-[#8b97ad]" },
];

const TAB_CLASS =
  "h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors aria-pressed:bg-[#151b28] aria-pressed:text-[#e6edf7] aria-pressed:shadow-[inset_0_0_0_1px_#242d3f] text-[#8b97ad] hover:text-[#e6edf7]";
const STRIP_CELL_CLASS =
  "cockpit-cell min-w-0 flex-1 justify-center transition-colors hover:bg-[#151b28] hover:text-[#e6edf7]";
const STRIP_CELL_ACTIVE_CLASS = "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_-1px_0_#5f8dff]";

export function categorizeActivityEvent(event: ActivityEvent): Exclude<ActivityCategory, "all"> | null {
  const hay = `${event.entityType} ${event.action}`.toLowerCase();
  if (hay.includes("operator_decision") || hay.includes("decision")) return "decision";
  if (hay.includes("worktree") || hay.includes("workspace")) return "worktree";
  if (hay.includes("mission") || hay.includes("goal")) return "mission";
  if (hay.includes("agent") || hay.includes("heartbeat") || hay.includes("run")) return "agent";
  return null;
}

export interface ActivityDiffBadge {
  from: string;
  to: string;
}

/** Derive a compact "변경 전 → 변경 후" badge from event.details when a from/to pair exists. */
export function extractActivityDiff(details: Record<string, unknown> | null): ActivityDiffBadge | null {
  if (!details) return null;
  const pairs: [string, string][] = [
    ["before", "after"],
    ["from", "to"],
    ["previousStatus", "status"],
  ];
  for (const [fromKey, toKey] of pairs) {
    const from = details[fromKey];
    const to = details[toKey];
    if (from != null && to != null && String(from) !== String(to)) {
      return { from: String(from).slice(0, 40), to: String(to).slice(0, 40) };
    }
  }
  return null;
}

function DiffBadge({ diff }: { diff: ActivityDiffBadge }) {
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono" title="변경 전 → 변경 후">
      <span style={{ color: "var(--openbot-diff-before-text)", backgroundColor: "var(--openbot-diff-before-bg)" }} className="rounded px-1">
        {diff.from}
      </span>
      <span className="text-[#8b97ad]">→</span>
      <span style={{ color: "var(--openbot-diff-after-text)", backgroundColor: "var(--openbot-diff-after-bg)" }} className="rounded px-1">
        {diff.to}
      </span>
    </span>
  );
}

export function Activity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [category, setCategory] = useState<ActivityCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Activity" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [issues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const categoryCounts = useMemo(() => {
    const counts: Record<ActivityCategory, number> = { all: 0, agent: 0, mission: 0, decision: 0, worktree: 0 };
    for (const event of data ?? []) {
      counts.all += 1;
      const key = categorizeActivityEvent(event);
      if (key) counts[key] += 1;
    }
    return counts;
  }, [data]);

  const filtered = useMemo(() => {
    let events = data ?? [];
    if (category !== "all") {
      events = events.filter((e) => categorizeActivityEvent(e) === category);
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      events = events.filter((e) =>
        `${e.action} ${e.entityType} ${e.actorId} ${e.agentId ?? ""} ${JSON.stringify(e.details ?? {})}`
          .toLowerCase()
          .includes(q),
      );
    }
    return events;
  }, [data, category, searchQuery]);

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message="Select a company to view activity." />;
  }
  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-2 tabular-nums">
      {/* 1-row 5-cell cockpit strip: event totals per category double as filter shortcuts */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="활동 유형별 건수">
        {CATEGORY_PILLS.map((pill) => {
          const active = category === pill.id;
          return (
            <button
              key={pill.id}
              type="button"
              aria-pressed={active}
              onClick={() => setCategory(pill.id)}
              className={cn(STRIP_CELL_CLASS, active && STRIP_CELL_ACTIVE_CLASS)}
            >
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${pill.dot}`} />
              <span className="truncate uppercase tracking-wide">{pill.label}</span>
              <b className="ml-1">{data ? categoryCounts[pill.id] : "—"}</b>
            </button>
          );
        })}
        <div className="cockpit-cell min-w-0 shrink-0">
          <span className="truncate uppercase tracking-wide">표시</span>
          <b className="ml-1 text-[#5f8dff]">{filtered.length}</b>
        </div>
      </div>

      {/* Tight 40px toolbar: category tabs + local search */}
      <div className="cockpit-toolbar h-10 rounded-md border border-[#242d3f] bg-[#111622] px-2">
        <div role="group" aria-label="활동 유형 필터" className="flex shrink-0 items-center gap-0.5 rounded-md border border-[#242d3f] bg-[#0b0e14] p-0.5">
          {CATEGORY_PILLS.map((pill) => (
            <button
              key={pill.id}
              type="button"
              aria-pressed={category === pill.id}
              onClick={() => setCategory(pill.id)}
              className={TAB_CLASS}
            >
              {pill.label}
              <span className={cn("ml-1 font-mono text-[10px] tabular-nums", category === pill.id ? "text-[#5f8dff]" : "text-[#8b97ad]")}>
                {data ? categoryCounts[pill.id] : "—"}
              </span>
            </button>
          ))}
        </div>

        <div className="relative ml-2 min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8b97ad]" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="활동 검색…"
            aria-label="활동 검색"
            className="h-7 w-full rounded-md border border-[#242d3f] bg-[#0b0e14] pl-7 pr-2 text-xs text-[#e6edf7] outline-none placeholder:text-[#8b97ad] focus:border-[#5f8dff] focus:ring-[#5f8dff]/40"
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {filtered.length === 0 && (
        <EmptyState icon={History} message={searchQuery || category !== "all" ? "조건에 맞는 활동이 없습니다." : "No activity yet."} />
      )}

      {filtered.length > 0 && (
        <div className="divide-y divide-[#242d3f] overflow-hidden rounded-md border border-[#242d3f] bg-[#111622] [&>*]:hover:bg-[#151b28] [&_article]:px-3 [&_article]:py-1.5">
          {filtered.map((event) => {
            const diff = extractActivityDiff(event.details);
            const row = event.action.startsWith("operator_decision.") ? (
              <OperatorDecisionActivity key={event.id} event={event} />
            ) : (
              <ActivityRow
                key={event.id}
                event={event}
                agentMap={agentMap}
                entityNameMap={entityNameMap}
                entityTitleMap={entityTitleMap}
              />
            );
            return diff ? (
              <div key={event.id} className="relative">
                {row}
                <div className="px-3 pb-1.5 -mt-1">
                  <DiffBadge diff={diff} />
                </div>
              </div>
            ) : row;
          })}
        </div>
      )}
    </div>
  );
}
