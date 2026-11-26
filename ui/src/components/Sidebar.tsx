import {
  Inbox,
  CircleDot,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  BookOpen,
  Brain,
  Boxes,
  Settings,
  Rocket,
  CalendarClock,
  MessageSquare,
  ShieldCheck,
  GitPullRequest,
  Workflow,
  ListChecks,
  UserRoundCheck,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { heartbeatsApi } from "../api/heartbeats";
import { missionsApi } from "../api/missions";
import { operatorDecisionsApi } from "../api/operator-decisions";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useAfterInitialPaint } from "../hooks/useAfterInitialPaint";
import { selectHumanOperatorSurface } from "../lib/human-operator-surface";
import { useSidebarDensity } from "../lib/sidebar-slide-physics";
import { Button } from "@/components/ui/button";

interface SidebarProps {
  onOpenHermes?: () => void;
  hermesPanelOpen?: boolean;
  onToggleCompact?: () => void;
}

/** Creation actions: icon tiles in the mini bar, otherwise one compact "+ Work | + Mission" row instead of two stacked buttons. */
const CREATE_TILE = "mx-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground";
const CREATE_BAR =
  "mb-0.5 grid grid-cols-2 overflow-hidden rounded-[9px] border border-border/80 bg-card shadow-xs dark:border-[var(--pw-hairline)] dark:bg-[#0d1118] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]";
const CREATE_SEGMENT = "flex h-7 items-center justify-center gap-1 text-xs font-semibold text-foreground transition-colors hover:bg-accent/60";

