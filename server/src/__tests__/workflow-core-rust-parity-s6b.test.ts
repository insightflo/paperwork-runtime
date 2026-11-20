import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildHistoricalQaSourceDefectCard } from "../services/workflow/qa-source-defect-card-historical.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

function runRust(payload: unknown): unknown {
  const stdout = execFileSync(rustBin, ["qa-defect-card-historical"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

beforeAll(() => {
  execFileSync(process.env.CARGO || "cargo",
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
}, 120_000);

const base = {
  workflowRunId: "run-1",
  producerStepId: "produce",
  iteration: 2,
  maxIterations: 3,
  missionId: "m-1",
  linkIssueId: "issue-9",
} as const;
const finding = (id: unknown, layer: unknown = "source_data", summary: unknown = "결함 요약") =>
  ({ id, layer, summary });
const qaRef = (step: unknown, issue: unknown = null) => ({ qaStepId: step, qaIssueId: issue });

function parity(input: Record<string, unknown>) {
  expect(runRust(input)).toEqual(buildHistoricalQaSourceDefectCard(input as never));
}
function parityThrow(input: unknown) {
  expect(() => buildHistoricalQaSourceDefectCard(input as never)).toThrow();
  expect(() => runRust(input)).toThrow();
}

describe("paperclip-workflow-core Rust parity (s6b: qa-source-defect-card-historical)", () => {
  it("matches the full card across layer mixes and promoted markers", () => {
    parity({ ...base, findings: [], qaRefs: [] });
    parity({ ...base, findings: [finding("f-1")], qaRefs: [qaRef("qa-1")] });
    parity({ ...base, findings: [finding("f-1"), finding("f-2", "artifact")], qaRefs: [] });
    parity({ ...base, findings: [finding("f-1", "artifact"), finding("f-2", "artifact")], qaRefs: [qaRef("q")] });
    parity({
      ...base, promotedFindingIds: ["f-2", "ghost"],
      findings: [finding("f-1"), finding("f-2"), finding("f-3", "artifact")],
      qaRefs: [qaRef("qa-1", "i-1"), qaRef("qa-2", "i-2")],
    });
    // 전부 artifact 인데 qaIssueId 없는 ref 만 — title 은 "산출물", fact value 는 "혼합".
    parity({ ...base, linkIssueId: null, missionId: null,
      findings: [finding("a", "artifact"), finding("b", "artifact")],
      qaRefs: [qaRef("qa-1"), qaRef("qa-2")] });
  });

  it("matches localeCompare ordering for findings/qaRefs across scripts and case", () => {
    parity({
      ...base,
      findings: [
        finding("z-1", "artifact"), finding("Z-2"), finding("10"), finding("f-1"),
        finding("가-1"), finding("中-2"), finding("a-1", "artifact"), finding("A-2"),
        finding("f-10"), finding("é-1"),
      ],
      qaRefs: [qaRef("qa-10"), qaRef("qa-2"), qaRef("QA-1"), qaRef("가-1"), qaRef("中-1"), qaRef("qa--x")],
    });
    // 중복 id — 안정 정렬 유지 확인(동일 id 의 상대 순서 보존).
    parity({ ...base,
      findings: [finding("dup", "artifact", "first"), finding("dup", "source_data", "second"), finding("a")],
      qaRefs: [qaRef("q", "i-2"), qaRef("q", "i-1")] });
  });

  it("matches truthiness and ToString edge handling for optional fields", () => {
    parity({ ...base, linkIssueId: "", missionId: null, iteration: 2.5, maxIterations: "x",
      findings: [finding("f")], qaRefs: [qaRef("q", "")] });
    parity({ ...base, linkIssueId: 0, missionId: "m", workflowRunId: 42, producerStepId: 7,
      findings: [finding("f", null, [1, 2])], qaRefs: [qaRef("q", 5), qaRef("p", 0)] });
    parity({ ...base, findings: [finding("f", 9, { a: 1 })], qaRefs: [qaRef("q", true)] });
    // absent iteration/maxIterations/missionId/linkIssueId → "undefined"/null key 규칙.
    parity({ findings: [finding("f")], qaRefs: [], workflowRunId: "r", producerStepId: "s" });
    parity({ findings: [], qaRefs: [], workflowRunId: "r", producerStepId: "s", iteration: 1e21, maxIterations: -0 });
  });

  it("honours the len>=2 TypeError boundary for non-string sort keys", () => {
    // n=1: 비교자 미호출 — id/qaStepId 가 ToString 으로만 렌더.
    parity({ ...base, findings: [finding(5, "source_data", "x")], qaRefs: [qaRef(9)] });
    parity({ ...base, findings: [finding({ nested: 1 })], qaRefs: [qaRef("q")] });
    parity({ ...base, findings: [finding("ok")], qaRefs: [qaRef(null)] });
    // n>=2: 비교자가 비문자열 id/step 에 TypeError — 양쪽 동일 실패.
    parityThrow({ ...base, findings: [finding("a"), finding(5)], qaRefs: [] });
    parityThrow({ ...base, findings: [finding("a"), finding(null)], qaRefs: [] });
    parityThrow({ ...base, findings: [finding("a"), finding("b")], qaRefs: [qaRef("q"), qaRef(1)] });
    parityThrow({ ...base, findings: "ab", qaRefs: [] });
    parityThrow({ ...base, qaRefs: "xy" });
    parityThrow({ ...base });
    parityThrow(null);
    parityThrow("x");
    parityThrow({ ...base, findings: [], qaRefs: [], promotedFindingIds: 3 });
    parity({ ...base, findings: [finding("a"), finding("b")], qaRefs: [], promotedFindingIds: "ab" });
    parity({ ...base, findings: [finding("b")], qaRefs: [], promotedFindingIds: ["b", 7, null] });
  });

  it("matches UTF-16 slice boundaries incl. split surrogate pairs", () => {
    // value = "[source_data] " (14u) + 185u + emoji → 200 컷이 high surrogate 절단.
    parity({ ...base, findings: [finding("e", "source_data", `${"x".repeat(185)}😀`)], qaRefs: [qaRef("q")] });
    // label = "결함 " (4u) + id — 80 컷이 이모지 쌍 중간을 자른다(4+75=79, 이모지 79-80).
    parity({ ...base, findings: [finding(`${"i".repeat(75)}😀`)], qaRefs: [] });
    // title 200 컷 — 긴 producerStepId.
    parity({ ...base, producerStepId: `p${"s".repeat(220)}`, findings: [finding("f", "artifact")], qaRefs: [] });
    // sourceId 200 컷 — 긴 workflowRunId.
    parity({ ...base, workflowRunId: `${"r".repeat(210)}`, findings: [finding("f")], qaRefs: [] });
    // interpretation 4000 컷 — 긴 findings 나열(이모지 포함, 쌍 유지/절단 양쪽 경로).
    parity({ ...base,
      findings: Array.from({ length: 30 }, (_, i) => finding(`f-${i}`, i % 3 ? "artifact" : "source_data", `결함 ${"😀".repeat(60)}`)),
      qaRefs: [qaRef("q", "i-1")] });
    // evidence description 1000 컷.
    parity({ ...base,
      findings: Array.from({ length: 15 }, (_, i) => finding(`f-${i}`, "source_data", `s${"x".repeat(60)}`)),
      qaRefs: [qaRef("q")] });
    // description 4000 컷 — qaRefs 다수.
    parity({ ...base,
      findings: [finding("f")],
      qaRefs: Array.from({ length: 25 }, (_, i) => qaRef(`qa-${i}`, `issue-${i}`)) });
    // >8 findings — facts 는 8개 컷, findingsLines 는 전부.
    parity({ ...base,
      findings: Array.from({ length: 12 }, (_, i) => finding(`id-${11 - i}`, i % 2 ? "artifact" : "source_data", `s${i}`)),
      qaRefs: [] });
  });

  it("matches evidenceRefs cap and href interpolation edge cases", () => {
    parity({ ...base,
      findings: [finding("f")],
      qaRefs: Array.from({ length: 15 }, (_, i) => qaRef(`q${i}`, i % 2 ? `i-${i}` : null)) });
    parity({ ...base, findings: [finding("f")], qaRefs: [qaRef("q", { nested: true })] });
    parity({ ...base, findings: [finding("f")], qaRefs: [qaRef("q", ["a", 2])] });
  });
});
