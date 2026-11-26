import { NavLink } from "@/lib/router";
import { prefetchRoute } from "../App";
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
          "absolute -right-1 -top-1 min-w-4 rounded-full px-1 text-center font-mono text-[10px] font-semibold leading-4 tabular-nums",
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
    return <span className="pw-live-dot absolute right-1 top-1 h-2 w-2" />;
  }
  return null;
}

/**
 * Compact right-aligned `.nav-count` mono pill. Never shrinks or wraps and is width-capped,
 * staying calm and muted when the parent NavLink carries `aria-current="page"`.
 */
const COUNT_PILL =
  "inline-flex h-[18px] min-w-[18px] max-w-[7.5rem] shrink-0 tabular-nums items-center justify-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 font-mono text-[10.5px] font-medium leading-none transition-colors";
const SUBTLE_PILL = cn(
  "bg-slate-200/70 text-muted-foreground dark:bg-white/[0.04] dark:text-muted-foreground",
  "group-aria-[current=page]:bg-slate-200/80 group-aria-[current=page]:text-slate-800",
  "dark:group-aria-[current=page]:bg-white/[0.07] dark:group-aria-[current=page]:text-slate-200",
);
const AMBER_PILL = "bg-amber-500/15 text-amber-700 dark:bg-amber-500/15 dark:text-[var(--pw-amber)]";
/** Calm, cool-toned border-first active row (uses background-color in both modes so dark overrides light cleanly). */
const ACTIVE_ROW = cn(
  "border-slate-300/90 bg-slate-100/90 text-slate-900",
  "dark:border-white/[0.15] dark:bg-white/[0.04] dark:text-slate-100",
);
const INACTIVE_ICON = "h-3.5 w-3.5 shrink-0";
/** The link carries `group`; NavLink sets `aria-current="page"` on the active route. */
const ACTIVE_ICON = cn(
  INACTIVE_ICON,
  "group-aria-[current=page]:text-slate-700 dark:group-aria-[current=page]:text-slate-200",
);

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
  // Warm the destination chunk before the click so navigation is instant.
  const warmRoute = () => prefetchRoute(to);

  if (showCompactMode) {
    const compactTitle = badgeTooltip ?? label;
    return (
      <NavLink
        to={to}
        end={end}
        title={compactTitle}
        aria-label={compactTitle}
        onClick={onClick}
        onMouseEnter={warmRoute}
        onFocus={warmRoute}
        className={({ isActive }) =>
          cn(
            "group relative mx-auto flex h-9 w-9 items-center justify-center rounded-[8px] border transition-all duration-150",
            isActive
              ? cn(ACTIVE_ROW, "font-medium")
              : "border-transparent text-foreground/75 hover:bg-slate-200/50 hover:text-foreground dark:text-[#94a3b8] dark:hover:bg-white/[0.04] dark:hover:text-[#eef2f8]",
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
      onMouseEnter={warmRoute}
      onFocus={warmRoute}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-2 rounded-[7px] border px-2.5 py-[7px] text-[12.5px] font-medium transition-all duration-150",
          isActive
            ? ACTIVE_ROW
            : "border-transparent text-foreground/75 hover:bg-slate-200/50 hover:text-foreground dark:text-[#94a3b8] dark:hover:bg-white/[0.04] dark:hover:text-[#eef2f8]",
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
            <span
              title={`${liveCount} live runs`}
              className={cn(
                COUNT_PILL,
                "bg-[#65a30d]/12 text-[#4d7c0f] dark:bg-[#a3e635]/14 dark:text-[#a3e635]",
              )}
            >
              <span className="pw-live-dot h-1.5 w-1.5" />
              {liveCount} LIVE
            </span>
          )}
          {hasBadge && (
            <span
              className={cn(
                COUNT_PILL,
                badgeTone === "danger"
                  ? "bg-red-600/90 text-red-50"
                  : cn(
                      "bg-slate-200/80 text-slate-700 dark:bg-white/[0.06] dark:text-slate-300",
                      "group-aria-[current=page]:bg-slate-200/80 group-aria-[current=page]:text-slate-800",
                      "dark:group-aria-[current=page]:bg-white/[0.07] dark:group-aria-[current=page]:text-slate-200",
                    ),
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
