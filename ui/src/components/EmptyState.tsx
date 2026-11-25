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
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border/80 bg-card/40 px-6 py-12 text-center">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-md border border-border/70 bg-background/60">
        <Icon className="h-5 w-5 text-muted-foreground/70" />
      </div>
      <p className="max-w-md text-sm font-medium leading-6 text-foreground/90">{message}</p>
      {action && onAction && (
        <Button className="mt-4" size="sm" onClick={onAction}>
          <Plus className="h-4 w-4 mr-1.5" />
          {action}
        </Button>
      )}
    </div>
  );
}
