import { getWorktreeUiBranding } from "../lib/worktree-branding";

export function WorktreeBanner() {
  const branding = getWorktreeUiBranding();
  if (!branding) return null;

  return (
    <div className="relative overflow-hidden border-b border-border/80 bg-sidebar/95 px-3 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur-sm">
      <div className="flex h-5 items-center gap-2 overflow-hidden whitespace-nowrap font-mono uppercase tracking-[0.16em]">
        <span className="shrink-0 text-[10px] text-muted-foreground/80">Worktree</span>
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-sm border border-border/80 bg-card/70 px-1.5 py-0.5 text-[10px] leading-none tabular-nums">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: branding.color }} aria-hidden="true" />
          <span className="truncate font-semibold tracking-[0.12em] text-foreground">{branding.name}</span>
        </span>
      </div>
    </div>
  );
}
