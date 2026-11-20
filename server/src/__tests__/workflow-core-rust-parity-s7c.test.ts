import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { checkStepEligibility } from "../services/workflow/resume/eligibility.js";
import { sortWorkflowStepsByPriority } from "../services/workflow/dag-step-priority.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

beforeAll(() => {
  execFileSync(process.env.CARGO || "cargo",
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
}, 120_000);

function rust(sub: string, payload: unknown): unknown {
  const stdout = execFileSync(rustBin, [sub], { input: JSON.stringify(payload), encoding: "utf8" });
  return JSON.parse(stdout);
}
function parity(sub: string, payload: unknown, ts: () => unknown) {
  expect(rust(sub, payload)).toEqual(ts());
}
function parityThrow(sub: string, payload: unknown, ts: () => unknown) {
  expect(ts).toThrow();
  expect(() => rust(sub, payload)).toThrow();
}

const hist = (over: Record<string, unknown> = {}) => ({
  stepId: "s1", status: "pending", issueId: null, startedAt: null, executionGeneration: 0,
  hasAttempt: false, hasQueue: false, hasOwner: false, hasExternalResult: false,
  effect: "none", kind: "agent", ...over,
});
const eligOf = (history: unknown) => ({ blocker: checkStepEligibility(history as never) });
const sortedOf = (steps: unknown) => ({ steps: sortWorkflowStepsByPriority(steps as never) });
const elig = (history: unknown) =>
  parity("check-step-eligibility", { history }, () => eligOf(history));
const sorted = (steps: unknown) =>
  parity("sort-steps-by-priority", { steps }, () => sortedOf(steps));
const RESUMABLE = ["pending", "failed", "skipped"] as const;

describe("paperclip-workflow-core Rust parity (s7c: resume eligibility + dag step priority)", () => {
  it("check-step-eligibility: status/ownership gates across kinds", () => {
    for (const kind of ["agent", "tool", "control", "cron", 5, null]) {
      elig(hist({ kind, status: "running" }));
      elig(hist({ kind, status: "completed" }));
      elig(hist({ kind, hasOwner: true }));
      // resumable 외 status — 비문자열도 Set.has 에서 탈락
      for (const status of ["cancelled", "canceled", "unknown", "", " running ", 5, null, true, []])
        elig(hist({ kind, status }));
    }
  });

  it("check-step-eligibility: agent/tool recorded-history and effect rules", () => {
    for (const kind of ["agent", "tool"]) {
      for (const flag of [
        { issueId: "i-1" }, { startedAt: "t" }, { hasAttempt: true },
        { hasQueue: true }, { hasExternalResult: true },
      ]) elig(hist({ kind, ...flag }));
      elig(hist({ kind, executionGeneration: 4 })); // generation 단독은 이력 아님
      for (const status of RESUMABLE) {
        for (const effect of ["none", "read_only", "external"]) elig(hist({ kind, status, effect }));
        for (const effect of ["unknown", "externalx", 5, null]) elig(hist({ kind, status, effect }));
      }
      // 2026-10-22 liveness: failed/skipped+흔적 재실행 허용, pending+흔적은 상태 불일치 차단
      const traces = { issueId: "i-1", startedAt: "t", hasAttempt: true, hasQueue: true };
      for (const status of ["failed", "skipped"]) elig(hist({ kind, status, ...traces }));
      elig(hist({ kind, status: "pending", ...traces }));
      // 필드 부재 — `issueId !== null` 에서 undefined 도 !== null 이라 기록 이력으로 본다
      elig({ status: "pending", kind, effect: "none" });
    }
  });

  it("check-step-eligibility: control path incl. non-agent/tool kinds", () => {
    for (const kind of ["control", "qa", "if", 5, null]) {
      elig(hist({ kind, issueId: "i-1" }));
      for (const status of RESUMABLE) {
        elig(hist({ kind, status, hasExternalResult: true }));
        elig(hist({ kind, status, issueId: "i-1" }));
        for (const effect of ["external", "unknown"]) elig(hist({ kind, status, effect }));
      }
      for (const flag of [{ startedAt: "t" }, { hasAttempt: true }, { hasQueue: true }])
        elig(hist({ kind, ...flag }));
      for (const status of ["failed", "skipped"]) {
        // 잔존 흔적(active owner·issue·외부결과 없음)은 통제된 재평가로 허용
        elig(hist({ kind, status, startedAt: "t", hasAttempt: true, hasQueue: true, effect: "read_only" }));
        elig(hist({ kind, status, startedAt: "t", hasAttempt: true, hasOwner: true }));
        elig(hist({ kind, status, hasQueue: true, issueId: "i-1" }));
      }
    }
  });

  it("check-step-eligibility: stuck applies only to running, `=== true` strict", () => {
    for (const kind of ["agent", "tool", "control"]) {
      for (const effect of ["none", "read_only", "external", "unknown"])
        elig(hist({ kind, status: "running", stuck: true, effect }));
    }
    elig(hist({ kind: "control", status: "running", stuck: true, issueId: "i-1" }));
    // stuck 판정이 오너 종말을 이미 증명 — 잔존 참조는 residue 로 통과
    elig(hist({ status: "running", stuck: true, hasOwner: true, issueId: "i-1", startedAt: "t", hasAttempt: true }));
    elig(hist({ status: "cancelled", stuck: true }));
    elig(hist({ status: "completed", stuck: true }));
    elig(hist({ status: "pending", stuck: true, issueId: "i-1" }));
    for (const stuck of ["true", 1, [], {}]) elig(hist({ status: "running", stuck }));
    elig(hist({ status: "running", issueId: "i-1", startedAt: "t" }));
  });

  it("check-step-eligibility: JS truthiness/undefined coercion edges", () => {
    // 빈 배열·객체도 JS truthy — flag 로 잡힌다
    for (const flag of [
      { hasAttempt: [] }, { hasAttempt: {} }, { hasAttempt: "x" }, { hasAttempt: 0 },
      { hasOwner: [] }, { hasOwner: "" }, { hasExternalResult: [] }, { hasQueue: -1 },
    ]) elig(hist(flag));
    // `!== null` — 비null 원시값(0/false 포함)은 기록 이력
    elig(hist({ issueId: 0 }));
    elig(hist({ startedAt: false }));
    // 비객체 history — 필드 전부 undefined 로 흘러 unsupported_status
    for (const h of ["x", 5, true, [], {}, [1, 2]]) elig(h);
    parityThrow("check-step-eligibility", { history: null }, () => eligOf(null));
    parityThrow("check-step-eligibility", {}, () => eligOf(undefined));
  });

  it("sort-steps-by-priority: descending rank, stable ties, rank domain", () => {
    const P = (id: unknown, priority?: unknown, extra: Record<string, unknown> = {}) =>
      ({ id, executionControls: { priority, ...extra } });
    sorted([
      P("a", "low"), P("b", "critical"), { id: "c" }, P("d", "normal"),
      P("e", "high"), { id: "f", executionControls: null },
      { id: "g", executionControls: 5 }, P("h", "CRITICAL"), P("i", " high "),
      P("j", 4), P("k", "low"), P("l", "critical"), P("m", true), P("n", null),
    ]);
    sorted([]);
    // 비객체 요소 — `.executionControls` 는 undefined, rank 0, 안정 유지
    sorted(["b", "a", { id: "x", executionControls: { priority: "low" } }, 5, true, [], "c"]);
    sorted([{ id: "s", executionControls: { priority: "low" } }]);
    sorted([null]); // len<2 — comparator 미호출, null 통과
  });

  it("sort-steps-by-priority: iterable/TypeError boundaries", () => {
    // [...steps] — 문자열은 code-point iterable
    sorted("ba");
    sorted("");
    sorted("a😀b");
    // len>=2 null 요소 — comparator 의 `.executionControls` 접근이 TypeError
    parityThrow("sort-steps-by-priority", { steps: [null, null] }, () => sortedOf([null, null]));
    parityThrow("sort-steps-by-priority", { steps: [{ id: "a" }, null] },
      () => sortedOf([{ id: "a" }, null]));
    // 비iterable steps
    for (const bad of [5, true, null, {}, { steps: 1 }])
      parityThrow("sort-steps-by-priority", { steps: bad }, () => sortedOf(bad));
    parityThrow("sort-steps-by-priority", {}, () => sortedOf(undefined));
  });
});
