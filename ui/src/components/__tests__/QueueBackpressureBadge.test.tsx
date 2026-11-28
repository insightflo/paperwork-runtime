// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  formatBackpressureLabel,
  QueueBackpressureBadge,
  type BackpressureReason,
} from "../QueueBackpressureBadge";

function render(props: Parameters<typeof QueueBackpressureBadge>[0]): string {
  return renderToStaticMarkup(<QueueBackpressureBadge {...props} />);
}

const REASON_LABELS: ReadonlyArray<[BackpressureReason, string]> = [
  ["ok", "유입 정상"],
  ["always_admit_priority_lane", "우선 레인 허용"],
  ["scheduled_backpressure_shed", "예약 유입 제한"],
  ["workflow_backpressure_shed", "워크플로 유입 제한"],
];

describe("formatBackpressureLabel", () => {
  it.each(REASON_LABELS)("formats %s as %s", (reason, label) => {
    expect(formatBackpressureLabel(reason)).toBe(label);
  });
});

describe("QueueBackpressureBadge", () => {
  it("renders a finite queue-to-high-water ratio", () => {
    const html = render({ reason: "ok", currentQueuedCount: 7, highWaterMark: 40 });

    expect(html).toContain("유입 정상");
    expect(html).toContain("7/40");
    expect(html).toContain("tabular-nums");
  });

  it("omits the infinite high-water mark for priority-lane admission", () => {
    const html = render({
      reason: "always_admit_priority_lane",
      currentQueuedCount: 3,
      highWaterMark: Number.POSITIVE_INFINITY,
    });

    expect(html).toContain("우선 레인 허용");
    expect(html).toContain(">3</span>");
    expect(html).not.toContain("/Infinity");
    expect(html).not.toContain("/∞");
  });

  it("sets an accessible status label with the reason and ratio", () => {
    const html = render({ reason: "scheduled_backpressure_shed", currentQueuedCount: 11, highWaterMark: 12 });

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="큐 유입 상태: 예약 유입 제한, 대기 11/12"');
  });
});
