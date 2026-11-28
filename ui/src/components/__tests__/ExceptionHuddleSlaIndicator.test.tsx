// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ExceptionHuddleSlaIndicator,
  formatDurationShort,
  type ExceptionHuddleSlaIndicatorProps,
  type ExceptionHuddleSlaUrgency,
} from "../ExceptionHuddleSlaIndicator";

const baseProps: ExceptionHuddleSlaIndicatorProps = {
  urgencyLevel: "normal",
  isBreached: false,
  elapsedMs: 180_000,
  remainingBudgetMs: 240_000,
};

function render(overrides: Partial<ExceptionHuddleSlaIndicatorProps> = {}): string {
  return renderToStaticMarkup(<ExceptionHuddleSlaIndicator {...baseProps} {...overrides} />);
}

describe("formatDurationShort", () => {
  it("clamps zero and negative durations to 0s", () => {
    expect(formatDurationShort(0)).toBe("0s");
    expect(formatDurationShort(-1)).toBe("0s");
    expect(formatDurationShort(-60_000)).toBe("0s");
  });

  it("formats seconds-only durations below one minute", () => {
    expect(formatDurationShort(1_000)).toBe("1s");
    expect(formatDurationShort(45_000)).toBe("45s");
    expect(formatDurationShort(59_999)).toBe("59s");
  });

  it("formats exact minutes without a seconds suffix", () => {
    expect(formatDurationShort(60_000)).toBe("1m");
    expect(formatDurationShort(240_000)).toBe("4m");
  });

  it("formats minutes plus seconds", () => {
    expect(formatDurationShort(61_000)).toBe("1m 1s");
    expect(formatDurationShort(95_000)).toBe("1m 35s");
    expect(formatDurationShort(200_000)).toBe("3m 20s");
  });
});

describe("ExceptionHuddleSlaIndicator", () => {
  const urgencyCases: Array<{ urgencyLevel: ExceptionHuddleSlaUrgency; label: string }> = [
    { urgencyLevel: "normal", label: "정상" },
    { urgencyLevel: "warning", label: "주의" },
    { urgencyLevel: "critical", label: "긴급" },
    { urgencyLevel: "settled", label: "완료" },
  ];

  it.each(urgencyCases)("renders the $urgencyLevel urgency level with a descriptive aria-label", ({ urgencyLevel, label }) => {
    const html = render({ urgencyLevel });

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Exception huddle SLA:');
    expect(html).toContain(`data-urgency-level="${urgencyLevel}"`);
    expect(html).toContain(label);
    expect(html).toContain(`(${urgencyLevel})`);
  });

  it("shows remaining budget time for active urgency levels", () => {
    const activeLevels: ExceptionHuddleSlaUrgency[] = ["normal", "warning", "critical"];

    for (const urgencyLevel of activeLevels) {
      const html = render({ urgencyLevel, remainingBudgetMs: 95_000 });
      expect(html).toContain("남은 시간 1m 35s");
      expect(html).toContain("remaining budget 1m 35s");
      expect(html).not.toContain("소요 1m 35s");
    }
  });

  it("shows elapsed time instead of remaining budget when settled", () => {
    const html = render({ urgencyLevel: "settled", elapsedMs: 200_000, remainingBudgetMs: 0 });

    expect(html).toContain("완료");
    expect(html).toContain("소요 3m 20s");
    expect(html).toContain("elapsed time 3m 20s");
    expect(html).not.toContain("남은 시간");
  });

  it("renders the SLA breach tag only when breached", () => {
    const breached = render({ urgencyLevel: "critical", isBreached: true, remainingBudgetMs: 30_000 });
    expect(breached).toContain("SLA 초과");
    expect(breached).toContain("SLA breached");

    const unbreached = render({ urgencyLevel: "critical", isBreached: false, remainingBudgetMs: 30_000 });
    expect(unbreached).not.toContain("SLA 초과");
    expect(unbreached).not.toContain("SLA breached");
  });

  it("uses semantic huddle color tokens for each urgency level", () => {
    expect(render({ urgencyLevel: "normal" })).toContain("dark:text-[#60a5fa]");
    expect(render({ urgencyLevel: "warning" })).toContain("dark:text-[#f59e0b]");
    expect(render({ urgencyLevel: "critical" })).toContain("dark:text-red-200");
    expect(render({ urgencyLevel: "settled" })).toContain("dark:text-[#a3e635]");
  });

  it("merges a caller-provided className", () => {
    expect(render({ className: "ml-2 shrink-0" })).toContain("ml-2 shrink-0");
  });
});
