import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FleetFairnessBadge, formatFairnessRatingLabel } from "../FleetFairnessBadge";

function html(props: Parameters<typeof FleetFairnessBadge>[0]) {
  return renderToStaticMarkup(<FleetFairnessBadge {...props} />);
}

describe("formatFairnessRatingLabel", () => {
  it.each([
    ["balanced", "분배 균형"],
    ["skewed", "분배 편중"],
    ["monopolized", "슬롯 독점"],
  ] as const)("returns the Korean label for %s", (rating, label) => {
    expect(formatFairnessRatingLabel(rating)).toBe(label);
  });
});

describe("FleetFairnessBadge", () => {
  it.each([
    [-0.25, "0%"],
    [0.876, "88%"],
    [1.2, "100%"],
  ] as const)("clamps Jain index %f before rendering %s", (jainIndex, percent) => {
    const markup = html({ jainIndex, rating: "balanced" });

    expect(markup).toContain(`>분배 균형 ${percent}<`);
    expect(markup).toContain("tabular-nums");
  });

  it("omits the starved suffix when starvedCount is zero", () => {
    const markup = html({ jainIndex: 0.5, rating: "skewed", starvedCount: 0 });

    expect(markup).toContain("분배 편중 50%");
    expect(markup).not.toContain("· 기아");
  });

  it("renders the starved count when starvedCount is positive", () => {
    const markup = html({ jainIndex: 0.42, rating: "monopolized", starvedCount: 3 });

    expect(markup).toContain("슬롯 독점 42% · 기아 3명");
  });

  it("sets a status role and accessible aria-label", () => {
    const markup = html({ jainIndex: 0.64, rating: "skewed", starvedCount: 2 });

    expect(markup).toContain('role="status"');
    expect(markup).toContain(
      'aria-label="슬롯 분배 공정성: 분배 편중, Jain 지수 64%, 기아 에이전트 2명"',
    );
  });
});
