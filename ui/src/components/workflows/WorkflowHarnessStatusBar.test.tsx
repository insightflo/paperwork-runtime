// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowHarnessStatusBar, formatIdleDuration, formatSuccessRate } from "./WorkflowHarnessStatusBar";

function render(props: Parameters<typeof WorkflowHarnessStatusBar>[0]): string {
  return renderToStaticMarkup(<WorkflowHarnessStatusBar {...props} />);
}

describe("WorkflowHarnessStatusBar", () => {
  it("renders the stall watchdog in every state with idle duration", () => {
    const healthy = render({ stallStatus: "healthy", idleMs: 4_200 });
    expect(healthy).toContain('data-stall-status="healthy"');
    expect(healthy).toContain("HEALTHY");
    expect(healthy).toContain("idle 4.2s");
    expect(healthy).not.toContain("animate-pulse");

    const stalled = render({ stallStatus: "stalled", idleMs: 83_000 });
    expect(stalled).toContain('data-stall-status="stalled"');
    expect(stalled).toContain("STALLED");
    expect(stalled).toContain("animate-pulse");
    expect(stalled).toContain("idle 1m 23s");

    const timedOut = render({ stallStatus: "timed_out", idleMs: 3_725_000 });
    expect(timedOut).toContain('data-stall-status="timed_out"');
    expect(timedOut).toContain("TIMED OUT");
    expect(timedOut).toContain("idle 1h 02m");
  });

  it("renders the probability-gated routing pill for each route", () => {
    expect(render({ route: "sharp" })).toContain("SHARP");
    expect(render({ route: "split" })).toContain("SPLIT");
    expect(render({ route: "escalate" })).toContain("ESCALATE");
    expect(render({})).not.toContain("SHARP");
  });

  it("renders advisor gates with pass, challenge, and pending verdicts", () => {
    const pass = render({ advisorGate: { gate: "g1", verdict: "pass", reason: "plan accepted" } });
    expect(pass).toContain("G1 PLAN");
    expect(pass).toContain('data-verdict="pass"');
    expect(pass).toContain("✓ PASS");
    expect(pass).toContain("plan accepted");

    const challenge = render({ advisorGate: { gate: "g2", verdict: "challenge", reason: "missing repro" } });
    expect(challenge).toContain("G2 ERROR");
    expect(challenge).toContain('data-verdict="challenge"');
    expect(challenge).toContain("! CHALLENGE");
    expect(challenge).toContain('title="missing repro"');

    const pending = render({ advisorGate: { gate: "g3", verdict: "pending" } });
    expect(pending).toContain("G3 CLOSEOUT");
    expect(pending).toContain('data-verdict="pending"');
    expect(pending).toContain("○ PENDING");

    expect(render({ advisorGate: null })).toContain("no gate");
    expect(render({})).toContain("no gate");
  });

  it("renders rolling reliability with tabular numerals and an em dash when unknown", () => {
    const known = render({ successRatePct: 87.5 });
    expect(known).toContain("87.5%");
    expect(known).toContain('aria-label="Rolling reliability 87.5%"');
    expect(known).toContain("tabular-nums");
    expect(render({ successRatePct: 92 })).toContain("92%");
    expect(render({ successRatePct: null })).toContain("—");
    expect(render({})).toContain("—");
  });

  it("uses the Combo 1 tactile card surface in both color schemes", () => {
    const html = render({ route: "sharp", stallStatus: "healthy", advisorGate: { gate: "g1", verdict: "pass" }, successRatePct: 80 });
    expect(html).toContain("tactile-card");
    expect(html).toContain("dark:bg-[#0e131d]");
    expect(html).toContain("dark:bg-[#090c12]");
    expect(html).toContain("inset_0_1px_0");
    expect(html).toContain('aria-label="Workflow harness status"');
  });
});

describe("formatIdleDuration", () => {
  it("formats sub-second, second, minute, and hour windows", () => {
    expect(formatIdleDuration(undefined)).toBe("0s");
    expect(formatIdleDuration(0)).toBe("0s");
    expect(formatIdleDuration(-500)).toBe("0s");
    expect(formatIdleDuration(250)).toBe("0.3s");
    expect(formatIdleDuration(9_940)).toBe("9.9s");
    expect(formatIdleDuration(10_000)).toBe("10s");
    expect(formatIdleDuration(59_999)).toBe("59s");
    expect(formatIdleDuration(60_000)).toBe("1m 00s");
    expect(formatIdleDuration(3_599_000)).toBe("59m 59s");
    expect(formatIdleDuration(3_600_000)).toBe("1h 00m");
    expect(formatIdleDuration(90_000_000)).toBe("25h 00m");
  });
});

describe("formatSuccessRate", () => {
  it("clamps and formats percentages, falling back to an em dash", () => {
    expect(formatSuccessRate(null)).toBe("—");
    expect(formatSuccessRate(Number.NaN)).toBe("—");
    expect(formatSuccessRate(0)).toBe("0%");
    expect(formatSuccessRate(100)).toBe("100%");
    expect(formatSuccessRate(140)).toBe("100%");
    expect(formatSuccessRate(-3)).toBe("0%");
    expect(formatSuccessRate(66.666)).toBe("66.7%");
  });
});
