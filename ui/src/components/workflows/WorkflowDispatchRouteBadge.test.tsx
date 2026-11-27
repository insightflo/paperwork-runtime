// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowDispatchRouteBadge, type WorkflowDispatchRoute } from "./WorkflowDispatchRouteBadge";

function render(route: WorkflowDispatchRoute, compact?: boolean, className?: string): string {
  return renderToStaticMarkup(<WorkflowDispatchRouteBadge route={route} compact={compact} className={className} />);
}

const ROUTES: ReadonlyArray<[WorkflowDispatchRoute, string]> = [
  ["sharp", "SHARP · 빠른 통과"],
  ["split", "SPLIT · 분할 검증"],
  ["escalate", "ESCALATE · 자문 승격"],
  ["escalate_advisor", "ESCALATE ADVISOR · 자문 지정 승격"],
];

describe("WorkflowDispatchRouteBadge", () => {
  it.each(ROUTES)("renders the %s route with its code and Korean label", (route, label) => {
    const html = render(route);
    expect(html).toContain(label);
    expect(html).toContain(`aria-label="Dispatch route: ${label}"`);
    expect(html).toContain(`data-route="${route}"`);
  });

  it("gives each route a distinct tone in both light and dark mode", () => {
    const pills = ROUTES.map(([route]) => render(route));
    const light = pills.map((html) => html.match(/text-(lime|blue|amber|violet)-800/)?.[1]);
    const dark = pills.map((html) => html.match(/dark:text-\[#[0-9a-f]{6}\]/)?.[0]);
    expect(light).toEqual(["lime", "blue", "amber", "violet"]);
    expect(new Set(dark).size).toBe(4);
    expect(dark.every((tone) => tone !== undefined)).toBe(true);
    pills.forEach((html) => expect(html).toContain("tabular-nums"));
  });

  it("does not rely on color alone: the dot is decorative and the text is visible", () => {
    const html = render("escalate");
    expect(html).toMatch(/<span aria-hidden="true" class="[^"]*rounded-full/);
    expect(html).toContain("자문 승격");
  });

  it("keeps the full accessible label while showing only the code in compact mode", () => {
    const html = render("split", true);
    expect(html).toContain('aria-label="Dispatch route: SPLIT · 분할 검증"');
    expect(html).toContain(">SPLIT</span>");
    expect(html).not.toContain("SPLIT · 분할 검증</span>");
  });

  it("appends a custom className without dropping the route tone", () => {
    const html = render("sharp", false, "ml-2");
    expect(html).toContain("ml-2");
    expect(html).toContain("text-lime-800");
  });
});
