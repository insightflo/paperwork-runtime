import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkflowAdvisorGateBadge, type WorkflowAdvisorGate } from "./WorkflowAdvisorGateBadge";

const STATES: ReadonlyArray<{ readonly gate: WorkflowAdvisorGate; readonly label: string; readonly tone: string }> = [
  { gate: "g1_pending", label: "G1 검토 대기", tone: "pending" },
  { gate: "g2_challenge", label: "G2 자문 반려", tone: "challenge" },
  { gate: "g3_pass", label: "G3 통과", tone: "pass" },
  { gate: "none", label: "게이트 없음", tone: "none" },
];

function render(gate: WorkflowAdvisorGate, compact = false) {
  return renderToStaticMarkup(<WorkflowAdvisorGateBadge advisorGate={gate} compact={compact} />);
}

describe("WorkflowAdvisorGateBadge", () => {
  it.each(STATES)("renders the Korean label and aria-label for $gate", ({ gate, label, tone }) => {
    const html = render(gate);

    expect(html).toContain(label);
    expect(html).toContain(`aria-label="자문 게이트: ${label}"`);
    expect(html).toContain(`title="자문 게이트: ${label}"`);
    expect(html).toContain(`data-advisor-gate="${gate}"`);
    expect(html).toContain(`data-tone="${tone}"`);
  });

  it("uses a distinct, dark-mode-safe tone for every state", () => {
    const tones = STATES.map(({ gate }) => {
      const html = render(gate);
      const match = html.match(/class="([^"]*)"/);
      expect(match, `root class for ${gate}`).not.toBeNull();
      return match?.[1] ?? "";
    });

    expect(new Set(tones).size).toBe(STATES.length);
    for (const classes of tones) {
      expect(classes).toContain("border-");
      expect(classes).toContain("dark:border-");
      expect(classes).toContain("dark:bg-");
      expect(classes).toContain("dark:text-");
      expect(classes).toContain("tabular-nums");
    }
  });

  it("shows only the short code in compact mode while keeping the accessible label", () => {
    expect(render("g1_pending", true)).toContain(">G1</span>");
    expect(render("g2_challenge", true)).toContain(">G2</span>");
    expect(render("g3_pass", true)).toContain(">G3</span>");
    expect(render("none", true)).toContain(">—</span>");

    const compact = render("g2_challenge", true);
    expect(compact).toContain('aria-label="자문 게이트: G2 자문 반려"');
    expect(compact).not.toContain(">G2 자문 반려<");
    expect(render("g2_challenge", false)).toContain(">G2 자문 반려<");
  });

  it("renders the full label, not the short code, by default", () => {
    const full = render("none");
    expect(full).toContain(">게이트 없음<");
    expect(full).not.toContain(">—</span>");
  });

  it("falls back to a neutral unknown badge for unrecognized runtime values", () => {
    const html = renderToStaticMarkup(<WorkflowAdvisorGateBadge advisorGate={"g9_unknown"} compact />);

    expect(html).toContain('aria-label="자문 게이트: 자문 게이트 알 수 없음"');
    expect(html).toContain('data-tone="none"');
    expect(html).toContain(">?</span>");
  });

  it("merges a custom className onto the root badge", () => {
    const html = renderToStaticMarkup(<WorkflowAdvisorGateBadge advisorGate="g3_pass" className="ml-2" />);

    expect(html.match(/class="([^"]*)"/)?.[1]).toContain("ml-2");
  });
});
