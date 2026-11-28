import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Front-End-Checklist (thedaviddias) — CSS, Print Stylesheet, Reduced Motion.
// These tests pin the accessibility/print standards that must live in ui/src/index.css.
const css = readFileSync(`${import.meta.dirname}/index.css`, "utf8");

/** Body of the first block whose header contains `header` (brace-matched, comments unsafe). */
function blockBody(header: string): string | null {
  const start = css.indexOf(header);
  if (start === -1) return null;
  const open = css.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

describe("frontend-checklist-css standards in ui/src/index.css", () => {
  it("parses structurally: braces stay balanced after stripping comments", () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const opens = (stripped.match(/\{/g) ?? []).length;
    const closes = (stripped.match(/\}/g) ?? []).length;
    expect(opens).toBeGreaterThan(0);
    expect(opens).toBe(closes);
  });

  it("reduces-motion rule also stops transitions and smooth scrolling", () => {
    const body = blockBody("@media (prefers-reduced-motion: reduce)");
    expect(body).not.toBeNull();
    expect(body!).toMatch(/animation/);
    expect(body!).toMatch(/transition-duration/);
    expect(body!).toMatch(/scroll-behavior:\s*auto/);
  });

  it("print stylesheet hides chrome and navigation", () => {
    const body = blockBody("@media print");
    expect(body).not.toBeNull();
    const normalized = body!.replace(/\s+/g, " ");
    expect(normalized).toContain("nav, aside, [data-print-hide]");
    expect(normalized).toMatch(/display:\s*none/);
  });

  it("print stylesheet forces crisp dark-on-white output", () => {
    const body = blockBody("@media print");
    expect(body).not.toBeNull();
    const normalized = body!.replace(/\s+/g, " ");
    expect(normalized).toMatch(/color:\s*#000/);
    expect(normalized).toMatch(/background:\s*#fff/);
  });

  it("print stylesheet avoids page breaks inside cards and tables", () => {
    const body = blockBody("@media print");
    expect(body).not.toBeNull();
    const normalized = body!.replace(/\s+/g, " ");
    expect(normalized).toMatch(/break-inside:\s*avoid/);
    expect(normalized).toContain(".tactile-card");
    expect(normalized).toContain("table");
  });

  it("keeps keyboard focus visible via a :focus-visible outline", () => {
    const start = css.indexOf(":focus-visible");
    expect(start).toBeGreaterThan(-1);
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    const block = css.slice(open + 1, close);
    expect(block).toMatch(/outline/);
  });
});
