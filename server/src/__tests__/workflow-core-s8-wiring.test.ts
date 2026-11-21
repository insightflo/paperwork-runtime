import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Db } from "@paperclipai/db";
import { PgTransaction } from "drizzle-orm/pg-core";
import { forwardReachable } from "../services/workflow/resume/graph.js";
import type { ResumeNode } from "../services/workflow/resume/types.js";
import { normalizeWorkflowStepMachineChecks } from "../services/workflow/step-contract.js";
import {
  findWorkflowDefinitionStepWarnings,
  summarizeDefinitionStepWarnings,
  validateWorkflowDefinitionSteps,
} from "../services/workflow/definition-step-validation.js";
import { evaluateStepMachineChecks } from "../services/workflow/step-machine-checks.js";
import { resetWorkflowCoreFallbackWarningsForTests } from "../services/workflow/workflow-core-client.js";
import {
  forwardReachableWithNodeFallback,
  normalizeWorkflowStepMachineChecksWithNodeFallback,
} from "../services/workflow/workflow-core-client-s8a.js";
import {
  findWorkflowDefinitionStepWarningsWithNodeFallback,
  summarizeDefinitionStepWarningsWithNodeFallback,
  validateWorkflowDefinitionStepsWithNodeFallback,
} from "../services/workflow/workflow-core-client-s8c.js";
import { createWorkflowDefinition, updateWorkflowDefinition } from "../services/workflow/workflow-store.js";

/**
 * [목적] Stage 8A/8C 프로덕션 와이어링(step-machine-checks.ts, workflow-store.ts,
 *   routes/workflows.ts)과 fallback 계약 검증.
 *   - bin 미설정 → TS 경로 무음 통과(와이어링 전과 동일 동작).
 *   - bin 설정(canned mock 또는 release bin) → Rust 팔 실행, TS 결과와 1:1.
 *   - 깨진 bin(부재/비JSON) → warn-once 후 TS fallback, 예외 없음.
 *   - evaluateStepMachineChecks 실 프로덕션 함수로 Rust marker 전파를 증명한다.
 *   - [F4] resume/preview.ts 는 항상 열린 DB tx 안에서 실행돼 순수 TS 로 복원(와이어링 제외).
 *     workflow-store 의 create/update 도 db 가 PgTransaction 이면 Rust 스폰을 건너뛰고
 *     순수 TS 검증으로 보전한다 — 아래 마지막 describe 가 그 가드를 증명한다.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

let dir: string;
let cannedBin: string;
let garbageBin: string;
let warn: MockInstance;

async function writeBin(name: string, body: string): Promise<string> {
  const binPath = path.join(dir, name);
  await writeFile(binPath, `#!/bin/bash\n${body}\n`, "utf8");
  await chmod(binPath, 0o755);
  return binPath;
}

const CANNED_SCRIPT = `cat >/dev/null
case "$1" in
  forward-reachable) echo '{"reachable":["rust-arm"]}' ;;
  normalize-step-machine-checks) echo '{"machineChecks":[{"kind":"file_exists","path":"rust-arm"}]}' ;;
  validate-definition-steps) echo '{"ok":true}' ;;
  definition-step-warnings) echo '{"warnings":[{"kind":"workproduct_selector_missing","stepId":"rust-step","referencedStepId":"rust-arm","message":"rust-arm"}]}' ;;
  summarize-step-warnings) echo '{"summary":[{"kind":"workproduct_selector_missing","stepId":"rust-step","referencedStepId":"rust-arm"}]}' ;;
esac`;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "wf-core-s8-wiring-"));
  cannedBin = await writeBin("canned", CANNED_SCRIPT);
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("WORKFLOW_CORE_RUST", ""); // 게이트 열림(unset 과 동급)
  vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", ""); // 기본: bin 미설정 → TS 직행
  vi.stubEnv("PAPERCLIP_FS_SCAN_BIN", ""); // evaluateStepMachineChecks 는 Node 스캔 경로 유지
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetWorkflowCoreFallbackWarningsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const GRAPH: ResumeNode[] = [
  { id: "a", dependencies: [], conditionalDependencies: [] },
  { id: "b", dependencies: ["a"], conditionalDependencies: [] },
];
const CHECKS = [
  { kind: "file_exists", path: "p" },
  { kind: "file_glob", dir: "d", glob: "*.txt", minCount: 1 },
];
const DEF_STEPS = [
  { id: "a", dependencies: ["a-root"], toolArgs: {} },
  { id: "b", dependencies: ["a"], toolArgs: { out: "{$steps.a.workProductPath}" } },
];

/** [서브커맨드, 브리지 호출, TS 직접 호출, canned 응답] — canned 은 TS 결과와 달라 Rust 팔 실행을 증명한다. */
const CASES: [string, () => Promise<unknown>, () => unknown, unknown][] = [
  ["forward-reachable",
    () => forwardReachableWithNodeFallback(GRAPH, "a"),
    () => forwardReachable(GRAPH, "a"),
    ["rust-arm"]],
  ["normalize-step-machine-checks",
    () => normalizeWorkflowStepMachineChecksWithNodeFallback(CHECKS),
    () => normalizeWorkflowStepMachineChecks(CHECKS),
    [{ kind: "file_exists", path: "rust-arm" }]],
  ["validate-definition-steps",
    () => validateWorkflowDefinitionStepsWithNodeFallback(DEF_STEPS),
    () => validateWorkflowDefinitionSteps(DEF_STEPS),
    undefined],
  ["definition-step-warnings",
    () => findWorkflowDefinitionStepWarningsWithNodeFallback(DEF_STEPS),
    () => findWorkflowDefinitionStepWarnings(DEF_STEPS),
    [{ kind: "workproduct_selector_missing", stepId: "rust-step", referencedStepId: "rust-arm", message: "rust-arm" }]],
  ["summarize-step-warnings",
    () => summarizeDefinitionStepWarningsWithNodeFallback(findWorkflowDefinitionStepWarnings(DEF_STEPS)),
    () => summarizeDefinitionStepWarnings(findWorkflowDefinitionStepWarnings(DEF_STEPS)),
    [{ kind: "workproduct_selector_missing", stepId: "rust-step", referencedStepId: "rust-arm" }]],
];

