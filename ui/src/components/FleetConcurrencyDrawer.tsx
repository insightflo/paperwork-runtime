import { useEffect } from "react";
import type { ReactNode } from "react";
import { Download, Layers, X } from "lucide-react";

export interface FleetConcurrencyDrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  headline?: string;
  csvExportUrl?: string | null;
  children?: ReactNode;
}

const DEFAULT_TITLE = "동시 실행 및 큐 현황";

export function buildQueueTelemetryCsvUrl(companyId: string): string {
  return `/api/companies/${encodeURIComponent(companyId)}/queue-telemetry/export.csv`;
}

export function FleetConcurrencyDrawer({
  open,
  onClose,
  title,
  headline,
  csvExportUrl,
  children,
}: FleetConcurrencyDrawerProps) {
  const drawerTitle = title ?? DEFAULT_TITLE;

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-foreground/40 backdrop-blur-sm">
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={drawerTitle}
        data-testid="fleet-concurrency-drawer"
        className="flex h-full w-full max-w-xl flex-col border-l border-border bg-card text-card-foreground shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-secondary-foreground">
              <Layers className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold tracking-tight">{drawerTitle}</h2>
              {headline ? <p className="mt-1 text-sm leading-5 text-muted-foreground">{headline}</p> : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {csvExportUrl ? (
              <a
                href={csvExportUrl}
                download="queue-telemetry.csv"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
                CSV
              </a>
            ) : null}
            <button
              type="button"
              aria-label="닫기"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}
