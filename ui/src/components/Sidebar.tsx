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
const CREATE_BAR = "mb-0.5 grid grid-cols-2 overflow-hidden rounded-[9px] border bg-card dark:border-[#242d3f] dark:bg-[#111622]";
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
      {/* Top bar: Company name (bold) + Search + Compact mini-bar toggle */}
      {compact ? (
        <div className="flex items-center justify-center gap-1 px-2 h-12 shrink-0">
          {selectedCompany?.brandColor && (
            <div
              className="w-3 h-3 rounded-sm shrink-0"
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
        <div className="flex items-center gap-1 px-3 h-12 shrink-0">
          {selectedCompany?.brandColor && (
            <div
              className="w-4 h-4 rounded-sm shrink-0 ml-1"
              style={{ backgroundColor: selectedCompany.brandColor }}
            />
          )}
          <span className="flex-1 text-sm font-bold text-foreground truncate pl-1">
            {selectedCompany?.name ?? "Select company"}
          </span>
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
          {!isMobile && onToggleCompact && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground shrink-0"
              onClick={onToggleCompact}
              aria-label="아이콘 미니바로 접기"
              title="아이콘 미니바로 접기"
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      <nav className={cn("flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col", compact ? "gap-2.5 px-2 py-2" : "gap-4 px-3 py-2")}>
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
              style={
                hermesPanelOpen
                  ? {
                      borderRadius: compact ? 10 : 9,
                      backgroundColor: "var(--openbot-nav-active-bg)",
                      borderColor: "var(--openbot-nav-active-border)",
                      color: compact ? "var(--openbot-accent-text)" : undefined,
                    }
                  : { borderRadius: compact ? 10 : 9, borderColor: "transparent" }
              }
              className={cn(
                "flex items-center border text-[13px] font-medium transition-colors",
                compact ? "mx-auto h-9 w-9 justify-center" : "gap-2.5 px-3 py-1.5",
                hermesPanelOpen
                  ? "text-foreground"
                  : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <MessageSquare className="h-4 w-4 shrink-0" />
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
