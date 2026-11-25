import { NavLink } from "@/lib/router";
import { cn } from "../lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { useSidebarDensity } from "../lib/sidebar-slide-physics";
import type { LucideIcon } from "lucide-react";

interface SidebarNavItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  className?: string;
  badge?: number;
  badgeTone?: "default" | "danger";
  textBadge?: string;
  textBadgeTone?: "default" | "amber";
  alert?: boolean;
  liveCount?: number;
}

function renderCompactIndicator(opts: {
  badge?: number;
  badgeTone: "default" | "danger";
  alert: boolean;
  liveCount?: number;
  textBadgeTone: "default" | "amber";
  hasTextBadge: boolean;
}) {
  if (opts.badge != null && opts.badge > 0) {
    return (
      <span
        className={cn(
          "absolute -right-1 -top-1 min-w-4 rounded-full px-1 text-center text-[10px] font-semibold leading-4 tabular-nums",
          opts.badgeTone === "danger" ? "bg-red-600/90 text-red-50" : "bg-primary text-primary-foreground",
        )}
      >
        {opts.badge > 99 ? "99+" : opts.badge}
      </span>
    );
  }
  if (opts.alert) {
    return <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" />;
  }
  if (opts.hasTextBadge && opts.textBadgeTone === "amber") {
    return (
      <span
        className="absolute right-1 top-1 h-2 w-2 rounded-full shadow-[0_0_0_2px_hsl(var(--background))]"
        style={{ backgroundColor: "var(--openbot-wait-question)" }}
      />
    );
  }
  if (opts.liveCount != null && opts.liveCount > 0) {
    return <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-500 animate-pulse" />;
  }
  return null;
}

export function SidebarNavItem({
  to,
  label,
  icon: Icon,
  end,
  className,
  badge,
  badgeTone = "default",
  textBadge,
  textBadgeTone = "default",
  alert = false,
  liveCount,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const { compact } = useSidebarDensity();
  const showCompactMode = compact && !isMobile;

  if (showCompactMode) {
    const compactTitle = textBadge ? `${label} (${textBadge})` : label;
    return (
      <NavLink
        to={to}
        end={end}
        title={compactTitle}
        aria-label={compactTitle}
        onClick={() => { if (isMobile) setSidebarOpen(false); }}
        className={({ isActive }) =>
          cn(
            "relative mx-auto flex h-9 w-9 items-center justify-center rounded-[10px] border border-l-2 transition-colors",
            isActive
              ? "border-primary bg-accent/80 font-medium text-foreground"
              : "border-transparent text-foreground/75 hover:bg-accent/50 hover:text-foreground",
            className,
          )
        }
      >
        <Icon className="h-4 w-4 shrink-0" />
        {renderCompactIndicator({ badge, badgeTone, alert, liveCount, textBadgeTone, hasTextBadge: Boolean(textBadge) })}
      </NavLink>
    );
  }

  return (
    <NavLink
      to={to}
      end={end}
      onClick={() => { if (isMobile) setSidebarOpen(false); }}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-[9px] border border-l-2 px-3 py-2 text-[13px] font-medium transition-colors",
          isActive
            ? "border-primary bg-accent/80 text-foreground"
            : "border-transparent text-foreground/80 hover:bg-accent/50 hover:text-foreground",
          className,
        )
      }
    >
      <span className="relative shrink-0">
        <Icon className="h-4 w-4" />
        {alert && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
        )}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {textBadge && (
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
            textBadgeTone === "amber"
              ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          {textBadge}
        </span>
      )}
      {liveCount != null && liveCount > 0 && (
        <span className="ml-auto flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
          <span className="text-[11px] font-medium text-blue-600 tabular-nums dark:text-blue-400">{liveCount} live</span>
        </span>
      )}
      {badge != null && badge > 0 && (
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-xs leading-none tabular-nums",
            badgeTone === "danger"
              ? "bg-red-600/90 text-red-50"
              : "bg-primary text-primary-foreground",
          )}
        >
          {badge}
        </span>
      )}
    </NavLink>
  );
}
