// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatEstimatedCostLabel, RunCostEstimatePill } from "../RunCostEstimatePill";

describe("formatEstimatedCostLabel", () => {
  it("returns the free-tier label before inspecting the cost value", () => {
    expect(formatEstimatedCostLabel(12.34, true)).toBe("무료 티어 ($0)");
    expect(formatEstimatedCostLabel(null, true)).toBe("무료 티어 ($0)");
  });

  it("returns the unaggregated label for missing or non-finite costs", () => {
    expect(formatEstimatedCostLabel(null)).toBe("비용 미집계");
    expect(formatEstimatedCostLabel(undefined)).toBe("비용 미집계");
    expect(formatEstimatedCostLabel(Number.NaN)).toBe("비용 미집계");
    expect(formatEstimatedCostLabel(Number.POSITIVE_INFINITY)).toBe("비용 미집계");
  });

  it("uses the sub-cent label for positive costs below one cent", () => {
    expect(formatEstimatedCostLabel(0)).toBe("<$0.01");
    expect(formatEstimatedCostLabel(0.001)).toBe("<$0.01");
    expect(formatEstimatedCostLabel(0.0099)).toBe("<$0.01");
  });

  it("formats normal USD amounts with two decimal places", () => {
    expect(formatEstimatedCostLabel(0.01)).toBe("$0.01");
    expect(formatEstimatedCostLabel(1.2)).toBe("$1.20");
    expect(formatEstimatedCostLabel(12.345)).toBe("$12.35");
  });
});

describe("RunCostEstimatePill", () => {
  it("renders the formatted cost and an accessible aria-label including the model", () => {
    const html = renderToStaticMarkup(
      <RunCostEstimatePill costUsd={1.234} model="swe-2-flash-free" />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="예상 실행 비용: $1.23, 모델: swe-2-flash-free"');
    expect(html).toContain("예상 비용");
    expect(html).toContain("$1.23");
    expect(html).toContain("tabular-nums");
  });

  it("renders the free-tier indicator and omits the model when it is not provided", () => {
    const html = renderToStaticMarkup(<RunCostEstimatePill costUsd={null} freeTier />);

    expect(html).toContain('aria-label="예상 실행 비용: 무료 티어 ($0)"');
    expect(html).toContain("무료 티어 ($0)");
    expect(html).not.toContain("모델:");
  });

  it("merges a caller-provided className", () => {
    const html = renderToStaticMarkup(
      <RunCostEstimatePill costUsd={2} className="ml-2 shrink-0" />,
    );

    expect(html).toContain("ml-2 shrink-0");
  });
});
