import {
  Inbox,
  CircleDot,
  Target,
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
import { PluginSlotOutlet } from "@/plugins/slots";
import { CORE_INTEGRATED_PLUGIN_KEYS } from "@/plugins/core-integrated";

interface SidebarProps {
  onOpenHermes?: () => void;
  hermesPanelOpen?: boolean;
  onToggleCompact?: () => void;
}

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
  const humanOperatorBadgeLabel = [
    `${humanOperatorSurface.activeCount} active item${humanOperatorSurface.activeCount === 1 ? "" : "s"} displayed`,
    humanOperatorSurface.pendingPageIncomplete ? "more pending cards" : null,
    missionStatusLabel,
  ].filter(Boolean).join(" · ");

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside
      className="w-full h-full min-h-0 border-r flex flex-col"
      style={{
        backgroundColor: "var(--openbot-subnav-bg)",
        borderColor: "var(--openbot-subnav-border)",
      }}
    >
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
          <button
            type="button"
            onClick={() => openNewIssue()}
            title="New Work Item"
            aria-label="New Work Item"
            style={{ borderRadius: compact ? 10 : 9 }}
            className={cn(
              "flex items-center text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors",
              compact ? "mx-auto h-9 w-9 justify-center" : "gap-2.5 px-3 py-2",
            )}
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            {!compact && <span className="truncate">New Work Item</span>}
          </button>
          {/* New Mission button */}
          <button
            type="button"
            onClick={() => openNewMission()}
            title="New Mission"
            aria-label="New Mission"
            style={{ borderRadius: compact ? 10 : 9 }}
            className={cn(
              "flex items-center text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors",
              compact ? "mx-auto h-9 w-9 justify-center" : "gap-2.5 px-3 py-2",
            )}
          >
            <Rocket className="h-4 w-4 shrink-0" />
            {!compact && <span className="truncate">New Mission</span>}
          </button>
          <SidebarNavItem to="/missions" label="Missions" icon={Rocket} />
          <SidebarNavItem
            to="/human-operator"
            label="Human Operator"
            icon={UserRoundCheck}
            textBadge={humanOperatorBadgeLabel}
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
          <div className={compact ? "hidden" : undefined}>
            <PluginSlotOutlet
              slotTypes={["sidebar"]}
              context={pluginContext}
              excludePluginKeys={CORE_INTEGRATED_PLUGIN_KEYS}
              className="flex flex-col gap-0.5"
              itemClassName="text-[13px] font-medium"
              missingBehavior="placeholder"
            />
          </div>
        </div>

        <div className={compact ? "openbot-compact-section border-t pt-1.5" : undefined} style={compact ? { borderColor: "var(--openbot-subnav-border)" } : undefined}>
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

        <div className={compact ? "openbot-compact-section border-t pt-1.5" : undefined} style={compact ? { borderColor: "var(--openbot-subnav-border)" } : undefined}>
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
                compact ? "mx-auto h-9 w-9 justify-center" : "gap-2.5 px-3 py-2",
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
            <SidebarNavItem to="/goals" label="Goals" icon={Target} />
            <SidebarNavItem to="/channels" label="Channel" icon={MessageSquare} />
            <SidebarNavItem to="/worktree/rules" label="Execution Rules" icon={ShieldCheck} />
            <SidebarNavItem to="/worktree/proposals" label="Proposals" icon={GitPullRequest} />
            <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
          </SidebarSection>
        </div>

        <div className={compact ? "hidden" : undefined}>
          <PluginSlotOutlet
            slotTypes={["sidebarPanel"]}
            context={pluginContext}
            excludePluginKeys={CORE_INTEGRATED_PLUGIN_KEYS}
            className="flex flex-col gap-3"
            itemClassName="rounded-lg border border-border p-3"
            missingBehavior="placeholder"
          />
        </div>
      </nav>
    </aside>
  );
}
