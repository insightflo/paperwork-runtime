import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MissionCostLedgerCard, type MissionCostLedgerView } from "../MissionCostLedgerCard";

function makeLedger(overrides: Partial<MissionCostLedgerView> = {}): MissionCostLedgerView {
  return {
    totalRuns: 5,
    freeTierRuns: 3,
    paidRuns: 2,
    totalCostUsd: 1.23,
    totalTokens: 15200,
    byAdapter: [
      {
        adapterType: "devin_local",
        runCount: 3,
        freeTierRuns: 3,
        totalCostUsd: 0,
        totalTokens: 9000,
      },
      {
        adapterType: "claude_local",
        runCount: 2,
        freeTierRuns: 0,
        totalCostUsd: 1.23,
        totalTokens: 6200,
      },
    ],
    ...overrides,
  };
}

describe("MissionCostLedgerCard", () => {
  it("renders nothing when the ledger is missing or has no runs", () => {
    expect(renderToStaticMarkup(<MissionCostLedgerCard ledger={null} />)).toBe("");
    expect(renderToStaticMarkup(<MissionCostLedgerCard ledger={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<MissionCostLedgerCard ledger={makeLedger({ totalRuns: 0 })} />)).toBe("");
  });

  it("renders totals and adapter breakdown rows", () => {
    const html = renderToStaticMarkup(<MissionCostLedgerCard ledger={makeLedger()} />);

    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="어댑터별 비용 원장"');
    expect(html).toContain('data-testid="mission-cost-ledger-card"');
    expect(html).toContain("총 실행 5건");
    expect(html).toContain("무료 티어 3건");
    expect(html).toContain("유료 실행 2건");
    expect(html).toContain("총 비용 $1.23");
    expect(html).toContain("총 토큰 15,200");
    expect(html).toContain("devin_local");
    expect(html).toContain("claude_local");
    expect(html).toContain("$0.00");
    expect(html).toContain("$1.23");
    expect(html).toContain("9,000");
    expect(html).toContain("6,200");
    expect(html).toContain("tabular-nums");
  });
});