export function Sidebar({ onOpenHermes, hermesPanelOpen = false, onToggleCompact }: SidebarProps) {
  const { compact: rawCompact } = useSidebarDensity();
  const { isMobile } = useSidebar();
  const compact = rawCompact && !isMobile;
  const { openNewIssue, openNewMission } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const sidebarDataReady = useAfterInitialPaint(900);
  const deferredCompanyId = sidebarDataReady ? selectedCompanyId : null;
  const inboxBadge = useInboxBadge(deferredCompanyId);
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId && sidebarDataReady,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;
  const { data: humanOperatorRequests } = useQuery({
    queryKey: deferredCompanyId
      ? queryKeys.missions.humanOperatorRequests(deferredCompanyId)
      : ["missions", "human-operator-requests"],
    queryFn: () => missionsApi.listHumanOperatorRequests(deferredCompanyId!),
    enabled: !!deferredCompanyId,
    refetchInterval: 30_000,
  });
  const missionStatusQuery = useQuery({
    queryKey: deferredCompanyId ? queryKeys.missions.list(deferredCompanyId) : ["missions"],
    queryFn: () => missionsApi.list(deferredCompanyId!),
    enabled: !!deferredCompanyId,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const { data: pendingOperatorDecisions } = useQuery({
    queryKey: deferredCompanyId
      ? queryKeys.operatorDecisions.list(deferredCompanyId, "pending")
      : ["operator-decisions", "pending"],
    queryFn: () => operatorDecisionsApi.list(deferredCompanyId!, "pending"),
    enabled: !!deferredCompanyId,
    refetchInterval: 30_000,
  });
  const humanOperatorSurface = selectHumanOperatorSurface({
    companyId: deferredCompanyId,
    missions: missionStatusQuery.isError ? undefined : missionStatusQuery.data,
    requests: humanOperatorRequests ?? [],
    pendingDecisions: pendingOperatorDecisions?.data ?? [],
    pendingNextCursor: pendingOperatorDecisions?.page.nextCursor,
  });
  const missionStatusLabel = missionStatusQuery.isLoading
    ? "loading status"
    : missionStatusQuery.isError
      ? "status error"
      : missionStatusQuery.isFetching || missionStatusQuery.isStale
        ? "status stale"
        : null;
  // Full description stays in the tooltip; the pill itself shows only a concise count.
  const humanOperatorBadgeLabel = [
    `${humanOperatorSurface.activeCount} active item${humanOperatorSurface.activeCount === 1 ? "" : "s"} displayed`,
    humanOperatorSurface.pendingPageIncomplete ? "more pending cards" : null,
    missionStatusLabel,
  ].filter(Boolean).join(" · ");
  const humanOperatorBadge = `${humanOperatorSurface.activeCount}${humanOperatorSurface.pendingPageIncomplete ? "+" : ""}`;
  // `run` is invoked without arguments: the dialog actions take an optional defaults object.
  const creationActions = [
    { label: "New Work Item", short: "Work", Icon: SquarePen, run: openNewIssue },
    { label: "New Mission", short: "Mission", Icon: Rocket, run: openNewMission },
  ];

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  return (
    <aside className="w-full h-full min-h-0 border-r border-sidebar-border bg-sidebar flex flex-col">
      {/* Top header: Combo 1 tactile inset company pill card */}
      {compact ? (
        <div className="flex flex-col items-center gap-1 px-2 py-2.5 shrink-0 border-b border-sidebar-border">
          {selectedCompany?.brandColor && (
            <div
              className="w-3.5 h-3.5 rounded-[4px] shrink-0 ring-1 ring-black/10 dark:ring-white/15 mb-0.5"
              style={{ backgroundColor: selectedCompany.brandColor }}
              title={selectedCompany.name}
            />
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground shrink-0"
            onClick={onToggleCompact}
            aria-label="사이드바 펼치기"
            title="사이드바 펼치기"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground shrink-0"
            onClick={openSearch}
            aria-label="검색 (⌘K)"
            title="검색 (⌘K)"
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="px-2.5 pt-2.5 pb-1.5 shrink-0">
          <div className="flex items-center justify-between gap-2 rounded-[9px] border border-slate-200/90 bg-white px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.07] dark:bg-[linear-gradient(180deg,rgba(22,28,42,0.9),rgba(14,18,28,0.9))] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.095)]">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {selectedCompany?.brandColor && (
                <div
                  className="h-3.5 w-3.5 shrink-0 rounded-[4px] ring-1 ring-black/10 dark:ring-white/15"
                  style={{ backgroundColor: selectedCompany.brandColor }}
                />
              )}
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[12.5px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
                  {selectedCompany?.name ?? "Select company"}
                </span>
                <span className="truncate font-mono text-[10.5px] leading-tight text-muted-foreground">
                  {selectedCompany?.issuePrefix ? `${selectedCompany.issuePrefix} · cockpit` : "workspace"}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <span
                title={liveRunCount > 0 ? `${liveRunCount} live run${liveRunCount === 1 ? "" : "s"}` : "Cockpit live"}
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#65a30d]/30 bg-[#65a30d]/10 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tabular-nums text-[#4d7c0f] dark:border-[#a3e635]/25 dark:bg-[#a3e635]/14 dark:text-[#a3e635]"
              >
                <span className="pw-live-dot" />
                {liveRunCount > 0 ? `${liveRunCount} LIVE` : "LIVE"}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={openSearch}
                aria-label="검색 (⌘K)"
                title="검색 (⌘K)"
              >
                <Search className="h-3.5 w-3.5" />
              </Button>
              {!isMobile && onToggleCompact && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={onToggleCompact}
                  aria-label="아이콘 미니바로 접기"
                  title="아이콘 미니바로 접기"
                >
                  <PanelLeftClose className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <nav className={cn("cockpit-sidebar-nav flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col", compact ? "gap-2.5 px-2 py-2" : "gap-3 px-2.5 py-2")}>
        <div className="flex flex-col gap-0.5">
          <div className={compact ? "flex flex-col gap-0.5" : CREATE_BAR}>
            {creationActions.map(({ label, short, Icon, run }, index) => (
              <button
                key={label}
                type="button"
                onClick={() => run()}
                title={label}
                aria-label={label}
                className={compact ? CREATE_TILE : cn(CREATE_SEGMENT, index > 0 && "border-l border-border")}
              >
                {compact ? (
                  <Icon className="h-4 w-4" />
                ) : (
                  <>
                    <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    {short}
                  </>
                )}
              </button>
            ))}
          </div>
          <SidebarNavItem to="/missions" label="Missions" icon={Rocket} />
          <SidebarNavItem
            to="/human-operator"
            label="Human Operator"
            icon={UserRoundCheck}
            textBadge={humanOperatorBadge}
            textBadgeDetail={humanOperatorBadgeLabel}
            textBadgeTone={missionStatusLabel || humanOperatorSurface.pendingPageIncomplete ? "amber" : "default"}
            alert={humanOperatorSurface.activeCount > 0}
          />
          <SidebarNavItem
            to="/inbox"
            label="Inbox"
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
        </div>

        <div className={compact ? "openbot-compact-section border-t border-sidebar-border pt-1.5" : undefined}>
          <SidebarSection label="Work">
            <SidebarNavItem to="/issues" label="Work" icon={CircleDot} />
            <SidebarNavItem to="/workflows" label="Workflows" icon={Workflow} />
            <SidebarNavItem to="/scheduler" label="Scheduler" icon={CalendarClock} />
          </SidebarSection>
        </div>

        <div className={compact ? "hidden" : undefined}>
          <SidebarProjects />
        </div>

        <SidebarAgents />

        <div className={compact ? "openbot-compact-section border-t border-sidebar-border pt-1.5" : undefined}>
          <SidebarSection label="Company">
            <SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} liveCount={liveRunCount} />
            <SidebarNavItem to="/quality" label="Quality" icon={ListChecks} />
            <SidebarNavItem to="/org" label="Org" icon={Network} />
            <SidebarNavItem to="/skills" label="Skills" icon={Boxes} />
            <SidebarNavItem to="/instructions" label="Instructions" icon={BookOpen} />
            <SidebarNavItem to="/agent-wiki" label="Wiki" icon={Brain} />
            <button
              type="button"
              onClick={onOpenHermes}
              title="Hermes"
              aria-label="Hermes"
              className={cn(
                "flex items-center rounded-[9px] border border-l-2 text-[13px] font-medium transition-colors",
                compact ? "mx-auto h-9 w-9 justify-center rounded-[10px]" : "gap-2.5 px-3 py-1.5",
                hermesPanelOpen
                  ? "border-slate-200/90 border-l-[var(--pw-cobalt)] bg-accent/60 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.08] dark:border-l-[var(--pw-lime)] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.075),rgba(255,255,255,0.03))] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.095)]"
                  : "border-transparent text-foreground/80 hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <MessageSquare className={cn("h-4 w-4 shrink-0", hermesPanelOpen && "text-[#2563eb] dark:text-[#a3e635]")} />
              {!compact && <span className="flex-1 truncate text-left">Hermes</span>}
            </button>
            <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />
            <SidebarNavItem to="/activity" label="Activity" icon={History} />
            <SidebarNavItem to="/channels" label="Channel" icon={MessageSquare} />
            <SidebarNavItem to="/worktree/rules" label="Approval Gates" icon={ShieldCheck} />
            <SidebarNavItem to="/worktree/proposals" label="Proposals" icon={GitPullRequest} />
            <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
          </SidebarSection>
        </div>
      </nav>
    </aside>
  );
}
