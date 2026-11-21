import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { readExplicitValidationVerdict } from "../services/validation-verdict.js";
import { resolveQualityVerdictRouting } from "../services/quality-verdict-routing.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/verdict-core/target/release/paperclip-verdict-core");

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(
    cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/verdict-core/Cargo.toml")],
    { stdio: "inherit" },
  );
}, 240_000);

type Outcome = { threw: false; value: unknown } | { threw: true; error: string };
const verdictFn = readExplicitValidationVerdict as (value: unknown, options?: unknown) => unknown;
const routingFn = resolveQualityVerdictRouting as (input: unknown) => unknown;

function ts(fn: () => unknown): Outcome {
  try {
    return { threw: false, value: fn() };
  } catch (err) {
    return { threw: true, error: err instanceof Error ? err.message : String(err) };
  }
}

function rustRaw(subcommand: string, stdin: string): Outcome {
  const res = spawnSync(rustBin, [subcommand], { input: stdin, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    return { threw: true, error: String(res.error ?? res.stderr).trim() };
  }
  return { threw: false, value: JSON.parse(String(res.stdout)) };
}
const rust = (subcommand: string, payload: unknown) => rustRaw(subcommand, JSON.stringify(payload));

function expectParity(t: Outcome, r: Outcome, exactError = false): void {
  if (r.threw !== t.threw) {
    throw new Error(`throw parity mismatch: ts=${JSON.stringify(t)} rust=${JSON.stringify(r)}`);
  }
  if (!t.threw && !r.threw) {
    expect(r.value).toEqual(t.value);
    return;
  }
  if (t.threw && r.threw && exactError) {
    expect(r.error).toBe(t.error);
  }
}

const L = { allowLeadingVerdict: true };
const verdictCases: Array<{ name: string; value: unknown; options?: unknown; exactError?: boolean }> = [
  { name: "terminal REQUEST_CHANGES beats an earlier PASS", value: "PASS noted\nreason\nREQUEST_CHANGES: fix it" },
  { name: "terminal REQUEST_CHANGES under a heading line", value: "## QA review\n\nhides a fee contradiction\n\nREQUEST_CHANGES: show both fee sources" },
  { name: "terminal PASS under a Korean heading", value: "prior item rechecked\n\n### 판정\nPASS" },
  { name: "mid-text verdict mentions are not a verdict", value: "Previous reviewer wrote REQUEST_CHANGES: missing glossary.\nAnother note says PASS was considered.\nThis comment is not a final verdict." },
  { name: "QA verdict section beats trailing detail lines", value: "## QA verdict\n\nREQUEST_CHANGES for [RES-980] artifact.\n\n- Verified file exists.\n\nRequired fixes:\n- Escape the fonts query separator." },
  { name: "leading REQUEST_CHANGES needs the flag", value: "REQUEST_CHANGES\n- fix hallucinated label", options: L },
  { name: "leading PASS needs the flag", value: "PASS\n- all checks complete", options: L },
  { name: "leading verdict without the flag is null", value: "PASS\n- all checks complete" },
  { name: "labeled validator line leads under the flag", value: "## Report Validator Verdict: **PASS**\n\nBoth requested fixes are verified.", options: L },
  { name: "markdown rule before a leading verdict is ignored", value: "---\n\n**REQUEST_CHANGES: published URL points to the hub shell**\n\nThe run succeeded.", options: L },
  { name: "template instruction line is not a verdict", value: "PASS or REQUEST_CHANGES" },
  { name: "template guard also blocks the leading path", value: "PASS or REQUEST_CHANGES", options: L },
  { name: "labeled template line still reads the label", value: "Verdict: PASS or REQUEST_CHANGES" },
  { name: "PASSWORD is not a verdict", value: "PASSWORD" },
  { name: "PASS followed by punctuation is a verdict", value: "PASS." },
  { name: "REQUESTCHANGES needs no separator", value: "REQUESTCHANGES" },
  { name: "request-changes matches case-insensitively", value: "request-changes: reason" },
  { name: "lowercase pass matches", value: "pass" },
  { name: "unicode fold: paſs matches PASS", value: "paſs" },
  { name: "unicode fold: long-s completes the PASS word under iu", value: "Paſſ" },
  { name: "unicode fold: Kelvin sign after PASS blocks the iu boundary", value: "PASS\u212A" },
  { name: "unicode fold: Kelvin sign before PASS keeps one word", value: "\u212APASS" },
  { name: "NEL U+0085 is not JS whitespace around a verdict", value: "\u0085PASS\u0085" },
  { name: "trailing NEL still ends the PASS boundary", value: "PASS\u0085" },
  { name: "mission gate accepts REQUEST_CHANGES", value: "mission validation gate: REQUEST_CHANGES" },
  { name: "mission gate rejects PASS", value: "mission validation gate: PASS" },
  { name: "validation complete label reads PASS", value: "validation complete: PASS" },
  { name: "Korean 판정 label reads verdict", value: "판정: REQUEST_CHANGES" },
  { name: "Korean 결론 label reads verdict", value: "결론: pass" },
  { name: "free prefix before verdict keyword", value: "the final verdict - request_changes" },
  { name: "verdict keyword without separator is not a verdict", value: "the verdict is pass" },
  { name: "NBSP between label and verdict", value: "Verdict: PASS" },
  { name: "FEFF counts as JS whitespace", value: "Verdict: ﻿PASS" },
  { name: "NBSP inside the template guard", value: "PASS or REQUEST_CHANGES" },
  { name: "CRLF: verdict on first of two lines is not terminal", value: "Verdict: PASS\r\nnotes after" },
  { name: "CRLF: same text reads the leading verdict", value: "Verdict: PASS\r\nnotes after", options: L },
  { name: "first matching heading decides even when it yields null", value: "text\nVerdict\nnoise line" },
  { name: "empty string is falsy", value: "" },
  { name: "whitespace and rules only collapse to null", value: "  \n---\n- - -\n***" },
  { name: "null value is falsy", value: null },
  { name: "zero and false are falsy", value: 0 },
  { name: "truthy non-string throws split error", value: 5, exactError: true },
  { name: "truthy array throws split error", value: [] },
  { name: "null options throws only on the leading read", value: "noise\nnoise", options: null, exactError: true },
  { name: "null options never read when verdict found", value: "PASS", options: null },
  { name: "primitive options read as no flag", value: "noise", options: 5 },
  { name: "truthy non-boolean flag enables leading read", value: "PASS\nnoise", options: { allowLeadingVerdict: "yes" } },
  { name: "bold label line normalizes to a verdict", value: "**Verdict:** PASS" },
  { name: "bullet prefix strips before verdict read", value: "- PASS", options: L },
  { name: "equals separator and status keyword", value: "status=REQUEST_CHANGES" },
];

const routingCases: Array<{ name: string; input: unknown; exactError?: boolean }> = [
  { name: "needs_evidence trims and drops empty surfaces", input: { verdict: "needs_evidence", reason: "r", requiredEvidenceSurfaces: [" a ", "b", "", "  "] } },
  { name: "needs_evidence defaults reason and surfaces", input: { verdict: "needs_evidence" } },
  { name: "needs_evidence null surfaces is empty", input: { verdict: "needs_evidence", requiredEvidenceSurfaces: null } },
  { name: "needs_evidence falsy surfaces short-circuit", input: { verdict: "needs_evidence", requiredEvidenceSurfaces: false } },
  { name: "surfaces trim JS whitespace incl NBSP/FEFF, keep ZWSP", input: { verdict: "needs_evidence", requiredEvidenceSurfaces: [" x﻿", "​y​"] } },
  { name: "string surfaces throws the map TypeError", input: { verdict: "needs_evidence", requiredEvidenceSurfaces: "abc" }, exactError: true },
  { name: "object surfaces throws the map TypeError", input: { verdict: "needs_evidence", requiredEvidenceSurfaces: { length: 2 } }, exactError: true },
  { name: "non-string element throws the trim TypeError", input: { verdict: "needs_evidence", requiredEvidenceSurfaces: [5] }, exactError: true },
  { name: "null element throws the V8 null TypeError", input: { verdict: "needs_evidence", requiredEvidenceSurfaces: [null] }, exactError: true },
  { name: "NEL U+0085 stays inside a trimmed surface", input: { verdict: "needs_evidence", requiredEvidenceSurfaces: ["\u0085x\u0085"] } },
  { name: "needs_evidence keeps non-string reason verbatim", input: { verdict: "needs_evidence", reason: 5 } },
  { name: "fail routes to correction with fields", input: { verdict: "fail", reason: "r", failureType: "t" } },
  { name: "request_changes routes to correction", input: { verdict: "request_changes" } },
  { name: "correction keeps object reason verbatim", input: { verdict: "fail", reason: { a: 1 }, failureType: null } },
  { name: "correction ignores surfaces entirely", input: { verdict: "fail", requiredEvidenceSurfaces: [1] } },
  { name: "pass routes to none", input: { verdict: "pass" } },
  { name: "uppercase FAIL is not a verdict", input: { verdict: "FAIL" } },
  { name: "array verdict routes to none", input: { verdict: ["fail"] } },
  { name: "missing verdict routes to none", input: { reason: "r" } },
  { name: "null input throws the verdict TypeError", input: null, exactError: true },
  { name: "missing input throws the verdict TypeError", input: undefined, exactError: true },
  { name: "primitive input routes to none", input: 5 },
  { name: "string input routes to none", input: "needs_evidence" },
];

describe("read-explicit-validation-verdict: TS vs paperclip-verdict-core", () => {
  for (const c of verdictCases) {
    it(`parity: ${c.name}`, () => {
      expectParity(
        ts(() => verdictFn(c.value, c.options)),
        rust("read-explicit-validation-verdict", { value: c.value, options: c.options }),
        c.exactError,
      );
    });
  }
});

describe("resolve-quality-verdict-routing: TS vs paperclip-verdict-core", () => {
  for (const c of routingCases) {
    it(`parity: ${c.name}`, () => {
      expectParity(
        ts(() => routingFn(c.input)),
        rust("resolve-quality-verdict-routing", { input: c.input }),
        c.exactError,
      );
    });
  }
});

describe("verdict-core CLI contract", () => {
  it("fails closed on malformed stdin and unknown subcommands", () => {
    for (const out of [
      rustRaw("read-explicit-validation-verdict", "{not json"),
      rustRaw("read-explicit-validation-verdict", ""),
      rustRaw("resolve-quality-verdict-routing", "{not json"),
      rustRaw("resolve-quality-verdict-routing", ""),
      rustRaw("bogus-subcommand", "{}"),
    ]) {
      expect(out.threw).toBe(true);
    }
  });

  it("fails closed when invoked with no subcommand", () => {
    const res = spawnSync(rustBin, [], { input: "{}", encoding: "utf8" });
    expect(res.status).not.toBe(0);
  });
});
