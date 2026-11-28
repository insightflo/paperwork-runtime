export interface AdapterCostRowView {
  adapterType: string;
  runCount: number;
  freeTierRuns: number;
  totalCostUsd: number;
  totalTokens: number;
}

export interface MissionCostLedgerView {
  totalRuns: number;
  freeTierRuns: number;
  paidRuns: number;
  totalCostUsd: number;
  totalTokens: number;
  byAdapter: AdapterCostRowView[];
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const countFormatter = new Intl.NumberFormat("en-US");

function formatUsd(value: number): string {
  return usdFormatter.format(value);
}

function formatCount(value: number): string {
  return countFormatter.format(value);
}

export function MissionCostLedgerCard({ ledger }: { ledger: MissionCostLedgerView | null | undefined }) {
  if (!ledger || ledger.totalRuns <= 0) return null;

  const summaryItems = [
    `총 실행 ${formatCount(ledger.totalRuns)}건`,
    `무료 티어 ${formatCount(ledger.freeTierRuns)}건`,
    `유료 실행 ${formatCount(ledger.paidRuns)}건`,
    `총 비용 ${formatUsd(ledger.totalCostUsd)}`,
    `총 토큰 ${formatCount(ledger.totalTokens)}`,
  ];

  return (
    <section
      role="region"
      aria-label="어댑터별 비용 원장"
      data-testid="mission-cost-ledger-card"
      className="rounded-xl border border-border bg-card p-3 text-card-foreground shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.12em] text-muted-foreground">미션 비용 원장</p>
          <h3 className="mt-1 text-sm font-semibold text-foreground">어댑터 실행 비용</h3>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
          {`어댑터 ${formatCount(ledger.byAdapter.length)}개`}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5" aria-label="비용 실행 요약">
        {summaryItems.map((item) => (
          <span key={item} className="rounded-md border border-border/70 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground tabular-nums">
            {item}
          </span>
        ))}
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-border/70">
        <table className="w-full min-w-[520px] border-collapse text-left text-xs tabular-nums">
          <caption className="sr-only">어댑터별 실행 수, 무료 티어 실행 수, 비용, 토큰</caption>
          <thead className="bg-muted/60 text-muted-foreground">
            <tr className="border-b border-border/70">
              <th scope="col" className="px-2.5 py-2 font-medium">어댑터</th>
              <th scope="col" className="px-2.5 py-2 text-right font-medium">실행</th>
              <th scope="col" className="px-2.5 py-2 text-right font-medium">무료</th>
              <th scope="col" className="px-2.5 py-2 text-right font-medium">유료</th>
              <th scope="col" className="px-2.5 py-2 text-right font-medium">비용</th>
              <th scope="col" className="px-2.5 py-2 text-right font-medium">토큰</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {ledger.byAdapter.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-2.5 py-3 text-center text-muted-foreground">
                  어댑터 집계가 없습니다.
                </td>
              </tr>
            ) : (
              ledger.byAdapter.map((row) => {
                const paidRuns = Math.max(0, row.runCount - row.freeTierRuns);
                return (
                  <tr key={row.adapterType} data-adapter-type={row.adapterType} className="tabular-nums">
                    <th scope="row" className="max-w-0 truncate px-2.5 py-2 font-mono font-medium text-foreground">
                      {row.adapterType}
                    </th>
                    <td className="px-2.5 py-2 text-right text-foreground">{formatCount(row.runCount)}</td>
                    <td className="px-2.5 py-2 text-right text-muted-foreground">{formatCount(row.freeTierRuns)}</td>
                    <td className="px-2.5 py-2 text-right text-muted-foreground">{formatCount(paidRuns)}</td>
                    <td className="px-2.5 py-2 text-right font-medium text-foreground">{formatUsd(row.totalCostUsd)}</td>
                    <td className="px-2.5 py-2 text-right text-muted-foreground">{formatCount(row.totalTokens)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
