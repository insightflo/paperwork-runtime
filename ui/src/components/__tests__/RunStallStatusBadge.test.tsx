// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RunStallStatusBadge,
  formatIdleDuration,
  formatStallVerdictLabel,
  type RunStallStatusBadgeProps,
  type RunStallVerdict,
} from "../RunStallStatusBadge";

const baseProps: RunStallStatusBadgeProps = {
  verdict: "active",
  idleMs: 60_000,
};

function render(overrides: Partial<RunStallStatusBadgeProps> = {}): string {
  return renderToStaticMarkup(<RunStallStatusBadge {...baseProps} {...overrides} />);
}

describe("formatStallVerdictLabel", () => {
  it("maps every verdict to its Korean status label", () => {
    expect(formatStallVerdictLabel("active")).toBe("정상 실행");
    expect(formatStallVerdictLabel("slow_tool_grace")).toBe("도구 대기 중");
    expect(formatStallVerdictLabel("stalled")).toBe("응답 지연");
  });
});

describe("formatIdleDuration", () => {
  it("formats sub-minute and negative idle durations as less than one minute", () => {
    expect(formatIdleDuration(0)).toBe("<1분");
    expect(formatIdleDuration(30_000)).toBe("<1분");
    expect(formatIdleDuration(59_999)).toBe("<1분");
    expect(formatIdleDuration(-1)).toBe("<1분");
  });

  it("formats idle durations as whole elapsed minutes", () => {
    expect(formatIdleDuration(60_000)).toBe("1분");
    expect(formatIdleDuration(119_999)).toBe("1분");
    expect(formatIdleDuration(300_000)).toBe("5분");
  });
});

describe("RunStallStatusBadge", () => {
  const verdictCases: Array<{ verdict: RunStallVerdict; label: string; token: string }> = [
    { verdict: "active", label: "정상 실행", token: "--pw-token-success" },
    { verdict: "slow_tool_grace", label: "도구 대기 중", token: "--pw-token-warning" },
    { verdict: "stalled", label: "응답 지연", token: "--pw-token-danger" },
  ];

  it.each(verdictCases)(
    "renders the $verdict verdict with an accessible status label and semantic token classes",
    ({ verdict, label, token }) => {
      const html = render({ verdict, idleMs: 60_000 });

      expect(html).toContain('role="status"');
      expect(html).toContain(`data-verdict="${verdict}"`);
      expect(html).toContain(`실행 상태: ${label}; 출력 없는 시간 1분`);
      expect(html).toContain(label);
      expect(html).toContain("1분");
      expect(html).toContain("tabular-nums");
      expect(html).toContain(`bg-[var(${token}-soft)]`);
      expect(html).toContain(`text-[var(${token}-text)]`);
    },
  );

  it("merges a caller-provided className", () => {
    expect(render({ className: "ml-2 shrink-0" })).toContain("ml-2 shrink-0");
  });
});
