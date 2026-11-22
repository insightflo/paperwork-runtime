// ui/src/components/HarnessLedgerHistory.tsx
//
// [파일 목적] RRSI Stage 4B 장부 이력 — 최근 L_t 결정 행을 compact 리스트로 렌더한다
//   (decision 배지·component pill·라운드 R{round}·verdict 배지·평가 델타 Δscore/Δcost).
//   Evaluate 버튼은 "approved 이며 아직 평가되지 않은 행 + onEvaluate 주입" 시에만 노출 —
//   POST /companies/:companyId/harness-rsi/ledger/:entryId/evaluate 트리거(기록만, auto-apply 없음).
//   순수 프레젠테이션 컴포넌트: 쿼리·뮤테이션 없이 props 주입으로만 렌더(renderToStaticMarkup 안전).
import type { HarnessLedgerEntry } from "../api/harnessRsi";
import { cn } from "../lib/utils";

export interface HarnessLedgerHistoryProps {
  entries: HarnessLedgerEntry[];
  onEvaluate?: (entryId: string) => void;
  evaluatingId?: string | null;
}

const PILL = "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px]";
const MAX_ROWS = 8;

const DECISION_STYLE: Record<HarnessLedgerEntry["decision"], string> = {
  approved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  rejected: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  deferred: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

const VERDICT_STYLE = {
  winner: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  rejected: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  pending: "border-border bg-muted/40 text-muted-foreground",
} as const;

type VerdictLabel = keyof typeof VERDICT_STYLE;

function verdictLabel(entry: HarnessLedgerEntry): VerdictLabel {
  if (!entry.evaluatedAt || entry.verdict == null) return "pending";
  return entry.verdict === "winner" ? "winner" : "rejected";
}

const fmtScoreDelta = (v: number | null) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(3)}`;

const fmtCostDelta = (v: number | null) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

export function HarnessLedgerHistory({
  entries,
  onEvaluate,
  evaluatingId = null,
}: HarnessLedgerHistoryProps) {
  const rows = entries.slice(0, MAX_ROWS);
  return (
    <section aria-label="Harness ledger history" className="space-y-2 border-t border-border/60 pt-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Ledger History
      </h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No ledger decisions recorded yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((entry) => {
            const verdict = verdictLabel(entry);
            const canEvaluate =
              entry.decision === "approved" && !entry.evaluatedAt && onEvaluate !== undefined;
            return (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5"
              >
                <span className={cn(PILL, "font-medium", DECISION_STYLE[entry.decision])}>
                  {entry.decision}
                </span>
                <span className={cn(PILL, "border-border bg-background font-mono text-muted-foreground")}>
                  {entry.component.replace(/_/g, " ")}
                </span>
                <span className="text-[11px] font-mono text-muted-foreground">{`R${entry.round}`}</span>
                <span className={cn(PILL, "font-medium", VERDICT_STYLE[verdict])}>
                  {verdict}
                </span>
                {entry.evaluatedAt && (
                  <span className="text-[11px] font-mono text-muted-foreground">
                    {`Δscore ${fmtScoreDelta(entry.deltaScore)} · Δcost ${fmtCostDelta(entry.deltaCost)}`}
                  </span>
                )}
                {canEvaluate && (
                  <button
                    type="button"
                    disabled={evaluatingId === entry.id}
                    onClick={() => onEvaluate(entry.id)}
                    className="ml-auto rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    Evaluate
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
