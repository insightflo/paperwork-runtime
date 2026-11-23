import { Suspense, lazy, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, BookOpen, Bot, Moon, Settings, Sun } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { AppVersionBadge } from "./AppVersionBadge";
import { useDialog } from "../context/DialogContext";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { useAfterInitialPaint } from "../hooks/useAfterInitialPaint";
import { DEFAULT_INSTANCE_SETTINGS_PATH, normalizeRememberedInstanceSettingsPath } from "../lib/instance-settings";
import { cn } from "../lib/utils";

export const INSTANCE_SETTINGS_MEMORY_KEY = "paperclip.lastInstanceSettingsPath";
export const HERMES_PANEL_MEMORY_KEY = "paperclip.hermesPanelOpen";

const LazyHermesChatPanel = lazy(async () => ({ default: (await import("./HermesChatPanel")).HermesChatPanel }));
const LazyNewIssueDialog = lazy(async () => ({ default: (await import("./NewIssueDialog")).NewIssueDialog }));
const LazyNewProjectDialog = lazy(async () => ({ default: (await import("./NewProjectDialog")).NewProjectDialog }));
const LazyNewMissionDialog = lazy(async () => ({ default: (await import("./NewMissionDialog")).NewMissionDialog }));
const LazyNewAgentDialog = lazy(async () => ({ default: (await import("./NewAgentDialog")).NewAgentDialog }));

export function DialogMounts() {
  const { newIssueOpen, newProjectOpen, newMissionOpen, newAgentOpen } = useDialog();
  if (!newIssueOpen && !newProjectOpen && !newMissionOpen && !newAgentOpen) return null;
  return (
    <Suspense fallback={null}>
      {newIssueOpen && <LazyNewIssueDialog />}
      {newProjectOpen && <LazyNewProjectDialog />}
      {newMissionOpen && <LazyNewMissionDialog />}
      {newAgentOpen && <LazyNewAgentDialog />}
    </Suspense>
  );
}

export function readRememberedInstanceSettingsPath(): string {
  if (typeof window === "undefined") return DEFAULT_INSTANCE_SETTINGS_PATH;
  try {
    return normalizeRememberedInstanceSettingsPath(window.localStorage.getItem(INSTANCE_SETTINGS_MEMORY_KEY));
  } catch {
    return DEFAULT_INSTANCE_SETTINGS_PATH;
  }
}

export function readRememberedHermesPanelOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(HERMES_PANEL_MEMORY_KEY);
    if (raw !== null) return raw === "true";
    return !window.matchMedia("(max-width: 767px)").matches;
  } catch {
    return true;
  }
}

