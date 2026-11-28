import { cn } from "../lib/utils";
import { formatStatusLabel, statusBadge, statusBadgeDefault } from "../lib/status-colors";

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] font-medium leading-none tracking-wide uppercase tabular-nums whitespace-nowrap shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
        statusBadge[status] ?? statusBadgeDefault
      )}
      data-status={status}
      title={status}
    >
      {formatStatusLabel(status)}
    </span>
  );
}
