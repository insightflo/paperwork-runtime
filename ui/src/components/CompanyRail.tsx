import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelLeft, Plus, Search } from "lucide-react";
import { useQueries } from "@tanstack/react-query";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { queryKeys } from "../lib/queryKeys";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { heartbeatsApi } from "../api/heartbeats";
import { useAfterInitialPaint } from "../hooks/useAfterInitialPaint";
import { useLocation, useNavigate } from "@/lib/router";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Company } from "@paperclipai/shared";
import { PapercompanyLogoIcon } from "./PapercompanyLogoIcon";
import { ProviderUsageRings } from "./ProviderUsageRings";
import {
  COMPANY_ORDER_STORAGE_KEY,
  SortableCompanyItem,
  saveCompanyOrder,
  sortCompaniesByStoredOrder,
} from "./CompanyRailItem";

interface CompanyRailProps {
  onToggleSidebar?: () => void;
}

const RAIL_UTIL_BTN =
  "flex items-center justify-center w-9 h-9 rounded-[8px] border border-transparent text-muted-foreground hover:text-foreground hover:bg-slate-200/70 hover:border-slate-300/70 dark:hover:bg-white/[0.04] dark:hover:border-white/[0.065] transition-all duration-150";

export function CompanyRail({ onToggleSidebar }: CompanyRailProps = {}) {
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openOnboarding } = useDialog();
  const navigate = useNavigate();
  const location = useLocation();
  const isInstanceRoute = location.pathname.startsWith("/instance/");
  const highlightedCompanyId = isInstanceRoute ? null : selectedCompanyId;
  const sidebarCompanies = useMemo(() => companies.filter((c) => c.status !== "archived"), [companies]);
  const companyIds = useMemo(() => sidebarCompanies.map((c) => c.id), [sidebarCompanies]);
  const railPollingReady = useAfterInitialPaint(900);

  const liveRunsQueries = useQueries({
    queries: companyIds.map((companyId) => ({
      queryKey: queryKeys.liveRuns(companyId),
      queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
      enabled: railPollingReady,
      refetchInterval: companyId === selectedCompanyId ? 10_000 : 60_000,
    })),
  });
  const sidebarBadgeQueries = useQueries({
    queries: companyIds.map((companyId) => ({
      queryKey: queryKeys.sidebarBadges(companyId),
      queryFn: () => sidebarBadgesApi.get(companyId),
      enabled: railPollingReady,
      refetchInterval: companyId === selectedCompanyId ? 15_000 : 60_000,
    })),
  });

  const hasLiveAgentsByCompanyId = useMemo(() => {
    const map = new Map<string, boolean>();
    companyIds.forEach((id, i) => map.set(id, (liveRunsQueries[i]?.data?.length ?? 0) > 0));
    return map;
  }, [companyIds, liveRunsQueries]);

  const hasUnreadInboxByCompanyId = useMemo(() => {
    const map = new Map<string, boolean>();
    companyIds.forEach((id, i) => map.set(id, (sidebarBadgeQueries[i]?.data?.inbox ?? 0) > 0));
    return map;
  }, [companyIds, sidebarBadgeQueries]);

  const [orderedIds, setOrderedIds] = useState<string[]>(() =>
    sortCompaniesByStoredOrder(sidebarCompanies).map((c) => c.id),
  );

  useEffect(() => {
    setOrderedIds(sidebarCompanies.length === 0 ? [] : sortCompaniesByStoredOrder(sidebarCompanies).map((c) => c.id));
  }, [sidebarCompanies]);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== COMPANY_ORDER_STORAGE_KEY) return;
      try {
        setOrderedIds(e.newValue ? JSON.parse(e.newValue) : []);
      } catch {
        // Ignore malformed cross-tab payloads.
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const orderedCompanies = useMemo(() => {
    const byId = new Map(sidebarCompanies.map((c) => [c.id, c]));
    const result: Company[] = [];
    for (const id of orderedIds) {
      const c = byId.get(id);
      if (c) {
        result.push(c);
        byId.delete(id);
      }
    }
    for (const c of byId.values()) result.push(c);
    return result;
  }, [sidebarCompanies, orderedIds]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const ids = orderedCompanies.map((c) => c.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;
      const newIds = arrayMove(ids, oldIndex, newIndex);
      setOrderedIds(newIds);
      saveCompanyOrder(newIds);
    },
    [orderedCompanies],
  );

  const anyLiveAgents = useMemo(
    () => Array.from(hasLiveAgentsByCompanyId.values()).some(Boolean),
    [hasLiveAgentsByCompanyId],
  );

  return (
    <div className="flex flex-col items-center w-[52px] shrink-0 h-full bg-[#f1f5f9] dark:bg-[#090c12] border-r border-slate-200 dark:border-white/[0.065]">
      <div className="flex items-center justify-center h-12 w-full shrink-0 border-b border-slate-200/80 dark:border-white/[0.065]">
        <div className="relative flex h-8 w-8 items-center justify-center rounded-[9px] border border-slate-300/80 bg-white shadow-xs dark:border-white/[0.12] dark:bg-gradient-to-b dark:from-[#172030] dark:to-[#0d131f] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_4px_12px_rgba(0,0,0,0.45)]">
          <PapercompanyLogoIcon className="h-5 w-5" />
          {anyLiveAgents && (
            <span
              aria-hidden="true"
              className="pw-live-dot absolute -right-0.5 -bottom-0.5 h-2 w-2 ring-2 ring-[#f1f5f9] dark:ring-[#090c12]"
            />
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center gap-1.5 py-2 w-full overflow-y-auto overflow-x-hidden scrollbar-none">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={orderedCompanies.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            {orderedCompanies.map((company) => {
              const isSelected = company.id === highlightedCompanyId;
              return (
                <div
                  key={company.id}
                  data-company-rail-item={company.id}
                  data-active={isSelected ? "true" : undefined}
                  className={cn(
                    "relative flex w-full justify-center [&_a>div:first-child]:left-0 [&_a>div:first-child]:w-[3px] [&_a>div:first-child]:rounded-r-full [&_a>div:first-child]:transition-[height,background-color,box-shadow] [&_a>div:nth-child(2)]:transition-[transform,translate,scale,box-shadow] [&:hover_a>div:nth-child(2)]:-translate-y-0.5 [&:hover_a>div:nth-child(2)]:shadow-[0_8px_16px_-8px_rgba(0,0,0,0.65)]",
                    isSelected
                      ? "[&_a>div:first-child]:h-5 [&_a>div:first-child]:bg-[#2563eb] dark:[&_a>div:first-child]:bg-[#a3e635] dark:[&_a>div:first-child]:shadow-[0_0_10px_0_rgba(163,230,53,0.45)]"
                      : "[&_a>div:first-child]:h-0 [&:hover_a>div:first-child]:h-2 [&:hover_a>div:first-child]:bg-[#2563eb]/60 dark:[&:hover_a>div:first-child]:bg-[#60a5fa]/65",
                  )}
                >
                  <SortableCompanyItem
                    company={company}
                    isSelected={isSelected}
                    hasLiveAgents={hasLiveAgentsByCompanyId.get(company.id) ?? false}
                    hasUnreadInbox={hasUnreadInboxByCompanyId.get(company.id) ?? false}
                    onSelect={() => {
                      setSelectedCompanyId(company.id);
                      if (isInstanceRoute) navigate(`/${company.issuePrefix}/missions`);
                    }}
                  />
                </div>
              );
            })}
          </SortableContext>
        </DndContext>
      </div>

      <ProviderUsageRings companyId={selectedCompanyId} />

      <div className="w-6 h-px bg-slate-300/80 dark:bg-white/[0.08] mx-auto shrink-0" />

      <div className="flex flex-col items-center gap-1.5 py-2 shrink-0">
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                if (onToggleSidebar) {
                  onToggleSidebar();
                } else {
                  document.dispatchEvent(new KeyboardEvent("keydown", { key: "[" }));
                }
              }}
              className={RAIL_UTIL_BTN}
              aria-label="사이드바 접기/펼치기 ([)"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <p>사이드바 접기/펼치기 ([)</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
              className={RAIL_UTIL_BTN}
              aria-label="커맨드 팔레트 (⌘K)"
            >
              <Search className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <p>커맨드 팔레트 (⌘K)</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => openOnboarding()}
              className="flex items-center justify-center w-9 h-9 rounded-[8px] border border-dashed border-slate-300 dark:border-white/[0.12] text-muted-foreground hover:border-[#2563eb]/70 hover:text-[#2563eb] dark:hover:border-[#a3e635]/60 dark:hover:text-[#a3e635] dark:hover:bg-[#a3e635]/[0.06] transition-[border-color,color,background-color] duration-150"
              aria-label="Add company"
            >
              <Plus className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <p>Add company</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
