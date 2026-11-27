import { useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  CircleDot,
  DollarSign,
  Hourglass,
  Inbox,
  MessageSquare,
  PanelRightOpen,
  Rocket,
  ShieldCheck,
  UserRoundCheck,
} from "lucide-react";
import { api } from "../api/client";
import { dashboardApi } from "../api/dashboard";
import { missionsApi } from "../api/missions";
import { operatorDecisionsApi } from "../api/operator-decisions";
import { queryKeys } from "../lib/queryKeys";
import { formatCents } from "../lib/utils";
import { INSPECTOR_TOGGLE_EVENT } from "./PropertiesPanel";
import { normalizeQueueItems } from "./QueuePanel";

export interface CommandKpis {
  runningAgents: number;
  enabledAgents: number;
  inProgressTasks: number;
  blockedTasks: number;
  activeMissions: number;
  monthSpendCents: number;
  monthBudgetCents: number;
  waitCount: number;
}

export function computeWaitCount(pendingDecisions: number, queuedWakeups: number): number {
  return pendingDecisions + queuedWakeups;
}

interface WaitEntry {
  id: string;
  label: string;
  tone: "question" | "approval" | "queue";
}

const TONE_CLASSES: Record<WaitEntry["tone"], string> = {
  question: "border-amber-500/25 bg-amber-500/10 text-amber-800 dark:border-[var(--pw-amber)]/35 dark:bg-[var(--pw-amber-soft)] dark:text-[var(--pw-amber)]",
  approval: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:border-rose-400/35 dark:bg-rose-500/10 dark:text-rose-300",
  queue: "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:border-[var(--pw-cobalt)]/35 dark:bg-[var(--pw-cobalt)]/10 dark:text-[var(--pw-cobalt)]",
};

const ACTION_PILL_CLASS = "inline-flex items-center gap-1.5 rounded-full border border-slate-200/90 bg-slate-50/85 px-2.5 py-1 text-[11px] font-medium text-slate-600 no-underline shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] transition-colors hover:border-[var(--pw-cobalt)]/45 hover:bg-white hover:text-[var(--pw-cobalt)] dark:border-white/[0.09] dark:bg-background dark:text-muted-foreground dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:hover:border-[var(--pw-cobalt)]/45 dark:hover:bg-accent dark:hover:text-[var(--pw-cobalt)]";
const KPI_TILE_CLASS = "block rounded-[10px] border border-slate-200/90 bg-slate-50/80 px-3 py-2.5 no-underline text-inherit shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_1px_2px_rgba(15,23,42,0.03)] transition-colors hover:border-[var(--pw-cobalt)]/45 hover:bg-white dark:hover:border-[var(--pw-cobalt)]/45 dark:hover:bg-accent";

