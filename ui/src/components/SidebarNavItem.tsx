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
  /** Full description behind a concise `textBadge` count (e.g. "9 active items displayed"); exposed as the tooltip. */
  textBadgeDetail?: string;
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

/**
 * Compact right-aligned pill. It never shrinks or wraps and is width-capped, so a long value
 * truncates inside the pill instead of colliding with (or squeezing out) the truncated label.
 */
const COUNT_PILL =
  "inline-flex h-[18px] min-w-[18px] max-w-[7.5rem] shrink-0 tabular-nums items-center justify-center gap-1 whitespace-nowrap rounded-full px-1.5 text-[11px] font-semibold leading-none";
const SUBTLE_PILL = "border-border bg-muted text-muted-foreground dark:border-[#242d3f] dark:bg-[#111622]";
const AMBER_PILL = "border-amber-500/35 bg-amber-500/15 text-amber-700 dark:text-[var(--pw-amber)]";
/** Active row: subtle panel pill with a 2px left accent (the cobalt token is defined by the dark theme). */
const ACTIVE_ROW = cn(
  "border-l-primary bg-accent/60 text-foreground",
  "dark:border-[#242d3f] dark:border-l-[var(--pw-cobalt)] dark:bg-[#111622]",
);
const INACTIVE_ICON = "h-4 w-4 shrink-0";
/** The link carries `group`; NavLink sets `aria-current="page"` on the active route. */
const ACTIVE_ICON = cn(INACTIVE_ICON, "group-aria-[current=page]:dark:text-[var(--pw-cobalt)]");

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
  textBadgeDetail,
  alert = false,
  liveCount,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const { compact } = useSidebarDensity();
  const showCompactMode = compact && !isMobile;
  const hasLiveCount = liveCount != null && liveCount > 0;
  const hasBadge = badge != null && badge > 0;
  const showPills = Boolean(textBadge) || hasLiveCount || hasBadge;
  const badgeDetail = textBadgeDetail ?? textBadge;
  // The full badge description stays reachable as a tooltip even though the pill may show only a count.
  const badgeTooltip = badgeDetail ? `${label} (${badgeDetail})` : undefined;
  const onClick = () => { if (isMobile) setSidebarOpen(false); };

  if (showCompactMode) {
    const compactTitle = badgeTooltip ?? label;
    return (
      <NavLink
        to={to}
        end={end}
        title={compactTitle}
        aria-label={compactTitle}
        onClick={onClick}
        className={({ isActive }) =>
          cn(
            "group relative mx-auto flex h-9 w-9 items-center justify-center rounded-[10px] border border-l-2 transition-colors",
            isActive
              ? cn(ACTIVE_ROW, "font-medium")
              : "border-transparent text-foreground/75 hover:bg-accent/50 hover:text-foreground",
            className,
          )
        }
      >
        <Icon className={ACTIVE_ICON} />
        {renderCompactIndicator({ badge, badgeTone, alert, liveCount, textBadgeTone, hasTextBadge: Boolean(textBadge) })}
      </NavLink>
    );
  }

  return (
    <NavLink
      to={to}
      end={end}
      title={badgeTooltip}
      aria-label={badgeTooltip}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-2.5 rounded-[9px] border border-l-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
          isActive
            ? ACTIVE_ROW
            : "border-transparent text-foreground/80 hover:bg-accent/50 hover:text-foreground",
          className,
        )
      }
    >
      <span className="relative shrink-0">
        <Icon className={ACTIVE_ICON} />
        {alert && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {showPills && (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {textBadge && (
            <span className={cn(COUNT_PILL, textBadgeTone === "amber" ? AMBER_PILL : SUBTLE_PILL)}>
              <span className="truncate">{textBadge}</span>
            </span>
          )}
          {hasLiveCount && (
            <span title={`${liveCount} live runs`} className={cn(COUNT_PILL, SUBTLE_PILL, "text-blue-600 dark:text-[var(--pw-cobalt)]")}>
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
              </span>
              {liveCount} live
            </span>
          )}
          {hasBadge && (
            <span
              className={cn(
                COUNT_PILL,
                badgeTone === "danger" ? "bg-red-600/90 text-red-50" : "bg-primary text-primary-foreground",
              )}
            >
              {badge}
            </span>
          )}
        </span>
      )}
    </NavLink>
  );
}
