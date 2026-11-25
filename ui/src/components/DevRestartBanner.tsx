import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import type { DevServerHealthStatus } from "../api/health";

function formatRelativeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function describeReason(devServer: DevServerHealthStatus): string {
  if (devServer.reason === "backend_changes_and_pending_migrations") {
    return "backend files changed and migrations are pending";
  }
  if (devServer.reason === "pending_migrations") {
    return "pending migrations need a fresh boot";
  }
  return "backend files changed since this server booted";
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  if (!devServer?.enabled || !devServer.restartRequired) return null;

  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt);
  const sample = devServer.changedPathsSample.slice(0, 3);

  return (
    <div className="border-b border-border/80 border-l-2 border-l-amber-500/80 bg-card/90 text-card-foreground backdrop-blur-sm">
      <div className="flex flex-col gap-3 px-3 py-2 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>Paperwork Restart Required</span>
            {devServer.autoRestartEnabled ? (
              <span className="rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] tracking-[0.14em] text-amber-800 dark:text-amber-200 tabular-nums">
                Auto-Restart On
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-foreground/90">
            Paperwork dev server: {describeReason(devServer)}
            {changedAt ? ` · updated ${changedAt}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-muted-foreground">
            {sample.length > 0 ? (
              <span>
                Changed: {sample.join(", ")}
                {devServer.changedPathCount > sample.length ? ` +${devServer.changedPathCount - sample.length} more` : ""}
              </span>
            ) : null}
            {devServer.pendingMigrations.length > 0 ? (
              <span>
                Pending migrations: {devServer.pendingMigrations.slice(0, 2).join(", ")}
                {devServer.pendingMigrations.length > 2 ? ` +${devServer.pendingMigrations.length - 2} more` : ""}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
          {devServer.waitingForIdle ? (
            <div className="inline-flex items-center gap-2 rounded-sm border border-border/80 bg-background/70 px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground">
              <TimerReset className="h-3.5 w-3.5" />
              <span>Waiting for {devServer.activeRunCount} live run{devServer.activeRunCount === 1 ? "" : "s"} to finish</span>
            </div>
          ) : devServer.autoRestartEnabled ? (
            <div className="inline-flex items-center gap-2 rounded-sm border border-border/80 bg-background/70 px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Auto-restart will trigger when the instance is idle</span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-sm border border-border/80 bg-background/70 px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Restart <code>pnpm dev:once</code> after the active work is safe to interrupt</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
