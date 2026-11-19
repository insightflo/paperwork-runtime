import { describe, expect, it } from "vitest";
import { buildPaperclipRuntimeBrief } from "./runtime-brief.js";
import { buildPrehydratedBundleBriefLines } from "./runtime-brief-prehydrate.js";
// @ts-expect-error -- Vitest's Vite transform loads raw source; this package does not include Vite's client types.
import source from "./runtime-brief-prehydrate.ts?raw";

const bundle = {
  compactContract: { label: "Contract", path: "contract.md", content: "Work within scope." },
  entries: [{ label: "Inputs", path: "input.md", content: "Use these inputs." }],
  doNotRereadPaths: ["input.md", "extra.md", " extra.md "],
};

describe("buildPrehydratedBundleBriefLines", () => {
  it.each([null, undefined, 42, "bundle", [], {}, { entries: {} }, {
    compactContract: { label: " ", content: "bad" },
    entries: [null, { label: "Bad", content: 1 }],
    doNotRereadPaths: [null, 42, "\0"],
  }])("returns no lines for invalid or empty input (%j)", (value) => {
    expect(buildPrehydratedBundleBriefLines(value)).toEqual([]);
  });

  it("renders the contract first and lists each loaded path once", () => {
    expect(buildPrehydratedBundleBriefLines(bundle).join("\n")).toBe([
      "- Pre-hydrated step input bundle (already loaded below; DO NOT re-read these files via read/bash unless you are editing them or need an omitted section):",
      "### Contract (contract.md)",
      "Work within scope.",
      "### Inputs (input.md)",
      "Use these inputs.",
      "- Already-loaded paths (skip read/cat/sed): contract.md, input.md, extra.md",
    ].join("\n"));
  });

  it("strips unsafe controls and keeps tabs, newlines, and producer truncation in content", () => {
    const output = buildPrehydratedBundleBriefLines({
      entries: [{ label: "In\0put", path: "a\x1B.md", truncated: true, content: "\tOne\r\nT\x7Fwo\x85" }],
    }).join("\n");
    expect(output).toContain("### Input (a.md)\n\tOne\nTwo\n...[truncated]\n");
  });

  it.each([[1, 1_000], [1_500, 1_500], [undefined, 24_000], [99_000, 48_000]])(
    "counts headings, paths, and separators in the total budget (%s)", (maxTotalChars, budget) => {
      const output = buildPrehydratedBundleBriefLines({
        maxTotalChars,
        entries: Array.from({ length: 12 }, (_, i) => ({ label: `Input ${i}`, path: `input-${i}.md`, content: "x".repeat(50_000) })),
      }).join("\n");
      expect(output.length).toBeLessThanOrEqual(budget);
      expect(output.length).toBeGreaterThan(budget - 100);
      expect(output).toContain("\n...[truncated]");
      expect(output).toContain("- Already-loaded paths (skip read/cat/sed): input-0.md");
      expect(output).not.toContain("input-11.md");
    },
  );

  it("limits entry size independently of the total and renders at most 12 entries", () => {
    const output = buildPrehydratedBundleBriefLines({
      entries: Array.from({ length: 13 }, (_, i) => ({ label: `Input ${i}`, path: `${i}.md`, content: i === 0 ? "x".repeat(24_000) : "small" })),
    }).join("\n");
    expect(output).toContain("\n...[truncated]\n### Input 1 (1.md)");
    expect(output).toContain("### Input 11 (11.md)");
    expect(output).not.toContain("12.md");
  });

  it("uses no Node.js module specifiers", () => {
    expect(source).not.toMatch(/[\x22'`]node:/);
  });
});

it("renders a bundle-only runtime brief with its normal header", () => {
  const brief = buildPaperclipRuntimeBrief({ paperclipPrehydratedBundle: bundle });
  expect(brief).toMatch(/^Paperclip runtime brief:\n/);
  expect(brief).toContain("- Pre-hydrated step input bundle");
  expect(brief).toContain("### Contract (contract.md)\nWork within scope.");
});

it("inserts the bundle after the tool contract without altering existing sections", () => {
  const context = {
    taskKey: "TASK-1",
    paperclipWorkflowStepToolContract: { stepName: "Review", toolNames: ["read"] },
    paperclipSessionHandoff: { previousSessionId: "previous" },
  };
  const before = buildPaperclipRuntimeBrief(context);
  const after = buildPaperclipRuntimeBrief({ ...context, paperclipPrehydratedBundle: bundle });
  const start = after.indexOf("\n- Pre-hydrated step input bundle");
  const end = after.indexOf("\n- Previous session:");
  expect(after.indexOf("Workflow tool-call contract:")).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(after.indexOf("Workflow tool-call contract:"));
  expect(end).toBeGreaterThan(start);
  expect(after.slice(0, start) + after.slice(end)).toBe(before);
});
