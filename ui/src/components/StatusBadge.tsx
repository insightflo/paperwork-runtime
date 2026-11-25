import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border border-current/15 px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase tabular-nums whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}
