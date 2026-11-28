import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  formatResumeStrategyLabel,
  RunResumeStrategyBadge,
  type RunResumeStrategyBadgeProps,
  type ResumeStrategy,
} from "../RunResumeStrategyBadge";

function html(props: RunResumeStrategyBadgeProps) {
  return renderToStaticMarkup(<RunResumeStrategyBadge {...props} />);
}

describe("formatResumeStrategyLabel", () => {
  it.each([
    ["resume_session", "세션 재개"],
    ["fresh_with_carryover", "체크포인트 이어받기"],
    ["escalate_operator", "운영자 확인 필요"],
  ] as const)("formats %s as %s", (strategy: ResumeStrategy, expected: string) => {
    expect(formatResumeStrategyLabel(strategy)).toBe(expected);
  });
});

describe("RunResumeStrategyBadge", () => {
  it("renders the formatted label, attempt progress, and accessible aria-label", () => {
    const markup = html({
      strategy: "fresh_with_carryover",
      attempt: 2,
      maxAttempts: 5,
      reason: "실행 컨텍스트가 초기화됨",
    });

    expect(markup).toContain("체크포인트 이어받기");
    expect(markup).toContain("2/5회");
    expect(markup).toContain('role="status"');
    expect(markup).toContain(
      'aria-label="재개 전략: 체크포인트 이어받기, 시도 2/5회, 사유: 실행 컨텍스트가 초기화됨"',
    );
    expect(markup).toContain("tabular-nums");
  });

  it("uses three as the default maximum attempt count", () => {
    const markup = html({ strategy: "resume_session", attempt: 1 });

    expect(markup).toContain("1/3회");
    expect(markup).toContain('aria-label="재개 전략: 세션 재개, 시도 1/3회"');
  });

  it("renders the operator escalation strategy", () => {
    const markup = html({ strategy: "escalate_operator", attempt: 3, maxAttempts: 3 });

    expect(markup).toContain("운영자 확인 필요");
    expect(markup).toContain("3/3회");
    expect(markup).toContain('aria-label="재개 전략: 운영자 확인 필요, 시도 3/3회"');
  });
});
