import { describe, expect, it } from "vitest";
import {
  editBudget,
  evaluateCostRule,
  relativeCostChange,
  selectAdmissibleCandidate,
  type RrsiCandidate,
  type SelectionConfig,
} from "../services/harness-rsi/rrsi-selection.js";
import {
  HARNESS_COMPONENTS,
  STRUCTURAL_NOVELTY_COMPONENTS,
  computeStructuralNovelty,
  parseEditHistoryJsonl,
  serializeEditHistoryRecord,
  summarizeEditHistory,
  type EditHistoryRecord,
} from "../services/harness-rsi/rrsi-history.js";
import { screenCandidateDiff } from "../services/harness-rsi/rrsi-critic.js";

const CONFIG: SelectionConfig = { beta0: 0.1, beta1: 0.5, wScore: 1, wCost: 1, wNovelty: 2 };
const GUARDED: SelectionConfig = {
  ...CONFIG,
  guards: [{ metric: "selfBlockCancels", op: "eq", value: 0 }],
};
const rec = (over: Partial<EditHistoryRecord>): EditHistoryRecord => ({
  round: 1, variant: "v", component: "skills", hypothesis: "h", diffRef: "d",
  deltaScore: 0, deltaCost: 0, accepted: false, verdict: "rejected", ...over,
});
const cand = (over: Partial<RrsiCandidate>): RrsiCandidate => ({
  id: "c", score: 0.9, cost: 10, components: ["skills"], novelty: 0,
  metrics: { selfBlockCancels: 0 }, ...over,
});
const select = (candidates: RrsiCandidate[]) =>
  selectAdmissibleCandidate({
    incumbentScore: 0.8, bestScore: 0.85, incumbentCost: 10, delta: 0.05,
    config: GUARDED, candidates,
  });
const diffOf = (path: string, lines: string[]): string =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
   "@@ -1,1 +1,1 @@", ...lines].join("\n");

describe("rrsi-selection", () => {
  it("anneals the edit budget on a cosine curve with safe boundaries", () => {
    expect(editBudget(0, 10, 2, 8)).toBe(8); // t=0 -> bMax
    expect(editBudget(5, 10, 2, 8)).toBe(5); // midpoint
    expect(editBudget(10, 10, 2, 8)).toBe(2); // t=T -> bMin
    expect(editBudget(99, 10, 2, 8)).toBe(2); // clamped to T
    expect(editBudget(1, 3, 2, 8)).toBe(7); // 6.5 -> ceil
    expect(editBudget(0, 0, 2, 8)).toBe(8); // T<=0 -> bMax (matches RRSI schedule.py)
    expect(editBudget(3, -5, 2, 8)).toBe(8);
  });

  it("computes relative cost change safely at non-positive incumbents", () => {
    expect(relativeCostChange(10, 12)).toBeCloseTo(0.2);
    expect(relativeCostChange(10, 5)).toBeCloseTo(-0.5);
    expect(relativeCostChange(0, 0)).toBe(0);
    expect(relativeCostChange(0, 5)).toBe(Number.POSITIVE_INFINITY);
    expect(relativeCostChange(-3, 0)).toBe(0);
  });

  it("bounds cost for clear improvement, shaped score inside the band", () => {
    const rule = (deltaScore: number, deltaCost: number, novelty = 0) =>
      evaluateCostRule({ deltaScore, deltaCost, novelty, delta: 0.05, config: CONFIG });
    expect(rule(0.2, 0.2).ok).toBe(true); // bound = 0.1 + 0.5*0.2 = 0.2
    expect(rule(0.2, 0.21).ok).toBe(false);
    expect(rule(0.2, 0.21).reason).toContain("cost-exceeded");
    expect(rule(0.02, 0.4).ok).toBe(false); // in-band: 0.02 - 0.4 < 0
    expect(rule(0.02, 0.4, 1).ok).toBe(true); // novelty rescues: +2*1
  });

  it("enforces noise floor, non-compensatory guards, argmax with cost tie-break", () => {
    const out = select([
      cand({ id: "low", score: 0.79 }), // floor = 0.85 - 0.05 = 0.80
      cand({ id: "blk", score: 0.95, metrics: { selfBlockCancels: 1 } }),
      cand({ id: "a", score: 0.84 }),
      cand({ id: "b", score: 0.88 }),
    ]);
    expect(out.winner?.id).toBe("b");
    expect(out.nextBestScore).toBe(0.88);
    const reason = (id: string) =>
      out.decisions.find((d) => d.candidateId === id)?.reason ?? "";
    expect(reason("low")).toContain("below-noise-floor");
    expect(reason("blk")).toContain("guard-failed");
    // missing guarded metric fails closed; no admissible -> bestScore preserved
    const missing = select([cand({ id: "x", metrics: {} })]);
    expect(missing.winner).toBeNull();
    expect(missing.decisions[0]?.reason).toContain("guard-failed");
    expect(missing.nextBestScore).toBe(0.85);
    const none = select([cand({ id: "low2", score: 0.7 })]);
    expect(none.winner).toBeNull();
    // equal scores -> lower cost wins
    const tie = selectAdmissibleCandidate({
      incumbentScore: 0.8,
      bestScore: 0.8,
      incumbentCost: 100,
      delta: 0.05,
      config: GUARDED,
      candidates: [
        cand({ id: "costly", score: 0.86, cost: 90 }),
        cand({ id: "cheap", score: 0.86, cost: 80 }),
      ],
    });
    expect(tie.winner?.id).toBe("cheap");
  });
});