export function writeHermesPanelPreference(open: boolean) {
  try {
    window.localStorage.setItem(HERMES_PANEL_MEMORY_KEY, String(open));
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

export function useAutoCompactSidebar(isMobile: boolean, setSidebarOpen: (open: boolean) => void) {
  const prevBelowThreshold = useRef<boolean | null>(null);
  useEffect(() => {
    if (isMobile || typeof window === "undefined") return;
    const onResize = () => {
      const below = window.innerWidth < 1100;
      if (prevBelowThreshold.current === null) {
        prevBelowThreshold.current = below;
        if (below) setSidebarOpen(false);
        return;
      }
      if (below !== prevBelowThreshold.current) {
        prevBelowThreshold.current = below;
        setSidebarOpen(!below);
      }
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isMobile, setSidebarOpen]);
}

export function SidebarFooterBar(props: {
  healthVersion?: string;
  instanceSettingsTarget: string;
  theme: "light" | "dark";
  nextTheme: string;
  onToggleTheme: () => void;
  onCloseMobile?: () => void;
  withBackground?: boolean;
}) {
  return (
    <div className={cn("border-t border-r border-border px-3 py-2", props.withBackground && "bg-background")}>
      <div className="flex items-center gap-1">
        <a
          href="https://docs.paperclip.ing/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors text-foreground/80 hover:bg-accent/50 hover:text-foreground flex-1 min-w-0"
        >
          <BookOpen className="h-4 w-4 shrink-0" />
          <span className="truncate">Documentation</span>
        </a>
        <AppVersionBadge version={props.healthVersion} />
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground shrink-0" asChild>
          <Link
            to={props.instanceSettingsTarget}
            aria-label="Instance settings"
            title="Instance settings"
            onClick={props.onCloseMobile}
          >
            <Settings className="h-4 w-4" />
          </Link>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          onClick={props.onToggleTheme}
          aria-label={`Switch to ${props.nextTheme} mode`}
          title={`Switch to ${props.nextTheme} mode`}
        >
          {props.theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

export function StickyLiveRunDock(props: { companyId: string | null; companyPrefix?: string }) {
  const ready = useAfterInitialPaint(900);
  const { data: liveRuns } = useQuery({
    queryKey: props.companyId ? queryKeys.liveRuns(props.companyId) : ["live-runs", "none"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(props.companyId!),
    enabled: Boolean(props.companyId) && ready,
    refetchInterval: 10_000,
  });
  const active = liveRuns ?? [];
  if (active.length === 0) return null;

  const first = active[0]!;
  const targetUrl = props.companyPrefix
    ? `/${props.companyPrefix}/agents/${first.agentId}/runs/${first.id}`
    : `/agents/${first.agentId}/runs/${first.id}`;

  return (
    <div
      data-provider={first.adapterType}
      className="fixed bottom-4 right-16 z-40 hidden md:flex items-center gap-2.5 rounded-full border px-3 py-1.5 text-xs shadow-lg backdrop-blur-md"
      style={{
        backgroundColor: "var(--openbot-bg-glass)",
        borderColor: "var(--openbot-glass-border)",
        color: "var(--openbot-text-primary)",
      }}
    >
      <span
        className="h-2 w-2 rounded-full animate-pulse shrink-0"
        style={{ backgroundColor: "var(--openbot-provider-current)" }}
      />
      <Activity className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--openbot-accent)" }} />
      <span className="font-medium truncate max-w-[180px]">
        {active.length === 1 ? first.agentName : `${active.length} active runs`}
      </span>
      <Link
        to={targetUrl}
        className="font-mono text-[11px] underline underline-offset-2 hover:opacity-80"
        style={{ color: "var(--openbot-accent-text)" }}
      >
        Inspect
      </Link>
    </div>
  );
}

export function DesktopHermesAside(props: {
  open: boolean;
  heavyPanelsReady: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <aside
      className={cn(
        "hidden min-h-0 md:flex shrink-0 overflow-hidden border-l border-border bg-background transition-[width] duration-150 ease-out",
        props.open ? "w-96" : "w-12",
      )}
    >
      {props.open ? (
        <div className="h-full min-h-0 w-96 min-w-96 overflow-hidden">
          {props.heavyPanelsReady && (
            <Suspense fallback={null}>
              <LazyHermesChatPanel mode="sidebar" onCollapse={props.onClose} />
            </Suspense>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="flex h-full w-12 flex-col items-center gap-2 px-2 py-3 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          onClick={props.onOpen}
          aria-label="Open Hermes chat"
          title="Open Hermes chat"
        >
          <Bot className="h-4 w-4" />
          <span className="text-[11px] font-medium uppercase tracking-wide [writing-mode:vertical-rl]">Hermes</span>
        </button>
      )}
    </aside>
  );
}

export function MobileHermesDrawer(props: { open: boolean; heavyPanelsReady: boolean; onClose: () => void }) {
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-[70] md:hidden">
      <button type="button" className="absolute inset-0 bg-black/50" onClick={props.onClose} aria-label="Close Hermes chat" />
      <aside className="absolute inset-y-0 right-0 flex min-h-0 w-[min(100vw,24rem)] flex-col overflow-hidden border-l border-border bg-background shadow-lg">
        {props.heavyPanelsReady && (
          <Suspense fallback={null}>
            <LazyHermesChatPanel mode="sidebar" onCollapse={props.onClose} />
          </Suspense>
        )}
      </aside>
    </div>
  );
}
