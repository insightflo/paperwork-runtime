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

const TONE_VARS: Record<WaitEntry["tone"], { fg: string; bg: string }> = {
  question: { fg: "--openbot-wait-question", bg: "--openbot-wait-question-soft" },
  approval: { fg: "--openbot-wait-approval", bg: "--openbot-wait-approval-soft" },
  queue: { fg: "--openbot-info-text", bg: "--openbot-info-soft" },
};

export function DashboardCommandHeader(props: { companyId: string; kpis?: CommandKpis }) {
  const { companyId } = props;

  const { data: summary } = useQuery({
    queryKey: queryKeys.dashboard(companyId),
    queryFn: () => dashboardApi.summary(companyId),
    enabled: !props.kpis && Boolean(companyId),
    refetchInterval: 30_000,
    retry: false,
  });
  const { data: missionsList } = useQuery({
    queryKey: queryKeys.missions.list(companyId),
    queryFn: () => missionsApi.list(companyId),
    enabled: !props.kpis && Boolean(companyId),
    refetchInterval: 30_000,
    retry: false,
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
  const waitDisplay = pending ? `${waitCount}${hasMore ? "+" : ""}` : String(kpis.waitCount);

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
    { icon: Bot, label: "가동 에이전트", value: String(kpis.runningAgents), sub: `${kpis.enabledAgents} 활성`, to: "/agents" },
    { icon: CircleDot, label: "진행 작업", value: String(kpis.inProgressTasks), sub: `${kpis.blockedTasks} 차단됨`, to: "/issues" },
    { icon: Rocket, label: "활성 미션", value: String(kpis.activeMissions), sub: "missions", to: "/missions" },
    { icon: DollarSign, label: "월간 비용", value: formatCents(kpis.monthSpendCents), sub: kpis.monthBudgetCents > 0 ? `예산 ${formatCents(kpis.monthBudgetCents)}` : "무제한", to: "/costs" },
    { icon: Hourglass, label: "대기/차단 현황", value: waitDisplay, sub: pending ? `결정 ${pendingCards.length}${hasMore ? "+" : ""} · 큐 ${queueItems.length}` : "승인+큐", to: "/human-operator" },
  ];

  const pillStyle = {
    backgroundColor: "var(--openbot-surface-25d-raised)",
    borderColor: "var(--openbot-surface-25d-border)",
    color: "var(--openbot-text-secondary)",
  };

  return (
    <section
      aria-label="명령 헤더"
      className="rounded-xl border p-3.5 space-y-3"
      style={{
        backgroundColor: "var(--openbot-surface-25d-bg)",
        borderColor: "var(--openbot-surface-25d-border)",
        boxShadow: "var(--openbot-surface-25d-shadow)",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={{ backgroundColor: "var(--openbot-accent-soft)", color: "var(--openbot-accent-text)" }}
        >
          <Rocket className="h-3.5 w-3.5" />
          실시간 운영 현황
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Link to="/human-operator" className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium no-underline transition-colors hover:brightness-110" style={pillStyle}>
            <UserRoundCheck className="h-3.5 w-3.5" />
            결정함{waitCount > 0 ? ` ${waitDisplay}` : ""}
          </Link>
          <Link to="/worktree/rules" className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium no-underline transition-colors hover:brightness-110" style={pillStyle}>
            <ShieldCheck className="h-3.5 w-3.5" />
            Hermit Gate · 실행 규칙
          </Link>
          <Link to="/channels" className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium no-underline transition-colors hover:brightness-110" style={pillStyle}>
            <MessageSquare className="h-3.5 w-3.5" />
            채널 협업 보드
          </Link>
          <button
            type="button"
            onClick={() => typeof window !== "undefined" && window.dispatchEvent(new CustomEvent("openbot:toggle-inspector"))}
            className="hidden md:inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors hover:brightness-110 cursor-pointer"
            style={pillStyle}
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
            className="rounded-lg border px-3 py-2.5 no-underline text-inherit transition-transform hover:-translate-y-0.5"
            style={{
              backgroundColor: "var(--openbot-surface-25d-raised)",
              borderColor: "var(--openbot-surface-25d-border)",
              boxShadow: "inset 0 1px 0 var(--openbot-surface-25d-highlight)",
            }}
          >
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--openbot-text-muted)" }}>
              <tile.icon className="h-3.5 w-3.5" />
              {tile.label}
            </div>
            <div className="mt-1 text-lg font-semibold leading-none" style={{ color: "var(--openbot-text-primary)" }}>
              {tile.value}
            </div>
            <div className="mt-1 text-[10px]" style={{ color: "var(--openbot-text-muted)" }}>{tile.sub}</div>
          </Link>
        ))}
      </div>

      {waits.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto">
          <span className="flex items-center gap-1 text-[11px] shrink-0" style={{ color: "var(--openbot-text-muted)" }}>
            <Inbox className="h-3.5 w-3.5" />
            대기열
          </span>
          {waits.map((w) => (
            <Link
              key={w.id}
              to={w.tone === "queue" ? "/worktree/rules" : "/human-operator"}
              className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium no-underline max-w-56 truncate"
              style={{ color: `var(${TONE_VARS[w.tone].fg})`, backgroundColor: `var(${TONE_VARS[w.tone].bg})` }}
              title={w.label}
            >
              {w.label}
            </Link>
          ))}
          {waitCount > waits.length && (
            <Link to="/human-operator" className="shrink-0 text-[10px] underline underline-offset-2" style={{ color: "var(--openbot-text-muted)" }}>
              +{waitCount - waits.length} 더 보기
            </Link>
          )}
        </div>
      )}

      <p className="text-[10px]" style={{ color: "var(--openbot-text-muted)" }}>
        사이드바 경계를 드래그하면 뷰가 스냅됩니다 (compact · peek · expanded).
      </p>
    </section>
  );
}