describe("rrsi-history", () => {
  const records = [
    rec({ component: "skills", round: 9, deltaScore: 0.2, accepted: true, verdict: "winner" }),
    rec({ component: "memory", round: 8, deltaScore: -0.1 }),
    rec({ component: "scripts", round: 2, deltaScore: 0.5, accepted: true, verdict: "winner" }),
  ];
  const scores = [0.5, 0.6, 0.7, 0.75, 0.78, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8];
  const opts = {
    currentRound: 10,
    stallWindow: 3,
    pruneWindow: 3,
    delta: 0.05,
    roundScores: scores,
  };

  it("summarizes tried/untried, recentYield, stallFlag and pruneSet", () => {
    const s = summarizeEditHistory(records, opts);
    expect(s.triedComponents).toEqual(["memory", "skills", "scripts"]);
    expect(s.untriedComponents).toEqual(
      HARNESS_COMPONENTS.filter((c) => !["memory", "skills", "scripts"].includes(c)),
    );
    expect(s.recentYieldByComponent["skills"]).toBeCloseTo(0.2);
    expect(s.recentYieldByComponent["memory"]).toBeCloseTo(-0.1);
    expect(s.stallFlag).toBe(true); // S_10 - S_7 = 0 <= 0.05
    // memory (-0.1) and scripts (no window records -> 0) are pruned
    expect(s.pruneSet.sort()).toEqual(["memory", "scripts"]);
  });

  it("stallFlag=false on recent progress or insufficient history", () => {
    const moving = summarizeEditHistory(records, {
      ...opts,
      roundScores: scores.map((v, i) => (i === 7 ? 0.6 : v)),
    });
    expect(moving.stallFlag).toBe(false); // 0.8 - 0.6 > 0.05
    const short = summarizeEditHistory(records, {
      ...opts,
      currentRound: 2,
      stallWindow: 5,
    });
    expect(short.stallFlag).toBe(false); // S_-3 does not exist
  });

  it("counts structural novelty only for never-accepted components", () => {
    expect(STRUCTURAL_NOVELTY_COMPONENTS).toContain("tool_guidance");
    // skills already accepted, guardrails not structural -> memory+tool_guidance
    expect(
      computeStructuralNovelty(["skills", "memory", "tool_guidance", "guardrails"], records),
    ).toBe(2);
    const s = summarizeEditHistory(records, opts);
    expect(s.computeStructuralNovelty(["memory", "plugins"])).toBe(2);
  });

  it("round-trips JSONL and skips malformed lines", () => {
    const raw = [
      serializeEditHistoryRecord(records[0]),
      '{"broken":1}',
      "not json",
      serializeEditHistoryRecord(records[2]),
      "",
    ].join("\n");
    expect(parseEditHistoryJsonl(raw)).toEqual([records[0], records[2]]);
  });
});

describe("rrsi-critic", () => {
  const okEdit = [{ component: "skills", hypothesis: "improve recall" }];
  const screen = (diff: string, extraDenylist?: RegExp[]) =>
    screenCandidateDiff({ diff, edits: okEdit, extraDenylist });

  it("rejects hardcoded secrets in added lines", () => {
    for (const line of [
      '+const key = "sk-abcdefghijklmnopqrst1234"',
      "+PGPASSWORD=hunter2secret",
      "+Authorization: Bearer abcdefghijklmnop",
      "+-----BEGIN RSA PRIVATE KEY-----",
    ]) {
      const r = screen(diffOf("src/x.ts", [line]));
      expect(r.pass).toBe(false);
      expect(r.objections[0]?.code).toBe("hardcoded-secret");
    }
  });

  it("rejects tenant paths, hosts and UUIDs outside tests", () => {
    const r = screen(
      diffOf("src/x.ts", [
        '+const dir = "/srv/papercompany/runtime"',
        '+const host = "papercompany.showk.ing"',
        '+const id = "3f8a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c"',
      ]),
    );
    expect(r.objections.map((o) => o.code)).toEqual([
      "tenant-hardcoding",
      "tenant-hardcoding",
      "tenant-hardcoding",
    ]);
  });

  it("allows UUID fixtures in test files and ignores +++ headers", () => {
    const r = screen(
      diffOf("server/src/__tests__/x.test.ts", [
        '+const id = "3f8a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c"',
      ]),
    );
    expect(r.pass).toBe(true);
    // ---/+++ header lines are never scanned, even when they carry a tenant path
    const headerOnly = screen(
      "diff --git a/srv/papercompany/x.ts b/srv/papercompany/x.ts\n--- a/srv/papercompany/x.ts\n+++ b/srv/papercompany/x.ts\n@@ -0,0 +1,1 @@\n+const ok = 1",
    );
    expect(headerOnly.pass).toBe(true);
  });

  it("rejects missing hypothesis, unknown components and denylisted content", () => {
    const r = screenCandidateDiff({
      diff: diffOf("src/x.ts", ["+const x = 1"]),
      edits: [{ component: "warp_drive", hypothesis: "  " }],
    });
    expect(r.pass).toBe(false);
    expect(r.objections.map((o) => o.code).sort()).toEqual([
      "missing-hypothesis",
      "unknown-component",
    ]);
    const denied = screen(diffOf("src/x.ts", ["+eval(userInput)"]), [/\beval\(/]);
    expect(denied.objections[0]?.code).toBe("denylist-match");
  });

  it("allows deletions of old leaks and clean universal diffs", () => {
    const r = screen(
      diffOf("src/x.ts", [
        '-const key = "sk-abcdefghijklmnopqrst1234"',
        '-const dir = "/srv/papercompany/runtime"',
        "+const universal = computeScore(metrics)",
      ]),
    );
    expect(r.pass).toBe(true);
    expect(r.objections).toEqual([]);
  });
});
