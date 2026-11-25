import { Link } from "@/lib/router";
import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
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
import { Fragment } from "react";

const headerClassName =
  "border-b border-border/80 bg-background/95 backdrop-blur-sm px-4 md:px-6 h-11 shrink-0 flex items-center";

export function BreadcrumbBar() {
  const { breadcrumbs } = useBreadcrumbs();
  const { sidebarOpen, toggleSidebar, isMobile } = useSidebar();

  const menuButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="mr-2 shrink-0"
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

  if (breadcrumbs.length === 0) {
    return (
      <div className={headerClassName}>
        {menuButton}
        <div className="min-w-0 flex-1" />
      </div>
    );
  }

  // Single breadcrumb = page title (uppercase)
  if (breadcrumbs.length === 1) {
    return (
      <div className={headerClassName}>
        {menuButton}
        <div className="min-w-0 overflow-hidden flex-1">
          <h1 className="text-sm font-semibold uppercase tracking-wider tabular-nums truncate">
            {breadcrumbs[0].label}
          </h1>
        </div>
      </div>
    );
  }

  // Multiple breadcrumbs = breadcrumb trail
  return (
    <div className={headerClassName}>
      {menuButton}
      <div className="min-w-0 overflow-hidden flex-1">
        <Breadcrumb className="min-w-0 overflow-hidden">
          <BreadcrumbList className="flex-nowrap uppercase tracking-wider tabular-nums">
            {breadcrumbs.map((crumb, i) => {
              const isLast = i === breadcrumbs.length - 1;
              return (
                <Fragment key={i}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem className={isLast ? "min-w-0" : "shrink-0"}>
                    {isLast || !crumb.href ? (
                      <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
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
    </div>
  );
}
