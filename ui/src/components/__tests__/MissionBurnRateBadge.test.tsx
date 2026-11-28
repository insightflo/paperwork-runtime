import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type BurnRateVerdict,
  formatBurnRateVerdictLabel,
  MissionBurnRateBadge,
  type MissionBurnRateBadgeProps,
} from "../MissionBurnRateBadge";

function renderBadge(props: Partial<MissionBurnRateBadgeProps> = {}) {
  const merged: MissionBurnRateBadgeProps = {
    verdict: "normal",
    utilizationPercent: 42,
    burnUsdPerHour: 1.25,
    ...props,
  };
  return renderToStaticMarkup(<MissionBurnRateBadge {...merged} />);
}

describe("formatBurnRateVerdictLabel", () => {
  it("formats every burn-rate verdict label", () => {
    const expectations: Array<[BurnRateVerdict, string]> = [
      ["normal", "예산 정상"],
      ["elevated", "소진 주의"],
      ["critical_throttle", "스로틀 권고"],
      ["budget_exhausted", "예산 소진"],
    ];

    for (const [verdict, label] of expectations) {
      expect(formatBurnRateVerdictLabel(verdict)).toBe(label);
    }
  });
});

describe("MissionBurnRateBadge", () => {
  it("renders normal verdicts in a status live region", () => {
    const html = renderBadge({ verdict: "normal" });

    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("예산 정상");
    expect(html).toContain("42%");
  });

  it("renders budget exhaustion as an alert", () => {
    const html = renderBadge({ verdict: "budget_exhausted", utilizationPercent: 100 });

    expect(html).toContain('role="alert"');
    expect(html).toContain("예산 소진");
  });

  it("displays projected runway minutes when present", () => {
    const html = renderBadge({ projectedRunwayMinutes: 37 });

    expect(html).toContain("잔여 37분");
  });

  it("omits projected runway minutes when absent", () => {
    const html = renderBadge({ projectedRunwayMinutes: null });

    expect(html).not.toContain("잔여");
  });

  it("clamps utilization percent to the 0-100 range", () => {
    expect(renderBadge({ utilizationPercent: 145 })).toContain("100%");
    expect(renderBadge({ utilizationPercent: -8 })).toContain("0%");
  });
});
