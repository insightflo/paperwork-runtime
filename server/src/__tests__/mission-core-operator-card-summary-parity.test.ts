import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { formatOperatorDecisionSummary } from "../services/missions/operator-card-summary.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/mission-core/target/release/paperclip-mission-core");

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(
    cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/mission-core/Cargo.toml")],
    { stdio: "inherit" },
  );
}, 240_000);

type Outcome = { threw: false; value: unknown } | { threw: true; error: string };
function ts(fn: () => unknown): Outcome {
  try {
    const v = fn();
    return { threw: false, value: v === undefined ? null : v };
  } catch (err) {
    return { threw: true, error: err instanceof Error ? err.message : String(err) };
  }
}
function rust(subcommand: string, payload: unknown): Outcome {
  const res = spawnSync(rustBin, [subcommand], {
    input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    return { threw: true, error: String(res.error ?? res.stderr).trim() };
  }
  return { threw: false, value: JSON.parse(String(res.stdout)) };
}
function expectParity(t: Outcome, r: Outcome, exactError = false): void {
  if (r.threw !== t.threw) {
    throw new Error(`throw parity mismatch: ts=${JSON.stringify(t)} rust=${JSON.stringify(r)}`);
  }
  if (!t.threw) {
    expect(r.value).toEqual(t.value);
  } else if (exactError) {
    expect(r.error).toBe(t.error);
  }
}

const SUB = "format-operator-decision-summary" as const;
type Input = Parameters<typeof formatOperatorDecisionSummary>[0];
const callTs = {
  [SUB]: (p: unknown) => formatOperatorDecisionSummary(p as Input),
} as const;
const parity = (payload: unknown, exact = false) =>
  expectParity(ts(() => callTs[SUB](payload)), rust(SUB, payload), exact);

const AGENT = {
  decision: "escalate" as const,
  missionTitle: "2026-08-25 tech-ai-news daily report",
  issueIdentifier: "RES-3638",
  issueTitle: "[Unblock] RES-3637: Synthesize multi-source AI news report draft",
  issueId: "c70bc2a9-b34a-4ee5-960d-2dbc1605e01f",
  reason:
    "The accepted reassign_source_issue event 423304dd-9f5b-4c88-b4c5-7c17d67865ab did not materialize. RES-3637 remains blocked under the failed Synthesis Editor.",
  nextAction:
    "Assign RES-3637 to the idle Technology Research Agent 751281f0-c613-4e7d-a5e9-63124da338ea and dispatch its workflow wakeup.",
  evidence:
    "Fresh source heartbeat-context shows RES-3637 status=blocked and assignee=8d57b1e0-d086-4f10-961a-bccb1a136e12.",
};
const BLOCK = (fields: string) => `### Mission owner decision\n${fields}`;

const cases: Array<{ name: string; payload: unknown; exact?: boolean }> = [
  { name: "full card: uuid shortening and prose evidence fallback", payload: AGENT },
  { name: "empty input uses every default", payload: { decision: "escalate" } },
  { name: "missing reason falls back to the korean placeholder", payload: { decision: "escalate", missionTitle: "Some mission", issueId: "c70bc2a9-b34a-4ee5-960d-2dbc1605e01f" } },
  { name: "request_input gloss and option default", payload: { decision: "request_input", reason: "needs approval" } },
  { name: "capitalized decision is not escalate", payload: { decision: "Escalate", reason: "x" } },
  { name: "missing decision is request_input path", payload: { reason: "x" } },
  { name: "empty-string reason is falsy", payload: { decision: "escalate", reason: "" } },
  { name: "whitespace-only reason yields an empty symptom line", payload: { decision: "escalate", reason: "   " } },
  { name: "multi-line reason and nextAction collapse to single lines", payload: { ...AGENT, reason: "line one of the symptom\nline two of the symptom", nextAction: "Option A: approve the retry.\nOption B: reassign the issue.\nOption C: cancel." } },
  { name: "mission blocker escalated label stripped", payload: { decision: "escalate", reason: "Mission blocker escalated: the source issue cannot progress without operator input." } },
  { name: "human/operator input requested label stripped case-insensitively", payload: { decision: "escalate", reason: "HUMAN/OPERATOR INPUT REQUESTED   please look" } },
  { name: "human operator colon label stripped", payload: { decision: "escalate", reason: "Human Operator: pick a path" } },
  { name: "humanoperator colon label stripped through zero-width ws", payload: { decision: "escalate", reason: "humanoperator:go" } },
  { name: "human operator without colon is preserved", payload: { decision: "escalate", reason: "Human operator must choose a recovery path." } },
  { name: "mid-string label text is not stripped", payload: { decision: "escalate", reason: "x mission blocker escalated: y" } },
  { name: "kelvin sign u212a does not fold into the blocker label", payload: { decision: "escalate", reason: "mission blocKer escalated: real reason here" } },
  { name: "kelvin sign u212a does not fold into the blocker label on nextAction", payload: { decision: "escalate", reason: "ok", nextAction: "mission blocKer escalated: real reason here" } },
  { name: "long s u017f does not fold into the blocker label", payload: { decision: "escalate", reason: "miſſion blocker escalated: real reason here" } },
  { name: "markdown heading lines removed by prose cleaning", payload: { decision: "escalate", reason: "## Context\nthe real reason\n#### sub\nmore" } },
  { name: "seven leading hashes are not a heading", payload: { decision: "escalate", reason: "####### kept literally" } },
  { name: "heading marker without space is kept", payload: { decision: "escalate", reason: "###nope\nreal reason" } },
  { name: "uppercase hex uuid shortened preserving case", payload: { decision: "escalate", reason: "ref ABCDEF12-3456-7890-ABCD-EF1234567890 end" } },
  { name: "uuid glued to a leading word char is not shortened", payload: { decision: "escalate", reason: "x423304dd-9f5b-4c88-b4c5-7c17d67865ab end" } },
  { name: "uuid glued to a trailing word char is not shortened", payload: { decision: "escalate", reason: "423304dd-9f5b-4c88-b4c5-7c17d67865abz end" } },
  { name: "longer hex run before first dash is not a uuid", payload: { decision: "escalate", reason: "123456789-1234-1234-1234-123456789012 end" } },
  { name: "urls extracted before issue refs preserving capture order", payload: { ...AGENT, evidence: "see /issues/RES-10926, then https://example.com/run/123 and https://example.com/a; end" } },
  { name: "issue ref at evidence start matches", payload: { ...AGENT, evidence: "/issues/42 followed by prose" } },
  { name: "issue ref after open paren matches, after close paren does not", payload: { ...AGENT, evidence: "(/issues/a1) and )/issues/b2" } },
  { name: "issue refs after quotes and angle bracket", payload: { ...AGENT, evidence: "\"/issues/q9\" and '/issues/q8' and </issues/q7> and >/issues/q6" } },
  { name: "full URL containing an /issues/ path is not split", payload: { ...AGENT, evidence: "diagnosis at https://example.com/issues/RES-10926 only" } },
  { name: "duplicate extracted links dedupe keeping first position", payload: { ...AGENT, evidence: "https://a.com/x and /issues/a1 then https://a.com/x and /issues/a1" } },
  { name: "eight links are capped at five", payload: { ...AGENT, evidence: Array.from({ length: 8 }, (_, i) => `https://example.com/evidence/${i}`).join(" and ") } },
  { name: "link list over budget drops whole links from the tail", payload: { ...AGENT, evidence: Array.from({ length: 5 }, (_, i) => `https://example.com/${"x".repeat(50)}${i}`).join(" ") } },
  { name: "single link over the links budget yields an empty 근거 body", payload: { ...AGENT, evidence: `https://example.com/${"x".repeat(300)}` } },
  { name: "legacy prose evidence cleans and truncates at 160", payload: { ...AGENT, evidence: `log ${"x".repeat(400)}` } },
  { name: "prose evidence with a raw uuid shortens it", payload: { ...AGENT, evidence: "run-count=9; raw uuid 423304dd-9f5b-4c88-b4c5-7c17d67865ab" } },
  { name: "url token stops at js whitespace including nbsp", payload: { ...AGENT, evidence: "https://a.com/x y tail" } },
  { name: "issue ref tail keeps dots and dashes inside the token", payload: { ...AGENT, evidence: "/issues/RES-10926. and /issues/x-y_z.w end" } },
  { name: "issue ref with a trailing dash keeps it", payload: { ...AGENT, evidence: "/issues/abc- end" } },
  { name: "sentence-boundary truncation for long symptom prose", payload: { ...AGENT, reason: "This sentence is deliberately long so that several of them exceed the budget. ".repeat(12) } },
  { name: "word-boundary ellipsis when no sentence end fits", payload: { ...AGENT, reason: `unbreakable ${"wordwordword ".repeat(60)}`, nextAction: undefined, evidence: undefined } },
  { name: "no space at all truncates the raw head with ellipsis", payload: { ...AGENT, reason: "x".repeat(500), nextAction: undefined, evidence: undefined } },
  { name: "reason at exactly the budget is untouched", payload: { ...AGENT, reason: "a".repeat(200), nextAction: undefined, evidence: undefined } },
  { name: "option budget applies to nextAction", payload: { ...AGENT, nextAction: "step ".repeat(80) } },
  { name: "mission title truncates at 80 word boundary", payload: { ...AGENT, missionTitle: "verylongmissionword ".repeat(12) } },
  { name: "issue title truncates at 140 word boundary", payload: { ...AGENT, issueIdentifier: "RES-1", issueTitle: "t ".repeat(120) } },
  { name: "identifier only names the issue", payload: { decision: "escalate", reason: "r", issueIdentifier: "RES-1" } },
  { name: "title only names the issue", payload: { decision: "escalate", reason: "r", issueTitle: "Some title" } },
  { name: "identifier and title join with em dash", payload: { decision: "escalate", reason: "r", issueIdentifier: "GAZ-1352", issueTitle: "[Unblock] GAZ-1350" } },
  { name: "issueId alone is shown shortened in parens", payload: { decision: "request_input", missionTitle: "Some mission", issueId: "86079e86-e6ee-43f4-bf6d-543bbb0909f5", reason: "needs input" } },
  { name: "non-uuid issueId is embedded raw", payload: { decision: "escalate", reason: "r", issueId: "weird-id-123" } },
  { name: "falsy numeric issueId is skipped", payload: { decision: "escalate", reason: "r", issueId: 0 } },
  { name: "structured decision block unpacks fields", payload: { decision: "escalate", missionTitle: "2026-08-25 gazua-evening", issueIdentifier: "GAZ-1352", issueTitle: "[Unblock] GAZ-1350: 2026-08-25 미국시장 시그널 해석", reason: BLOCK("Decision: escalate\nSource issue: GAZ-1350\nReason: Mission cannot continue automatically. The workflow or its owner-action recovery reached a terminal failure.\nNext action: Human operator must choose a recovery path (retry with revised input, replan, reassign, or cancel).\nEvidence: mission=2026-08-25 gazua-evening; owner-action=GAZ-1352; source=GAZ-1350; failed-run-count=2; continuation=none") } },
  { name: "adjudication-recorded heading unpacks", payload: { decision: "escalate", reason: "## Mission-owner adjudication recorded\nDecision: replan_mission\nReason: second pass\nNext action: replan now\nEvidence: /issues/9" } },
  { name: "inline recorded marker unpacks", payload: { decision: "escalate", reason: "run failed. Mission-owner decision recorded: escalate\nReason: why\nNext action: do it\nEvidence: /issues/9" } },
  { name: "uppercase decision value still validates", payload: { decision: "escalate", reason: BLOCK("Decision: ESCALATE\nReason: upper reason") } },
  { name: "invalid decision option falls back to the whole cleaned reason", payload: { decision: "escalate", reason: BLOCK("Decision: bogus_option\nReason: kept reason\nNext action: kept next") } },
  { name: "structured block without a Reason field reuses the whole text", payload: { decision: "escalate", reason: BLOCK("Decision: escalate\nNext action: keep this") } },
  { name: "later heading block wins over the earlier one", payload: { decision: "escalate", reason: "### Mission owner decision\nDecision: escalate\nReason: first\n\n### Mission owner decision\nDecision: replan_mission\nReason: second" } },
  { name: "field capture stops before a following label-like line", payload: { decision: "escalate", reason: BLOCK("Decision: escalate\nReason: only this\nNote: extra\nEvidence: ev") } },
  { name: "marker capture without a letter after colon does not match", payload: { decision: "escalate", reason: "Mission-owner decision recorded: 42\nReason: kept" } },
  { name: "korean and emoji text is preserved", payload: { decision: "escalate", reason: "한글 사유 🚀 진행 불가", nextAction: "한국어 액션 선택" } },
  { name: "surrogate pair straddling the budget edge stays whole", payload: { ...AGENT, reason: `${"a".repeat(198)}🚀${"b".repeat(100)}`, nextAction: undefined, evidence: undefined } },
  { name: "mid-pair budget cut emits the lone-surrogate output", payload: { ...AGENT, reason: `${"a".repeat(199)}🚀${"b".repeat(100)}`, nextAction: undefined, evidence: undefined } },
  { name: "feff and nbsp edges trim like JS", payload: { decision: "escalate", reason: "r", missionTitle: "﻿ title   ", issueTitle: " issue﻿" } },
  { name: "lone carriage return survives prose cleaning", payload: { decision: "escalate", reason: "a\rb" } },
  { name: "crlf folds to a single space", payload: { decision: "escalate", reason: "a\r\nb" } },
  { name: "line separator is a multiline line-start for headings", payload: { decision: "escalate", reason: "x ### hidden\nvisible" } },
  { name: "structured reason still flows through the reason pipeline", payload: { decision: "request_input", reason: BLOCK("Decision: request_input\nReason: needs a yes\nNext action: say yes") } },
  { name: "truthy non-string reason throws V8 toLowerCase text", payload: { decision: "escalate", reason: 5 }, exact: true },
  { name: "object reason throws V8 toLowerCase text", payload: { reason: {} }, exact: true },
  { name: "truthy non-string nextAction throws V8 replace text", payload: { reason: "ok", nextAction: 5 }, exact: true },
  { name: "truthy non-string evidence throws V8 matchAll text", payload: { reason: "ok", evidence: 5 }, exact: true },
  { name: "non-string missionTitle throws V8 trim text", payload: { reason: "ok", missionTitle: 5 }, exact: true },
  { name: "non-string issueIdentifier throws V8 trim text", payload: { reason: "ok", issueIdentifier: true }, exact: true },
  { name: "non-string issueTitle throws V8 trim text", payload: { reason: "ok", issueTitle: {} }, exact: true },
  { name: "truthy non-string issueId throws V8 replace text", payload: { reason: "ok", issueId: 5 }, exact: true },
  { name: "null input throws V8 property-read text", payload: null, exact: true },
  { name: "numeric input formats defaults", payload: 42 },
  { name: "string input formats defaults", payload: "str" },
  { name: "array input formats defaults", payload: [] },
];

describe("operator-card-summary: TS vs paperclip-mission-core", () => {
  for (const c of cases) {
    it(`parity ${SUB}: ${c.name}`, () => parity(c.payload, c.exact));
  }
});
