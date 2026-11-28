import { cn } from "../lib/utils";

export interface FleetSlotRebalanceRow {
  agentId: string;
  agentName?: string;
  currentSlots: number;
  recommendedSlots: number;
  delta: number;
}

export interface FleetSlotRebalanceTableProps {
  rows: readonly FleetSlotRebalanceRow[];
  onApplyAll?: (changed: FleetSlotRebalanceRow[]) => void;
  className?: string;
}

function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `${delta}`;
  return "유지";
}

function deltaTone(delta: number): string {
  if (delta > 0) return "text-primary";
  if (delta < 0) return "text-destructive";
  return "text-muted-foreground";
}

export function FleetSlotRebalanceTable({
  rows,
  onApplyAll,
  className,
}: FleetSlotRebalanceTableProps) {
  if (rows.length === 0) return null;

  const changedRows = rows.filter((row) => row.delta !== 0);

  return (
    <section
      role="region"
      aria-label="플리트 슬롯 재배분 제안"
      data-testid="fleet-slot-rebalance-table"
      className={cn(
        "tactile-card overflow-hidden rounded-xl border border-border bg-card text-card-foreground",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">슬롯 재배분 제안</h2>
          <p className="text-xs text-muted-foreground">
            에이전트별 현재 슬롯과 권장 슬롯을 비교합니다.
          </p>
        </div>
        {onApplyAll && changedRows.length > 0 ? (
          <button
            type="button"
            onClick={() => onApplyAll(changedRows)}
            className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            변경 {changedRows.length}건 일괄 적용
          </button>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                에이전트
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                현재
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                권장
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                변경
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.agentId} className="transition-colors hover:bg-muted/40">
                <td className="max-w-48 px-3 py-2">
                  <div className="truncate font-medium text-card-foreground">
                    {row.agentName ?? row.agentId}
                  </div>
                  {row.agentName ? (
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {row.agentId}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-card-foreground">
                  {row.currentSlots}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-card-foreground">
                  {row.recommendedSlots}
                </td>
                <td
                  className={cn(
                    "px-3 py-2 text-right font-semibold tabular-nums",
                    deltaTone(row.delta),
                  )}
                >
                  {formatDelta(row.delta)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
