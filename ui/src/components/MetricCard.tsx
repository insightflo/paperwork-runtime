import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
}

export function MetricCard({ icon: Icon, value, label, description, to, onClick }: MetricCardProps) {
  const isClickable = !!(to || onClick);

  const inner = (
    <div
      className={cn(
        "tactile-card group relative h-full overflow-hidden rounded-xl border border-border/80 bg-card/80 px-4 py-3.5 sm:px-5 sm:py-4 tabular-nums transition-[border-color,background-color,box-shadow] duration-150",
        "dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_-18px_rgba(0,0,0,0.85)]",
        isClickable && "cursor-pointer hover:border-primary/40 hover:bg-accent/40 dark:hover:border-[#60a5fa]/45 dark:hover:bg-[#121826]",
      )}
    >
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-900/10 to-transparent dark:via-white/15" />
      <div aria-hidden className="pointer-events-none absolute left-0 top-3 h-[calc(100%-1.5rem)] w-px bg-gradient-to-b from-blue-500/50 via-blue-500/10 to-transparent dark:from-[#60a5fa]/70 dark:via-[#60a5fa]/15" />
      <div className="relative flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-mono text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums text-foreground dark:text-[#eef2f8]">
            {value}
          </p>
          <p className="mt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground dark:text-[#8f9db3]">
            {label}
          </p>
          {description && (
            <div className="text-xs text-muted-foreground/70 mt-1.5 hidden sm:block dark:text-[#9aa7bd]">{description}</div>
          )}
        </div>
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/70 text-muted-foreground dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#60a5fa]">
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit h-full" onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div className="h-full" onClick={onClick}>
        {inner}
      </div>
    );
  }

  return inner;
}
