import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { InspectorSidePanel } from "./InspectorSidePanel";

export function PropertiesPanel() {
  const { panelContent, panelVisible, setPanelVisible } = usePanel();
  const { selectedCompanyId } = useCompany();

  if (!panelContent && !panelVisible) return null;

  return (
    <aside
      className="hidden md:flex border-l border-border bg-card flex-col shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-in-out"
      style={{ width: panelVisible ? "var(--openbot-inspector-width)" : 0, opacity: panelVisible ? 1 : 0 }}
    >
      <InspectorSidePanel
        companyId={selectedCompanyId}
        panelContent={panelContent}
        onClose={() => setPanelVisible(false)}
      />
    </aside>
  );
}