export function DashboardCommandHeader(props: { companyId: string; kpis?: CommandKpis }) {
  const { companyId } = props;

  const { data: summary, isError: summaryError } = useQuery({
    queryKey: queryKeys.dashboard(companyId),
    queryFn: () => dashboardApi.summary(companyId),
    enabled: !props.kpis && Boolean(companyId),
    refetchInterval: 30_000,
  });
  const { data: missionsList, isError: missionsError } = useQuery({
    queryKey: queryKeys.missions.list(companyId),
    queryFn: () => missionsApi.list(companyId),
    enabled: !props.kpis && Boolean(companyId),
    refetchInterval: 30_000,
  });
  const { data: pending } = useQuery({
    queryKey: queryKeys.operatorDecisions.list(companyId, "pending"),
    queryFn: () => operatorDecisionsApi.list(companyId, "pending", 50),
    refetchInterval: 30_000,
    retry: false,
  });
  const { data: queueRaw } = useQuery({
    queryKey: ["ops-console-queue", companyId],
    queryFn: () => api.get<unknown>(`/companies/${companyId}/ops-console/queue`),
    refetchInterval: 15_000,
    retry: false,
  });

  const hasSummary = Boolean(props.kpis || summary);
  const hasMissions = Boolean(props.kpis || missionsList);
  const summaryPlaceholderSub = summaryError ? "조회 실패" : "불러오는 중";

  const kpis: CommandKpis = props.kpis ?? {
    runningAgents: summary?.agents.running ?? 0,
    enabledAgents: summary
      ? summary.agents.active + summary.agents.running + summary.agents.paused + summary.agents.error
      : 0,
    inProgressTasks: summary?.tasks.inProgress ?? 0,
    blockedTasks: summary?.tasks.blocked ?? 0,
    activeMissions: missionsList?.filter((m) => m.status === "active").length ?? 0,
    monthSpendCents: summary?.costs.monthSpendCents ?? 0,
    monthBudgetCents: summary?.costs.monthBudgetCents ?? 0,
    waitCount: summary ? summary.pendingApprovals + summary.budgets.pendingApprovals : 0,
  };

  const queueItems = useMemo(() => normalizeQueueItems(queueRaw), [queueRaw]);
  const pendingCards = pending?.data ?? [];
  const waitCount = computeWaitCount(pendingCards.length, queueItems.length);
  const hasMore = Boolean(pending?.page?.nextCursor);
  const waitDisplay = pending ? `${waitCount}${hasMore ? "+" : ""}` : hasSummary ? String(kpis.waitCount) : "—";

  const waits = useMemo<WaitEntry[]>(() => {
    const entries: WaitEntry[] = pendingCards.slice(0, 6).map((d) => ({
      id: `d-${d.id}`,
      label: d.title,
      tone: d.interactionType === "action" ? "approval" : "question",
    }));
    for (const item of queueItems.slice(0, Math.max(0, 6 - entries.length))) {
      entries.push({
        id: `q-${item.id}`,
        label: item.payload?.message ?? item.prompt ?? item.reason ?? item.id,
        tone: "queue",
      });
    }
    return entries;
  }, [pendingCards, queueItems]);

  const tiles = [
    { icon: Bot, label: "가동 에이전트", value: hasSummary ? String(kpis.runningAgents) : "—", sub: hasSummary ? `${kpis.enabledAgents} 활성` : summaryPlaceholderSub, to: "/agents" },
    { icon: CircleDot, label: "진행 작업", value: hasSummary ? String(kpis.inProgressTasks) : "—", sub: hasSummary ? `${kpis.blockedTasks} 차단됨` : summaryPlaceholderSub, to: "/issues" },
    { icon: Rocket, label: "활성 미션", value: hasMissions ? String(kpis.activeMissions) : "—", sub: hasMissions ? "missions" : (missionsError ? "조회 실패" : "불러오는 중"), to: "/missions" },
    { icon: DollarSign, label: "월간 비용", value: hasSummary ? formatCents(kpis.monthSpendCents) : "—", sub: hasSummary ? (kpis.monthBudgetCents > 0 ? `예산 ${formatCents(kpis.monthBudgetCents)}` : "무제한") : summaryPlaceholderSub, to: "/costs" },
    { icon: Hourglass, label: "대기/차단 현황", value: waitDisplay, sub: pending ? `결정 ${pendingCards.length}${hasMore ? "+" : ""} · 큐 ${queueItems.length}` : (hasSummary ? "승인+큐" : summaryPlaceholderSub), to: "/human-operator" },
  ];

  return (
    <section
      aria-label="명령 헤더"
      className="tactile-card space-y-3 rounded-[12px] border border-slate-200/90 bg-white p-3.5 tabular-nums text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-card dark:bg-none dark:text-card-foreground dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-700/30 bg-emerald-700/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:border-emerald-300/35 dark:bg-emerald-300/10 dark:text-emerald-300">
          <Rocket className="h-3.5 w-3.5" />
          실시간 운영 현황
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link to="/human-operator" className={ACTION_PILL_CLASS}>
            <UserRoundCheck className="h-3.5 w-3.5" />
            결정함{waitCount > 0 ? ` ${waitDisplay}` : ""}
          </Link>
          <Link to="/worktree/rules" className={ACTION_PILL_CLASS}>
            <ShieldCheck className="h-3.5 w-3.5" />
            Hermit Gate · 실행 규칙
          </Link>
          <Link to="/channels" className={ACTION_PILL_CLASS}>
            <MessageSquare className="h-3.5 w-3.5" />
            채널 협업 보드
          </Link>
          <button
            type="button"
            onClick={() => typeof window !== "undefined" && window.dispatchEvent(new CustomEvent(INSPECTOR_TOGGLE_EVENT))}
            className={`${ACTION_PILL_CLASS} cursor-pointer max-md:hidden`}
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
            우측 인스펙터
          </button>
        </div>
      </div>

      <div className="openbot-kpi-grid">
        {tiles.map((tile) => (
          <Link
            key={tile.label}
            to={tile.to}
            className={KPI_TILE_CLASS}
          >
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-muted-foreground">
              <tile.icon className="h-3.5 w-3.5 text-[var(--pw-cobalt)]" />
              {tile.label}
            </div>
            <div className="mt-1 text-lg font-semibold leading-none tabular-nums text-slate-950 dark:text-card-foreground">
              {tile.value}
            </div>
            <div className="mt-1 text-[10px] tabular-nums text-slate-500 dark:text-muted-foreground">{tile.sub}</div>
          </Link>
        ))}
      </div>

      {waits.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto rounded-[10px] border border-slate-200/80 bg-slate-50/75 px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-white/[0.07] dark:bg-background dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-slate-500 dark:text-muted-foreground">
            <Inbox className="h-3.5 w-3.5" />
            대기열
          </span>
          {waits.map((w) => (
            <Link
              key={w.id}
              to={w.tone === "queue" ? "/worktree/rules" : "/human-operator"}
              className={`shrink-0 max-w-56 truncate rounded-full border px-2 py-0.5 text-[10px] font-medium no-underline ${TONE_CLASSES[w.tone]}`}
              title={w.label}
            >
              {w.label}
            </Link>
          ))}
          {waitCount > waits.length && (
            <Link to="/human-operator" className="shrink-0 text-[10px] text-[var(--pw-cobalt)] underline underline-offset-2 transition-colors hover:text-emerald-700 dark:text-[var(--pw-cobalt)] dark:hover:text-emerald-300">
              +{waitCount - waits.length} 더 보기
            </Link>
          )}
        </div>
      )}

      <p className="text-[10px] text-slate-500 dark:text-muted-foreground">
        사이드바 경계를 드래그하면 뷰가 스냅됩니다 (compact · peek · expanded).
      </p>
    </section>
  );
}
