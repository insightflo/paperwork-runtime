import { Link } from "@/lib/router";
import { Menu, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Fragment, type ReactNode } from "react";

// 48px Linear/Datadog-style command header: [sidebar toggle + crumbs] | ⌘K search | right slot.
const headerClassName =
  "h-12 shrink-0 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-slate-200/90 bg-white/90 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-sm px-3 md:px-4 dark:border-[#242d3f] dark:bg-[#0b0e14]/95 dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]";

const crumbSeparatorClassName = "text-slate-400 dark:text-[#4a5670] [&>svg]:size-3 [&>svg]:stroke-[1.75]";

/** Opens the real CommandPalette by replaying its existing keyboard shortcut on document. */
function openCommandPalette() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
}

export function BreadcrumbBar() {
  const { breadcrumbs } = useBreadcrumbs();
  const { sidebarOpen, toggleSidebar, isMobile } = useSidebar();

  const menuButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="-ml-1 shrink-0 text-slate-500 hover:bg-slate-100 hover:text-[#2563eb] dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-[#60a5fa]"
      onClick={toggleSidebar}
      aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
      title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
      aria-expanded={sidebarOpen}
    >
      {isMobile ? (
        <Menu className="h-5 w-5" />
      ) : sidebarOpen ? (
        <PanelLeftClose className="h-4 w-4" />
      ) : (
        <PanelLeftOpen className="h-4 w-4" />
      )}
    </Button>
  );

  const searchButton = (
    <Button
      type="button"
      variant="ghost"
      onClick={openCommandPalette}
      aria-label="Open command palette"
      aria-keyshortcuts="Meta+K"
      title="Search missions, agents, approvals… (⌘K)"
      className="hidden h-[30px] w-[clamp(220px,32vw,440px)] justify-start gap-2 rounded-lg [border-radius:10px] border border-slate-200/90 bg-white/85 px-2.5 text-xs font-normal text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 md:flex dark:border-[#242d3f] dark:bg-[#07090d] dark:text-slate-400 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-[#33405a] dark:hover:bg-[#0e131d] dark:hover:text-slate-100"
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-[#2563eb] dark:text-[#60a5fa]" />
      <span className="min-w-0 flex-1 truncate text-left">Search missions, agents, approvals…</span>
      <kbd
        aria-hidden="true"
        className="ml-auto shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-px font-mono text-[10.5px] leading-[1.4] text-slate-500 tabular-nums dark:border-[#242d3f] dark:bg-[#0e131d] dark:text-[#60a5fa]"
      >
        ⌘K
      </kbd>
    </Button>
  );

  let crumbs: ReactNode = <div className="min-w-0 flex-1" />;
  if (breadcrumbs.length === 1) {
    crumbs = (
      <div className="min-w-0 overflow-hidden">
        <h1 className="truncate text-sm font-semibold uppercase tracking-wider text-slate-900 tabular-nums dark:text-slate-100">{breadcrumbs[0].label}</h1>
      </div>
    );
  } else if (breadcrumbs.length > 1) {
    crumbs = (
      <Breadcrumb className="min-w-0 overflow-hidden">
        <BreadcrumbList className="flex-nowrap gap-1.5 uppercase tracking-wider tabular-nums">
          {breadcrumbs.map((crumb, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return (
              <Fragment key={i}>
                {i > 0 && <BreadcrumbSeparator className={crumbSeparatorClassName} />}
                <BreadcrumbItem className={isLast ? "min-w-0" : "shrink-0"}>
                  {isLast || !crumb.href ? (
                    <BreadcrumbPage className="truncate font-semibold text-slate-900 dark:text-slate-100">{crumb.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild className="text-slate-500 hover:text-[#2563eb] dark:text-slate-400 dark:hover:text-[#60a5fa]">
                      <Link to={crumb.href}>{crumb.label}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  return (
    <div className={headerClassName}>
      <div className="flex min-w-0 items-center gap-2">
        {menuButton}
        {crumbs}
      </div>
      {searchButton}
      {/* Reserved slot for existing right-side panel toggles; currently none are wired here. */}
      <div className="flex min-w-0 items-center justify-end gap-1" />
    </div>
  );
}
