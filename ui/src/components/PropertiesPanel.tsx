import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PanelRightOpen } from "lucide-react";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { InspectorSidePanel } from "./InspectorSidePanel";

const WIDE_DESKTOP_BREAKPOINT_PX = 1280;
export const INSPECTOR_TOGGLE_EVENT = "openbot:toggle-inspector";

export interface InspectorController {
  panelContent: ReactNode;
  isExpanded: boolean;
  toggleInspector: () => void;
  setExpanded: (next: boolean) => void;
}

function getWideDesktopMediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(`(min-width: ${WIDE_DESKTOP_BREAKPOINT_PX}px)`);
}

export function useInspectorController(): InspectorController {
  const { panelContent, panelVisible, setPanelVisible, togglePanelVisible } = usePanel();
  const [narrowOpen, setNarrowOpen] = useState(false);
  const [isWideDesktop, setIsWideDesktop] = useState(() => {
    const mql = getWideDesktopMediaQuery();
    if (mql) return mql.matches;
    return typeof window === "undefined" ? true : window.innerWidth >= WIDE_DESKTOP_BREAKPOINT_PX;
  });

  useEffect(() => {
    const mql = getWideDesktopMediaQuery();
    if (!mql) return;
    setIsWideDesktop(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setIsWideDesktop(event.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const usePersistentPanel = isWideDesktop || Boolean(panelContent);
  const isExpanded = usePersistentPanel ? panelVisible : narrowOpen;

  const setExpanded = useCallback(
    (next: boolean) => {
      if (usePersistentPanel) setPanelVisible(next);
      else setNarrowOpen(next);
    },
    [setPanelVisible, usePersistentPanel],
  );

  const toggleInspector = useCallback(() => {
    if (usePersistentPanel) togglePanelVisible();
    else setNarrowOpen((prev) => !prev);
  }, [togglePanelVisible, usePersistentPanel]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener(INSPECTOR_TOGGLE_EVENT, toggleInspector);
    return () => window.removeEventListener(INSPECTOR_TOGGLE_EVENT, toggleInspector);
  }, [toggleInspector]);

  return { panelContent, isExpanded, toggleInspector, setExpanded };
}

export function PropertiesPanel({ controller }: { controller: InspectorController }) {
  const { selectedCompanyId } = useCompany();

  if (!controller.isExpanded) {
    return (
      <aside
        className="hidden md:flex w-11 shrink-0 border-l border-border/80 bg-sidebar/95 flex-col items-center"
      >
        <button
          type="button"
          className="flex h-full w-11 flex-col items-center gap-2.5 px-1.5 py-3 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground cursor-pointer"
          onClick={() => controller.setExpanded(true)}
          aria-label="인스펙터 열기"
          title="인스펙터 열기"
        >
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg"
            style={{ backgroundColor: "var(--openbot-accent-soft)", color: "var(--openbot-accent-text)" }}
          >
            <PanelRightOpen className="h-4 w-4 shrink-0" />
          </span>
          <span className="text-[10px] font-mono font-medium uppercase tracking-wider [writing-mode:vertical-rl]">
            Inspector
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="hidden md:flex border-l border-border/80 bg-sidebar/95 flex-col shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-in-out"
      style={{ width: "var(--openbot-inspector-width)" }}
    >
      <InspectorSidePanel
        companyId={selectedCompanyId}
        panelContent={controller.panelContent}
        onClose={() => controller.setExpanded(false)}
      />
    </aside>
  );
}
