import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate, useParams } from "@/lib/router";
import { CompanyRail } from "./CompanyRail";
import { Sidebar } from "./Sidebar";
import { InstanceSidebar } from "./InstanceSidebar";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { PropertiesPanel, useInspectorController } from "./PropertiesPanel";
import { CommandPalette } from "./CommandPalette";
import { ToastViewport } from "./ToastViewport";
import { MobileBottomNav } from "./MobileBottomNav";
import { BoundaryDragHandle, useMobileEdgeSwipe } from "./BoundaryDragHandle";
import { WorktreeBanner } from "./WorktreeBanner";
import { DevRestartBanner } from "./DevRestartBanner";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useTheme } from "../context/ThemeContext";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useCompanyPageMemory } from "../hooks/useCompanyPageMemory";
import { healthApi } from "../api/health";
import { shouldSyncCompanySelectionFromRoute } from "../lib/company-selection";
import { SidebarDensityContext, useSidebarSlideController } from "../lib/sidebar-slide-physics";
import { normalizeRememberedInstanceSettingsPath } from "../lib/instance-settings";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { NotFoundPage } from "../pages/NotFound";
import {
  DialogMounts,
  INSTANCE_SETTINGS_MEMORY_KEY,
  SidebarFooterBar,
  StickyLiveRunDock,
  readRememberedInstanceSettingsPath,
} from "./LayoutChrome";

