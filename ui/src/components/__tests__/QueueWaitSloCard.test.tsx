// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  formatLatencyMs,
  formatQueueLaneLabel,
  QueueWaitSloCard,
  type LaneWaitSloRow,
} from "../QueueWaitSloCard";

function makeRow(overrides: Partial<LaneWaitSloRow> = {}): LaneWaitSloRow {
  return {
    lane: "interactive",
    count: 12,
    p50Ms: 2_000,
    p95Ms: 45_000,
    p99Ms: 50_000,
    maxMs: 55_000,
    sloTargetMs: 30_000,
    breached: true,
    ...overrides,
  };
}

function render(rows: readonly LaneWaitSloRow[]): string {
  return renderToStaticMarkup(<QueueWaitSloCard rows={rows} />);
}

describe("formatQueueLaneLabel", () => {
  it.each([
    ["interactive", "대화형"],
    ["recovery", "복구"],
    ["workflow", "워크플로"],
    ["scheduled", "예약"],
  ] as const)("formats %s as %s", (lane, label) => {
    expect(formatQueueLaneLabel(lane)).toBe(label);
  });
});

describe("formatLatencyMs", () => {
  it("formats sub-second latency as <1초", () => {
    expect(formatLatencyMs(0)).toBe("<1초");
    expect(formatLatencyMs(999)).toBe("<1초");
  });

  it("formats second-scale latency in seconds", () => {
    expect(formatLatencyMs(1_000)).toBe("1초");
    expect(formatLatencyMs(45_000)).toBe("45초");
  });

  it("formats minute-scale latency in minutes and seconds", () => {
    expect(formatLatencyMs(61_000)).toBe("1분 1초");
    expect(formatLatencyMs(95_000)).toBe("1분 35초");
    expect(formatLatencyMs(600_000)).toBe("10분");
  });
});

describe("QueueWaitSloCard", () => {
  it("renders null for an empty row set", () => {
    expect(render([])).toBe("");
  });

  it("renders lane labels, counts, latency metrics, and target values", () => {
    const html = render([makeRow()]);

    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="레인별 대기 시간 SLO"');
    expect(html).toContain('data-testid="queue-wait-slo-card"');
    expect(html).toContain("대화형");
    expect(html).toContain("샘플 12건");
    expect(html).toContain("p50");
    expect(html).toContain("2초");
    expect(html).toContain("p95");
    expect(html).toContain("45초");
    expect(html).toContain("목표");
    expect(html).toContain("30초");
  });

  it("renders an SLO 초과 badge when the lane is breached", () => {
    const html = render([makeRow({ breached: true })]);

    expect(html).toContain("SLO 초과");
    expect(html).toContain("border-destructive/35");
    expect(html).toContain("tabular-nums");
  });

  it("renders a 정상 badge when the lane is within target", () => {
    const html = render([makeRow({ breached: false, p95Ms: 20_000 })]);

    expect(html).toContain("정상");
    expect(html).not.toContain("SLO 초과");
  });
});
