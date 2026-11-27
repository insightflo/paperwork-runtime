import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatStallIdleMs, WorkflowStallStatusBadge } from "./WorkflowStallStatusBadge";

function html(props: Parameters<typeof WorkflowStallStatusBadge>[0]) {
  return renderToStaticMarkup(<WorkflowStallStatusBadge {...props} />);
}

describe("WorkflowStallStatusBadge", () => {
  it.each([
    ["healthy", "정상"],
    ["stalled", "지연"],
    ["timed_out", "시간 초과"],
  ] as const)("renders the %s state with its Korean label and aria-label", (status, label) => {
    const markup = html({ stallStatus: status });

    expect(markup).toContain(label);
    expect(markup).toContain(`aria-label="워크플로우 상태: ${label}"`);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("tabular-nums");
    expect(markup).toContain("dark:");
  });

  it("omits the idle text when idleMs is not provided", () => {
    expect(html({ stallStatus: "healthy" })).not.toContain("0s");
  });

  it.each([
    ["stalled", "지연"],
    ["timed_out", "시간 초과"],
  ] as const)("includes formatted idle time in the aria-label for %s", (status, label) => {
    const markup = html({ stallStatus: status, idleMs: 45_000 });

    expect(markup).toContain(`aria-label="워크플로우 상태: ${label}, 대기 45s"`);
    expect(markup).toContain(">45s<");
  });
});

describe("formatStallIdleMs", () => {
  it.each([
    [0, "0s"],
    [999, "0s"],
    [-5_000, "0s"],
    [Number.NaN, "0s"],
    [Number.POSITIVE_INFINITY, "0s"],
    [45_000, "45s"],
    [312_000, "5m 12s"],
    [3_720_000, "1h 2m"],
    [60_000, "1m 0s"],
    [3_600_000, "1h 0m"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatStallIdleMs(ms)).toBe(expected);
  });

  it("clamps undefined to 0s", () => {
    expect(formatStallIdleMs(undefined)).toBe("0s");
  });
});
