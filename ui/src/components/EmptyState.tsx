import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  message: string;
  action?: string;
  onAction?: () => void;
}

export function EmptyState({ icon: Icon, message, action, onAction }: EmptyStateProps) {
  return (
    <div className="tactile-card relative flex flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-border/80 bg-card/40 px-6 py-12 text-center tabular-nums dark:border-white/[0.12] dark:bg-none dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-900/10 to-transparent dark:via-white/15" />
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg border border-border/70 bg-background/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-white/[0.09] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
        <Icon className="h-5 w-5 text-muted-foreground/70 dark:text-[#60a5fa]" />
      </div>
      <p className="max-w-md text-sm font-medium leading-6 text-foreground/90 dark:text-[#eef2f8]">{message}</p>
      {action && onAction && (
        <Button
          type="button"
          className="mt-4 border border-blue-600/20 bg-blue-600 text-white hover:bg-blue-500 dark:border-[#a3e635]/45 dark:bg-[#a3e635] dark:text-[#0b0f05] dark:hover:bg-[#bef264]"
          size="sm"
          onClick={onAction}
        >
          <Plus className="h-4 w-4 mr-1.5" />
          {action}
        </Button>
      )}
    </div>
  );
}
