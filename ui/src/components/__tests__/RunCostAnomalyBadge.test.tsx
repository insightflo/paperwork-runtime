import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatCostAnomalyRatio, RunCostAnomalyBadge } from "../RunCostAnomalyBadge";

const baseProps = {
  ratioToMedian: 4.24,
  baselineMedianUsd: 0.3,
  currentCostUsd: 1.272,
};

describe("formatCostAnomalyRatio", () => {
  it("formats finite ratios with one decimal place", () => {
    expect(formatCostAnomalyRatio(4.24)).toBe("4.2x");
    expect(formatCostAnomalyRatio(2)).toBe("2.0x");
  });

  it("labels non-finite ratios as new high-cost runs", () => {
    expect(formatCostAnomalyRatio(Infinity)).toBe("신규 고비용");
    expect(formatCostAnomalyRatio(Number.NaN)).toBe("신규 고비용");
  });
});

describe("RunCostAnomalyBadge", () => {
  it("returns null when the run is not an anomaly", () => {
    const html = renderToStaticMarkup(<RunCostAnomalyBadge {...baseProps} isAnomaly={false} />);

    expect(html).toBe("");
  });

  it("renders an alert with the formatted ratio and cost context", () => {
    const html = renderToStaticMarkup(<RunCostAnomalyBadge {...baseProps} isAnomaly />);

    expect(html).toContain('role="alert"');
    expect(html).toContain("비용 급증 4.2x");
    expect(html).toContain("tabular-nums");
    expect(html).toContain("$1.272");
    expect(html).toContain("$0.30");
  });
});