describe("workflow-core s8 wiring & fallback", () => {
  it("bin unset: wired functions run the TS path cleanly without warning", async () => {
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned bin: Rust arm executes (marker responses reach the caller)", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", cannedBin);
    for (const [name, run, , canned] of CASES) {
      expect(await run(), name).toEqual(canned);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("missing bin: graceful TS fallback with warn-once, no throw", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", "/nonexistent/paperclip-workflow-core");
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).toHaveBeenCalled();
  });

  it("garbage bin (non-JSON stdout): graceful TS fallback with warn-once", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", garbageBin);
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).toHaveBeenCalled();
  });

  it("WORKFLOW_CORE_RUST=0: silent TS direct path even with bin configured", async () => {
    vi.stubEnv("WORKFLOW_CORE_RUST", "0");
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", cannedBin); // 스폰되면 rust-arm marker — Node 팔 증명
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).not.toHaveBeenCalled();
  });

  describe.skipIf(!existsSync(rustBin))("release binary parity", () => {
    it("Rust release bin matches TS output 1:1 for every wired function", async () => {
      vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
      for (const [name, run, ts] of CASES) {
        expect(await run(), name).toEqual(ts());
      }
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("production wiring proof (evaluateStepMachineChecks)", () => {
    const run = (bin: string | null) => {
      if (bin) vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", bin);
      return evaluateStepMachineChecks({
        checks: CHECKS,
        resolvePath: () => null, // 어떤 경로도 해석 못하게 해 check.path 마커를 결과에 그대로 남긴다
        workspaceCwd: tmpdir(),
      });
    };

    it("routes machineChecks normalization through the Rust bridge when bin is configured", async () => {
      const { results } = await run(cannedBin);
      // canned Rust 응답의 rust-arm path 가 그대로 평가 결과에 흐른다 — TS 직행이면 p/d 여야 한다.
      expect(results.map((result) => result.path)).toEqual(["rust-arm"]);
    });

    it("keeps the TS path untouched when bin is unset", async () => {
      const { results } = await run(null);
      expect(results.map((result) => result.path)).toEqual(["p", "d"]);
    });

    it("falls back to the TS path without throwing when the bin is broken", async () => {
      const { results } = await run("/nonexistent/paperclip-workflow-core");
      expect(results.map((result) => result.path)).toEqual(["p", "d"]);
      expect(warn).toHaveBeenCalled();
    });
  });

  describe("workflow-store PgTransaction guard (F4)", () => {
    // TS 검증만 잡는 중복 id — canned bin 은 어떤 입력에도 {ok:true} 를 돌려주므로,
    //   중복 id 가 throw 되면 TS 팔이, 조용히 통과하면 Rust 팔이 실행된 것으로 증명된다.
    const DUP_STEPS = [
      { id: "dup", dependencies: [], toolArgs: {} },
      { id: "dup", dependencies: [], toolArgs: {} },
    ];
    // is(db, PgTransaction) 이 true 를 돌려주는 최소 객체 — 가드가 참이면 db 메서드는 호출되지 않는다.
    const txDb = () => Object.create(PgTransaction.prototype) as unknown as Db;
    // tx 가 아닌 최소 체인 — updateWorkflowDefinition 이 쓰는 update→set→where,
    //   getWorkflowDefinitionById 가 쓰는 select→from→where→limit 만 지원한다.
    const nonTxDb = () => ({
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    }) as unknown as Db;

    it("updateWorkflowDefinition skips the Rust spawn inside a PgTransaction (pure TS arm)", async () => {
      vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", cannedBin);
      await expect(updateWorkflowDefinition(txDb(), "wf-1", { steps: DUP_STEPS as never }))
        .rejects.toThrow(/Duplicate workflow step ids: dup/);
    });

    it("updateWorkflowDefinition still uses the Rust bridge outside a transaction", async () => {
      vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", cannedBin);
      // canned {ok:true} 가 중복 id 도 통과시킨다 — TS 팔이었다면 422 로 던졌어야 한다.
      await expect(updateWorkflowDefinition(nonTxDb(), "wf-1", { steps: DUP_STEPS as never })).resolves.toBeNull();
    });

    it("createWorkflowDefinition skips the Rust spawn inside a PgTransaction (pure TS arm)", async () => {
      vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", cannedBin);
      await expect(createWorkflowDefinition(txDb(), { companyId: "c-1", name: "wf", steps: DUP_STEPS as never }))
        .rejects.toThrow(/Duplicate workflow step ids: dup/);
    });
  });
});
