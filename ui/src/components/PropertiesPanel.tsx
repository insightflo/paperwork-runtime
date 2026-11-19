import { useState } from "react";
import { PanelRightOpen } from "lucide-react";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { InspectorSidePanel } from "./InspectorSidePanel";

export function PropertiesPanel() {
  const { panelContent, panelVisible, setPanelVisible } = usePanel();
  const { selectedCompanyId } = useCompany();
  const [manualOpen, setManualOpen] = useState(false);

  const isExpanded = panelContent ? panelVisible : manualOpen;

  if (!isExpanded) {
    return (
      <aside className="hidden md:flex w-10 shrink-0 border-l border-border bg-card flex-col items-center">
        <button
          type="button"
          className="flex h-full w-10 flex-col items-center gap-2 px-1.5 py-3 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          onClick={() => (panelContent ? setPanelVisible(true) : setManualOpen(true))}
          aria-label="인스펙터 열기"
          title="인스펙터 열기"
        >
          <PanelRightOpen className="h-4 w-4 shrink-0" />
          <span className="text-[10px] font-medium uppercase tracking-wide [writing-mode:vertical-rl]">
            Inspector
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="hidden md:flex border-l border-border bg-card flex-col shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-in-out"
      style={{ width: "var(--openbot-inspector-width)" }}
    >
      <InspectorSidePanel
        companyId={selectedCompanyId}
        panelContent={panelContent}
        onClose={() => (panelContent ? setPanelVisible(false) : setManualOpen(false))}
      />
    </aside>
  );
}
