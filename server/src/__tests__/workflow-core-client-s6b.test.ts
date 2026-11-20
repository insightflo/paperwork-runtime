import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { buildHistoricalQaSourceDefectCard } from "../services/workflow/qa-source-defect-card-historical.js";
import { resetWorkflowCoreFallbackWarningsForTests } from "../services/workflow/workflow-core-client.js";
import { buildHistoricalQaSourceDefectCardWithNodeFallback } from "../services/workflow/workflow-core-client-s6b.js";

/**
 * [목적] Stage 6B Node 브리지(workflow-core-client-s6b)의 양 팔 검증.
 *   - Node fallback 팔: WORKFLOW_CORE_RUST=0 / bin 미설정 → TS 구현 결과 그대로(무음).
 *   - 실 Rust bin 팔: PAPERCLIP_WORKFLOW_CORE_BIN=release bin → 동일 계약(canned bin 으로 팔 증명).
 *   - malformed/disabled bin → warn-once 후 TS fallback.
 *   카드 전체 패리티(정렬·UTF-16 slice·truthiness)는 workflow-core-rust-parity-s6b.test.ts 담당.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

let dir: string;
let cannedBin: string;
let wrongShapeBin: string;
let garbageBin: string;
let warn: MockInstance;

async function writeBin(name: string, body: string): Promise<string> {
  const binPath = path.join(dir, name);
  await writeFile(binPath, `#!/bin/bash\n${body}\n`, "utf8");
  await chmod(binPath, 0o755);
  return binPath;
}

const CANNED_CARD = JSON.stringify({
  schemaVersion: 1, requestKey: "rust-arm-key", priority: "high", interactionType: "single_select",
  title: "RUST-ARM-TITLE", description: "rust arm", sourceType: "workflow_qa_rejection",
  sourceId: "r:p:0",
  sourceContext: { missionId: null, workflowId: null, workflowRunId: "r", artifactRefs: [] },
  definition: {
    options: [], actions: [], selection: { min: 1, max: 1 },
    comment: { mode: "optional", label: "m", maxLength: 1 },
    approvedScope: [], forbiddenScope: [], humanReview: { schemaVersion: "human-review-v1" },
  },
  issueId: null, continuationMode: "none",
});

beforeAll(async () => {
  execFileSync(process.env.CARGO || "cargo",
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "wf-core-s6b-"));
  cannedBin = await writeBin("canned", `cat >/dev/null; echo '${CANNED_CARD}'`);
  wrongShapeBin = await writeBin("wrong-shape", 'cat >/dev/null; echo "{}"');
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("WORKFLOW_CORE_RUST", ""); // 게이트 열림(unset 과 동급)
  vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", ""); // 기본: bin 미설정
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetWorkflowCoreFallbackWarningsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type CardInput = Parameters<typeof buildHistoricalQaSourceDefectCard>[0];

const base: CardInput = {
  workflowRunId: "run-1",
  producerStepId: "produce",
  iteration: 2,
  maxIterations: 3,
  findings: [
    { id: "f-1", layer: "source_data", summary: "원천 결함 요약" },
    { id: "f-2", layer: "artifact", summary: "산출물 결함 요약" },
  ],
  qaRefs: [
    { qaStepId: "qa-1", qaIssueId: "issue-1" },
    { qaStepId: "qa-2", qaIssueId: null },
  ],
  missionId: "m-1",
  linkIssueId: "issue-9",
  promotedFindingIds: ["f-2"],
};

const build = buildHistoricalQaSourceDefectCardWithNodeFallback;

describe("buildHistoricalQaSourceDefectCardWithNodeFallback", () => {
  it("Node arm (WORKFLOW_CORE_RUST=0) returns the TS card without spawning", async () => {
    vi.stubEnv("WORKFLOW_CORE_RUST", "0");
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", cannedBin); // 스폰되면 RUST-ARM-TITLE — Node 팔 증명
    const card = await build(base);
    expect(card).toEqual(buildHistoricalQaSourceDefectCard(base));
    expect(card.title).not.toBe("RUST-ARM-TITLE");
    expect(warn).not.toHaveBeenCalled();
  });

  it("bin unset also uses Node silently", async () => {
    expect(await build(base)).toEqual(buildHistoricalQaSourceDefectCard(base));
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm returns a card identical to the TS build", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
    expect(await build(base)).toEqual(buildHistoricalQaSourceDefectCard(base));
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm matches TS across empty/promoted/null-field variants", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
    const variants: CardInput[] = [
      { ...base, findings: [], qaRefs: [], missionId: null, linkIssueId: null, promotedFindingIds: undefined },
      { ...base, iteration: 0, maxIterations: 1, promotedFindingIds: ["f-1", "ghost"] },
    ];
    for (const input of variants) {
      expect(await build(input)).toEqual(buildHistoricalQaSourceDefectCard(input));
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned Rust response is returned verbatim (Rust 팔 실행 증명)", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", cannedBin);
    const card = await build(base);
    expect(card.title).toBe("RUST-ARM-TITLE");
    expect(card.requestKey).toBe("rust-arm-key");
    expect(warn).not.toHaveBeenCalled();
  });

  it("unavailable helper falls back to the TS card and warns once", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", path.join(dir, "does-not-exist"));
    const first = await build(base);
    const second = await build(base);
    expect(first).toEqual(buildHistoricalQaSourceDefectCard(base));
    expect(second).toEqual(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("qa-defect-card-historical"));
  });

  it("wrong-shape stdout falls back with a contract warning", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", wrongShapeBin);
    expect(await build(base)).toEqual(buildHistoricalQaSourceDefectCard(base));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("qa_defect_card_bad_shape"));
  });

  it("non-JSON stdout falls back with a contract warning", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", garbageBin);
    expect(await build(base)).toEqual(buildHistoricalQaSourceDefectCard(base));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("workflow_core_bad_json"));
  });

  it("semantic failure rejects identically on both arms (Rust exit 1 → TS 재판정)", async () => {
    const bad = { ...base, findings: "ab" } as unknown as CardInput;
    await expect(build(bad)).rejects.toThrow(); // TS 팔 — bin 미설정
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
    await expect(build(bad)).rejects.toThrow(); // Rust exit 1 → fallback → 동일 TS 에러
  });
});
