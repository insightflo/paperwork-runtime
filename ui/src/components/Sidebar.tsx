import { useState } from "react";
import {
  Inbox,
  CircleDot,
  LayoutDashboard,
  DollarSign,
  History,
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
  PanelLeftOpen,
  ChevronRight,
  FolderKanban,
  Bot,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface SidebarProps {
  onToggleCompact?: () => void;
}

export function Sidebar({ onToggleCompact }: SidebarProps = {}) {
  const [adminOpen, setAdminOpen] = useState(false);
  const { compact: rawCompact } = useSidebarDensity();
  const { isMobile } = useSidebar();
  const compact = rawCompact && !isMobile;
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

  const missionCount = missionStatusQuery.data?.length ?? 0;
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

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-sidebar-border bg-sidebar">
      {/* Top header: Combo 1 clean 2-part inset .company-pill card */}
      {compact ? (
        <div className="flex shrink-0 flex-col items-center gap-1.5 border-b border-sidebar-border px-2 py-2.5">
          {selectedCompany?.brandColor && (
            <div
              className="h-3.5 w-3.5 shrink-0 rounded-[4px] ring-1 ring-black/10 dark:ring-white/15"
              style={{ backgroundColor: selectedCompany.brandColor }}
              title={selectedCompany.name}
            />
          )}
          {onToggleCompact && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={onToggleCompact}
              aria-label="사이드바 펼치기"
              title="사이드바 펼치기"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          )}
        </div>
      ) : (
        <div className="shrink-0 px-2.5 pt-2.5 pb-1">
          <div className="flex items-center justify-between gap-2 rounded-[9px] border border-slate-200/90 bg-white px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.065] dark:bg-transparent dark:bg-[linear-gradient(180deg,rgba(22,28,42,0.9),rgba(14,18,28,0.9))] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.095)]">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1.5">
                {selectedCompany?.brandColor && (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-[3px] ring-1 ring-black/10 dark:ring-white/15"
                    style={{ backgroundColor: selectedCompany.brandColor }}
                  />
                )}
                <span className="truncate text-[12.5px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
                  {selectedCompany?.name ?? "Select company"}
                </span>
              </div>
              <span className="truncate font-mono text-[10.5px] leading-tight text-muted-foreground">
                {selectedCompany?.issuePrefix ? `${selectedCompany.issuePrefix} · 워크스페이스` : "워크스페이스"}
              </span>
            </div>
            <span
              title={liveRunCount > 0 ? `${liveRunCount} live run${liveRunCount === 1 ? "" : "s"}` : "운영 중"}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--pw-lime)] bg-[var(--pw-lime-soft)] px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-[var(--pw-lime)]"
            >
              <span className="pw-live-dot" />
              {liveRunCount > 0 ? `${liveRunCount} LIVE` : "LIVE"}
            </span>
          </div>
        </div>
      )}

      {/* Main body: Primary Workspace nav + flex-growing Agents + bottom-anchored collapsible Admin */}
      <div
        className={cn(
          "cockpit-sidebar-nav flex min-h-0 flex-1 flex-col",
          compact ? "gap-2 px-2 py-2" : "gap-3 px-2.5 py-2",
        )}
      >
        {/* Primary Workspace Navigation */}
        <div className="shrink-0">
          {!compact && (
            <div className="mb-1 flex items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              <span>워크스페이스</span>
              <span className="font-mono text-[10px] text-muted-foreground/70">1-5</span>
            </div>
          )}
          <nav aria-label="워크스페이스" className="flex flex-col gap-0.5">
            <SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} liveCount={liveRunCount} />
            <SidebarNavItem
              to="/missions"
              label="Missions"
              icon={Rocket}
              textBadge={missionCount > 0 ? String(missionCount) : undefined}
            />
            <SidebarNavItem to="/issues" label="Work" icon={CircleDot} />
            <SidebarNavItem
              to="/inbox"
              label="Inbox"
              icon={Inbox}
              badge={inboxBadge.inbox}
              badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
              alert={inboxBadge.failedRuns > 0}
            />
            <SidebarNavItem
              to="/human-operator"
              label="Human Operator"
              icon={UserRoundCheck}
              textBadge={humanOperatorBadge}
              textBadgeDetail={humanOperatorBadgeLabel}
              textBadgeTone={missionStatusLabel || humanOperatorSurface.pendingPageIncomplete ? "amber" : "default"}
              alert={humanOperatorSurface.activeCount > 0}
            />
          </nav>
        </div>

        {/* Flex-growing scrollable middle region for Live Agents */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-auto-hide pr-0.5">
          <SidebarAgents />
        </div>

        {/* Secondary/Admin links: default-collapsed Collapsible anchored above the footer */}
        <div className="shrink-0 border-t border-sidebar-border pt-2">
          <Collapsible open={adminOpen} onOpenChange={setAdminOpen}>
            <CollapsibleTrigger
              aria-label="관리 · 도구"
              className={cn(
                "flex w-full items-center rounded-[7px] text-muted-foreground transition-colors hover:bg-slate-200/50 hover:text-foreground dark:hover:bg-white/[0.04] dark:hover:text-[#eef2f8]",
                compact ? "h-8 justify-center px-1" : "justify-between px-2 py-1",
              )}
            >
              <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em]">
                <ChevronRight
                  className={cn("h-3 w-3 shrink-0 transition-transform duration-150", adminOpen && "rotate-90")}
                />
                {!compact && <span>관리 · 도구</span>}
              </span>
              {!compact && <span className="font-mono text-[10px] text-muted-foreground/70">15</span>}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1 max-h-[40vh] overflow-y-auto scrollbar-auto-hide">
              <div className="flex flex-col gap-0.5">
                <SidebarNavItem to="/bots" label="Bots" icon={Bot} />
                <SidebarNavItem to="/quality" label="Quality" icon={ListChecks} />
                <SidebarNavItem to="/org" label="Org" icon={Network} />
                <SidebarNavItem to="/skills" label="Skills" icon={Boxes} />
                <SidebarNavItem to="/instructions" label="Instructions" icon={BookOpen} />
                <SidebarNavItem to="/agent-wiki" label="Wiki" icon={Brain} />
                <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />
                <SidebarNavItem to="/activity" label="Activity" icon={History} />
                <SidebarNavItem to="/channels" label="Channel" icon={MessageSquare} />
                <SidebarNavItem to="/worktree/rules" label="Approval Gates" icon={ShieldCheck} />
                <SidebarNavItem to="/worktree/proposals" label="Proposals" icon={GitPullRequest} />
                <SidebarNavItem to="/workflows" label="Workflows" icon={Workflow} />
                <SidebarNavItem to="/scheduler" label="Scheduler" icon={CalendarClock} />
                <SidebarNavItem to="/projects" label="Work Contexts" icon={FolderKanban} />
                <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
              </div>
              {!compact && (
                <div className="mt-1.5 border-t border-sidebar-border/60 pt-1.5">
                  <SidebarProjects />
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </aside>
  );
}
