import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  formatCoalesceSummary,
  WakeupCoalesceBadge,
  type CoalesceLane,
} from "../WakeupCoalesceBadge";

describe("formatCoalesceSummary", () => {
  it.each([0, 1])("returns an empty summary when the count is %i", (coalescedCount) => {
    expect(formatCoalesceSummary(coalescedCount)).toBe("");
  });

  it("formats a merged duplicate-request count above one", () => {
    expect(formatCoalesceSummary(2)).toBe("중복 요청 2건 병합");
    expect(formatCoalesceSummary(7)).toBe("중복 요청 7건 병합");
  });
});

describe("WakeupCoalesceBadge", () => {
  it.each([0, 1])("renders nothing when the count is %i", (coalescedCount) => {
    const html = renderToStaticMarkup(
      <WakeupCoalesceBadge coalescedCount={coalescedCount} lane="interactive" />,
    );

    expect(html).toBe("");
  });

  it("renders the coalesced text, lane, window, and accessible status label", () => {
    const html = renderToStaticMarkup(
      <WakeupCoalesceBadge coalescedCount={4} lane="workflow" windowSec={12} />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("중복 요청 4건 병합");
    expect(html).toContain("워크플로");
    expect(html).toContain("12초 창");
    expect(html).toContain('aria-label="중복 요청 4건 병합 · 워크플로 우선순위 레인 유지 · 12초 창"');
    expect(html).toContain("tabular-nums");
  });

  it.each([
    ["interactive", "대화형"],
    ["recovery", "복구"],
    ["workflow", "워크플로"],
    ["scheduled", "예약"],
  ] as ReadonlyArray<[CoalesceLane, string]>)(
    "includes the Korean lane label for %s in the aria-label",
    (lane, laneLabel) => {
      const html = renderToStaticMarkup(<WakeupCoalesceBadge coalescedCount={3} lane={lane} />);

      expect(html).toContain(`aria-label="중복 요청 3건 병합 · ${laneLabel} 우선순위 레인 유지"`);
      expect(html).toContain(`data-lane="${lane}"`);
    },
  );
});
