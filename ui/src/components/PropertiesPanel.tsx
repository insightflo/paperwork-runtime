import { useEffect, useState } from "react";
import { PanelRightOpen } from "lucide-react";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { InspectorSidePanel } from "./InspectorSidePanel";

const WIDE_DESKTOP_BREAKPOINT_PX = 1280;

export function PropertiesPanel() {
  const { panelContent, panelVisible, setPanelVisible, togglePanelVisible } = usePanel();
  const { selectedCompanyId } = useCompany();
  const [manualOpen, setManualOpen] = useState(false);
  const [isWideDesktop, setIsWideDesktop] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= WIDE_DESKTOP_BREAKPOINT_PX,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setIsWideDesktop(window.innerWidth >= WIDE_DESKTOP_BREAKPOINT_PX);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const usePersistentPanel = isWideDesktop || Boolean(panelContent);
  const isExpanded = usePersistentPanel ? panelVisible : manualOpen;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onToggle = () => {
      if (usePersistentPanel) togglePanelVisible();
      else setManualOpen((prev) => !prev);
    };
    window.addEventListener("openbot:toggle-inspector", onToggle);
    return () => window.removeEventListener("openbot:toggle-inspector", onToggle);
  }, [togglePanelVisible, usePersistentPanel]);

  if (!isExpanded) {
    return (
      <aside
        className="hidden md:flex w-11 shrink-0 border-l flex-col items-center"
        style={{
          backgroundColor: "var(--openbot-surface-25d-bg)",
          borderColor: "var(--openbot-surface-25d-border)",
        }}
      >
        <button
          type="button"
          className="flex h-full w-11 flex-col items-center gap-2.5 px-1.5 py-3 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground cursor-pointer"
          onClick={() => (usePersistentPanel ? setPanelVisible(true) : setManualOpen(true))}
          aria-label="인스펙터 열기"
          title="인스펙터 열기"
        >
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg"
            style={{ backgroundColor: "var(--openbot-accent-soft)", color: "var(--openbot-accent-text)" }}
          >
            <PanelRightOpen className="h-4 w-4 shrink-0" />
          </span>
          <span className="text-[10px] font-medium uppercase tracking-wide [writing-mode:vertical-rl]">
            Inspector
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="hidden md:flex border-l flex-col shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-in-out"
      style={{
        width: "var(--openbot-inspector-width)",
        backgroundColor: "var(--openbot-surface-25d-bg)",
        borderColor: "var(--openbot-surface-25d-border)",
      }}
    >
      <InspectorSidePanel
        companyId={selectedCompanyId}
        panelContent={panelContent}
        onClose={() => (usePersistentPanel ? setPanelVisible(false) : setManualOpen(false))}
      />
    </aside>
  );
}
