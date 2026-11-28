import { cn } from "../lib/utils";

export interface QueueExportToolbarProps {
  csvUrl?: string | null;
  csvFilename?: string;
  onCopyMarkdown?: () => void;
  copied?: boolean;
  disabled?: boolean;
  className?: string;
}

const TOOLBAR_CLASS =
  "tactile-card cockpit-toolbar w-fit bg-card/95 text-card-foreground";

const ACTION_CLASS =
  "inline-flex h-7 items-center justify-center rounded-md px-2.5 text-xs font-medium transition-colors";

const CSV_ACTION_CLASS =
  "bg-primary text-primary-foreground hover:bg-primary/90";

const COPY_ACTION_CLASS =
  "border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50";

export function QueueExportToolbar({
  csvUrl,
  csvFilename,
  onCopyMarkdown,
  copied = false,
  disabled = false,
  className,
}: QueueExportToolbarProps) {
  const hasCsvUrl = typeof csvUrl === "string" && csvUrl.length > 0;

  if (!hasCsvUrl && !onCopyMarkdown) {
    return null;
  }

  return (
    <div
      role="toolbar"
      aria-label="큐 텔레메트리 내보내기"
      data-testid="queue-export-toolbar"
      className={cn(TOOLBAR_CLASS, className)}
    >
      {hasCsvUrl && !disabled ? (
        <a
          href={csvUrl ?? undefined}
          download={csvFilename ?? "queue-telemetry.csv"}
          className={cn(ACTION_CLASS, CSV_ACTION_CLASS)}
        >
          CSV 다운로드
        </a>
      ) : null}
      {onCopyMarkdown ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onCopyMarkdown}
          className={cn(ACTION_CLASS, COPY_ACTION_CLASS)}
        >
          {copied ? "브리핑 복사됨" : "Markdown 브리핑 복사"}
        </button>
      ) : null}
    </div>
  );
}
