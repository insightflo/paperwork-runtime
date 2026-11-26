import { Link } from "@/lib/router";
import {
  Bot,
  FolderKanban,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Rocket,
  Search,
  SquarePen,
} from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useOptionalDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Fragment, type ReactNode } from "react";

// 48px Combo 1 Tactile Cockpit command header: [sidebar toggle + prefix/crumbs + live chip] | ⌘K search | status/action slot.
const headerClassName =
  "h-12 shrink-0 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-slate-200/90 bg-white/90 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-sm px-3 md:px-4 dark:border-[#242d3f] dark:bg-[#0b0e14]/95 dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]";

const crumbSeparatorClassName = "text-slate-400 dark:text-[#4a5670] [&>svg]:size-3 [&>svg]:stroke-[1.75]";

/** Opens the real CommandPalette by replaying its existing keyboard shortcut on document. */
function openCommandPalette() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
}

export function BreadcrumbBar() {
  const { breadcrumbs } = useBreadcrumbs();
  const { selectedCompany, canWrite } = useCompany();
  const dialog = useOptionalDialog();
  const { sidebarOpen, toggleSidebar, isMobile } = useSidebar();
  const companyPrefix = selectedCompany?.issuePrefix?.trim() || null;
  const showQuickCreate = Boolean(dialog) && canWrite !== false;

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
      className="hidden h-[30px] w-[clamp(220px,32vw,420px)] justify-start gap-2 rounded-lg border border-slate-200/90 bg-slate-50/90 px-2.5 text-xs font-normal text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-slate-300 hover:bg-white hover:text-slate-900 md:flex dark:border-white/[0.08] dark:bg-[linear-gradient(180deg,#131926,#0d111a)] dark:text-slate-400 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_2px_8px_rgba(0,0,0,0.3)] dark:hover:border-white/[0.15] dark:hover:text-slate-100"
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-[#2563eb] dark:text-[#60a5fa]" />
      <span className="min-w-0 flex-1 truncate text-left">Search missions, agents, approvals…</span>
      <kbd
        aria-hidden="true"
        className="ml-auto shrink-0 rounded border border-slate-200 bg-white px-1.5 py-px font-mono text-[10px] leading-[1.4] text-slate-500 tabular-nums shadow-[inset_0_-1px_0_rgba(15,23,42,0.08)] dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-slate-300 dark:shadow-[inset_0_-1px_0_rgba(0,0,0,0.4)]"
      >
        ⌘K
      </kbd>
    </Button>
  );

  let crumbs: ReactNode = <div className="min-w-0 flex-1" />;
  if (breadcrumbs.length === 1) {
    crumbs = (
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        {companyPrefix && (
          <>
            <span className="shrink-0 font-mono text-xs font-medium text-slate-400 dark:text-[#627089]">{companyPrefix}</span>
            <span aria-hidden="true" className="shrink-0 text-xs text-slate-300 dark:text-white/20">/</span>
          </>
        )}
        <h1 className="truncate text-sm font-semibold uppercase tracking-wider text-slate-900 tabular-nums dark:text-slate-100">{breadcrumbs[0].label}</h1>
      </div>
    );
  } else if (breadcrumbs.length > 1) {
    crumbs = (
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        {companyPrefix && (
          <>
            <span className="shrink-0 font-mono text-xs font-medium text-slate-400 dark:text-[#627089]">{companyPrefix}</span>
            <span aria-hidden="true" className="shrink-0 text-xs text-slate-300 dark:text-white/20">/</span>
          </>
        )}
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
      </div>
    );
  }

  return (
    <div className={headerClassName}>
      <div className="flex min-w-0 items-center gap-2">
        {menuButton}
        {crumbs}
        {breadcrumbs.length > 0 && (
          <span
            aria-label="Live telemetry status"
            className="hidden shrink-0 items-center gap-1.5 rounded-full border border-[#65a30d]/25 bg-[#65a30d]/10 px-2 py-0.5 font-mono text-[10px] font-medium text-[#4d7c0f] lg:inline-flex dark:border-[#a3e635]/25 dark:bg-[#a3e635]/14 dark:text-[#a3e635]"
          >
            <span className="pw-live-dot" />
            LIVE
          </span>
        )}
      </div>
      {searchButton}
      <div className="flex min-w-0 items-center justify-end gap-1.5">
        {companyPrefix && (
          <span className="hidden rounded-md border border-slate-200/80 bg-slate-50 px-2 py-0.5 font-mono text-[10px] font-medium text-slate-500 sm:inline-flex dark:border-white/[0.07] dark:bg-white/[0.04] dark:text-[#9aa7bd]">
            {companyPrefix}
          </span>
        )}
        {showQuickCreate && dialog && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                aria-label="Quick create"
                title="Quick create"
                className="h-7 w-7 shrink-0 rounded-lg border border-blue-600/25 bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_1px_2px_rgba(37,99,235,0.2)] transition-colors hover:bg-blue-500 dark:border-[#60a5fa]/40 dark:bg-[#2563eb] dark:text-[#f8fafc] dark:hover:bg-[#3b82f6]"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={6}
              className="w-52 rounded-xl border-slate-200/90 bg-white/95 p-1 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_12px_32px_rgba(15,23,42,0.14)] backdrop-blur-md dark:border-white/10 dark:bg-[#0e131d]/95 dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_16px_40px_rgba(0,0,0,0.55)]"
            >
              <DropdownMenuLabel className="px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                Quick create
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-slate-200/80 dark:bg-white/[0.08]" />
              <DropdownMenuItem
                className="cursor-pointer rounded-lg text-xs"
                onSelect={() => dialog.openNewMission()}
              >
                <Rocket className="h-3.5 w-3.5 text-[#2563eb] dark:text-[#60a5fa]" />
                New Mission
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer rounded-lg text-xs"
                onSelect={() => dialog.openNewIssue()}
              >
                <SquarePen className="h-3.5 w-3.5 text-[#4d7c0f] dark:text-[#a3e635]" />
                New Work Item
                <kbd className="ml-auto rounded border border-slate-200 bg-slate-50 px-1 py-px font-mono text-[10px] text-slate-500 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-400">
                  C
                </kbd>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer rounded-lg text-xs"
                onSelect={() => dialog.openNewAgent()}
              >
                <Bot className="h-3.5 w-3.5 text-amber-600 dark:text-[#f59e0b]" />
                New Agent
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer rounded-lg text-xs"
                onSelect={() => dialog.openNewProject()}
              >
                <FolderKanban className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400" />
                New Work Context
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={openCommandPalette}
          aria-label="Search"
          title="Search (⌘K)"
          className="h-7 w-7 shrink-0 text-slate-500 hover:bg-slate-100 hover:text-slate-900 md:hidden dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-slate-100"
        >
          <Search className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
