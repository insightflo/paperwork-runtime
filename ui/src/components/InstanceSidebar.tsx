import { Clock3, FlaskConical, Settings, SlidersHorizontal } from "lucide-react";
import { SidebarNavItem } from "./SidebarNavItem";

export function InstanceSidebar() {
  return (
    <aside className="w-60 h-full min-h-0 border-r border-sidebar-border bg-sidebar flex flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-sidebar-border px-3">
        <Settings className="ml-1 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/80">
          Instance Settings
        </span>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem to="/instance/settings/general" label="General" icon={SlidersHorizontal} end />
          <SidebarNavItem to="/instance/settings/heartbeats" label="Heartbeats" icon={Clock3} end />
          <SidebarNavItem to="/instance/settings/experimental" label="실험 기능" icon={FlaskConical} />
        </div>
      </nav>
    </aside>
  );
}