export function Layout() {
  const { sidebarOpen, setSidebarOpen, toggleSidebar, isMobile } = useSidebar();
  const { openNewIssue, openOnboarding } = useDialog();
  const inspector = useInspectorController();
  const {
    companies,
    loading: companiesLoading,
    selectedCompany,
    selectedCompanyId,
    selectionSource,
    setSelectedCompanyId,
  } = useCompany();
  const { theme, toggleTheme } = useTheme();
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isInstanceSettingsRoute = location.pathname.startsWith("/instance/");
  const onboardingTriggered = useRef(false);
  const lastMainScrollTop = useRef(0);
  const [mobileNavVisible, setMobileNavVisible] = useState(true);
  const [instanceSettingsTarget, setInstanceSettingsTarget] = useState<string>(() => readRememberedInstanceSettingsPath());
  const nextTheme = theme === "dark" ? "light" : "dark";
  const rightPanelWidth = !isMobile ? (inspector.isExpanded ? 360 : 44) : 0;
  const slide = useSidebarSlideController({ isMobile, sidebarOpen, setSidebarOpen, rightPanelWidth });
  const { setHoveringSubNav, metrics: { subNavBlurPx } } = slide;
  const subNavHoverApplied = useRef(false);
  // Hovering only changes the nav blur while it is partly collapsed (blur > 0); in the expanded
  // default the state update would only re-render Layout and <Outlet />, so it is skipped.
  const setSubNavHover = (hovering: boolean) => {
    if (hovering === subNavHoverApplied.current || (hovering && subNavBlurPx === 0)) return;
    subNavHoverApplied.current = hovering;
    setHoveringSubNav(hovering);
  };

  const matchedCompany = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix) ?? null;
  }, [companies, companyPrefix]);
  const hasUnknownCompanyPrefix =
    Boolean(companyPrefix) && !companiesLoading && companies.length > 0 && !matchedCompany;

  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as { devServer?: { enabled?: boolean } } | undefined;
      return data?.devServer?.enabled ? 2000 : false;
    },
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (companiesLoading || onboardingTriggered.current) return;
    if (health?.deploymentMode === "authenticated") return;
    if (companies.length === 0) {
      onboardingTriggered.current = true;
      openOnboarding();
    }
  }, [companies, companiesLoading, openOnboarding, health?.deploymentMode]);

  useEffect(() => {
    if (!companyPrefix || companiesLoading || companies.length === 0) return;
    if (!matchedCompany) {
      const fallback =
        (selectedCompanyId ? companies.find((c) => c.id === selectedCompanyId) : null) ?? companies[0] ?? null;
      if (fallback && selectedCompanyId !== fallback.id) {
        setSelectedCompanyId(fallback.id, { source: "route_sync" });
      }
      return;
    }
    if (companyPrefix !== matchedCompany.issuePrefix) {
      const suffix = location.pathname.replace(/^\/[^/]+/, "");
      navigate(`/${matchedCompany.issuePrefix}${suffix}${location.search}`, { replace: true });
      return;
    }
    if (shouldSyncCompanySelectionFromRoute({ selectionSource, selectedCompanyId, routeCompanyId: matchedCompany.id })) {
      setSelectedCompanyId(matchedCompany.id, { source: "route_sync" });
    }
  }, [companyPrefix, companies, companiesLoading, matchedCompany, location.pathname, location.search, navigate, selectionSource, selectedCompanyId, setSelectedCompanyId]);

  useCompanyPageMemory();
  useKeyboardShortcuts({
    onNewIssue: () => openNewIssue(),
    onToggleSidebar: isMobile ? toggleSidebar : slide.toggleNav,
    onTogglePanel: inspector.toggleInspector,
  });

  useMobileEdgeSwipe(isMobile, sidebarOpen, setSidebarOpen);

  const updateMobileNavVisibility = useCallback((currentTop: number) => {
    const delta = currentTop - lastMainScrollTop.current;
    if (currentTop <= 24 || delta < -8) setMobileNavVisible(true);
    else if (delta > 8) setMobileNavVisible(false);
    lastMainScrollTop.current = currentTop;
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobileNavVisible(true);
      lastMainScrollTop.current = 0;
      return;
    }
    const onScroll = () => updateMobileNavVisibility(window.scrollY || document.documentElement.scrollTop || 0);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isMobile, updateMobileNavVisibility]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = isMobile ? "visible" : "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isMobile]);

  useEffect(() => {
    if (!location.pathname.startsWith("/instance/settings/")) return;
    const nextPath = normalizeRememberedInstanceSettingsPath(`${location.pathname}${location.search}${location.hash}`);
    setInstanceSettingsTarget(nextPath);
    try {
      window.localStorage.setItem(INSTANCE_SETTINGS_MEMORY_KEY, nextPath);
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [location.hash, location.pathname, location.search]);

  const sidePanel = (
    <SidebarDensityContext.Provider value={slide.density}>
      {isInstanceSettingsRoute ? (
        <InstanceSidebar />
      ) : (
        <Sidebar onToggleCompact={slide.toggleCompact} />
      )}
    </SidebarDensityContext.Provider>
  );

  const isFullBleedRoute = /\/(workflows|org)(\/|$)/.test(location.pathname);

  return (
    <div
      className={cn("cockpit-shell bg-background text-foreground pt-[env(safe-area-inset-top)]", isMobile ? "min-h-dvh" : "flex h-dvh flex-col overflow-hidden")}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to Main Content
      </a>
      <WorktreeBanner />
      <DevRestartBanner devServer={health?.devServer} />
      <div className={cn("min-h-0 flex-1", isMobile ? "w-full" : "flex overflow-hidden")}>
        {isMobile && sidebarOpen && (
          <button type="button" className="fixed inset-0 z-40 bg-black/50" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" />
        )}
        {isMobile ? (
          <div className={cn("fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] transition-transform duration-100 ease-out", sidebarOpen ? "translate-x-0" : "-translate-x-full")}>
            <div className="flex flex-1 min-h-0 overflow-hidden">
              <CompanyRail />
              {sidePanel}
            </div>
            <SidebarFooterBar
              healthVersion={health?.version}
              instanceSettingsTarget={instanceSettingsTarget}
              theme={theme}
              nextTheme={nextTheme}
              onToggleTheme={toggleTheme}
              onCloseMobile={() => setSidebarOpen(false)}
              withBackground
            />
          </div>
        ) : (
          <div className="flex h-full shrink-0">
            <CompanyRail />
            <div
              data-compact-nav={slide.density.compact ? "true" : undefined}
              className="flex h-full flex-col overflow-hidden transition-[width] duration-100 ease-out"
              style={{ width: slide.effectiveNavWidth }}
              onPointerEnter={() => setSubNavHover(true)}
              onPointerLeave={() => setSubNavHover(false)}
            >
              <div
                className="flex-1 min-h-0 overflow-hidden bg-sidebar"
                style={{
                  opacity: slide.metrics.subNavOpacity,
                  transform: `scale(${slide.metrics.subNavScale})`,
                  transformOrigin: "top left",
                  filter: slide.metrics.subNavBlurPx > 0 ? `blur(${slide.metrics.subNavBlurPx}px)` : undefined,
                }}
              >
                {sidePanel}
              </div>
              <SidebarFooterBar
                healthVersion={health?.version}
                instanceSettingsTarget={instanceSettingsTarget}
                theme={theme}
                nextTheme={nextTheme}
                onToggleTheme={toggleTheme}
              />
            </div>
          </div>
        )}
        {!isMobile && (
          <BoundaryDragHandle width={slide.effectiveNavWidth} onPreview={slide.previewNavWidth} onCommit={slide.commitNavWidth} onToggle={slide.toggleNav} />
        )}
        <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "h-full flex-1")}>
          <div className={cn("cockpit-header-slot", isMobile && "sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85")}>
            <BreadcrumbBar />
          </div>
          <div className={cn(isMobile ? "block" : "flex flex-1 min-h-0")}>
            <main
              id="main-content"
              tabIndex={-1}
              data-density-tier={slide.metrics.canvasDensityTier}
              className={cn(
                "flex-1 bg-[#f8fafc] px-4 py-4 md:px-6 md:py-5 dark:bg-[#07090d]",
                isMobile ? "overflow-visible pb-[calc(5rem+env(safe-area-inset-bottom))]" : "overflow-auto cockpit-canvas-sheet",
              )}
              style={
                isMobile
                  ? undefined
                  : {
                      ["--openbot-kpi-cols" as string]: slide.metrics.visibleKpiColumns,
                    }
              }
            >
              <div className={cn(isFullBleedRoute ? "h-full w-full" : "mx-auto w-full max-w-[1480px]")}>
                {hasUnknownCompanyPrefix ? (
                  <NotFoundPage scope="invalid_company_prefix" requestedPrefix={companyPrefix ?? selectedCompany?.issuePrefix} />
                ) : (
                  <Outlet />
                )}
              </div>
            </main>
            <PropertiesPanel controller={inspector} />
          </div>
        </div>
      </div>
      {!isMobile && <StickyLiveRunDock companyId={selectedCompanyId} companyPrefix={selectedCompany?.issuePrefix ?? companyPrefix} />}
      {isMobile && <MobileBottomNav visible={mobileNavVisible} />}
      <CommandPalette />
      <DialogMounts />
      <ToastViewport />
    </div>
  );
}
