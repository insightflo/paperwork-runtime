import { rmSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import { isInsideDbTransaction, runInsideDbTransaction } from "../services/workflow/workflow-core-tx-guard.js";
import {
  runWithNodeFallback,
  runWorkflowCoreSubcommand,
  validateDagWithNodeFallback,
  WorkflowCoreUnavailableError,
} from "../services/workflow/workflow-core-client.js";
import { validateDag as validateDagNode } from "../services/workflow/dag-validation.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";
import { setWorkflowToolStepExecutor, syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { withReplacementFirstDelivery } from "../services/workflow/replacement-first-delivery.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { claimPlainWorkflowStart } from "../services/workflow/plain-start-claim.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";

/**
 * [목적] Observation ① — 표시된 DB 트랜잭션 안에서 workflow-core 서브프로세스 스폰 금지를 증명한다.
 *   countBin 은 스폰될 때마다 카운터 파일에 한 줄을 남긴다 — "0 spawns" 를 파일 내용으로 검증한다.
 */
const steps: WorkflowStep[] = [
  { id: "s1", name: "s1", agentId: "g1", dependencies: [] },
  { id: "s2", name: "s2", agentId: "g1", dependencies: ["s1"] },
];
// TS validateDag 는 s2 에 unreachable warning 1개를 남긴다 — canned Rust 응답과 다른 TS 판별자.

let binDir: string;
let countFile: string;
let countBin: string;

async function spawnCount(): Promise<number> {
  try {
    return (await readFile(countFile, "utf8")).split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

beforeAll(async () => {
  binDir = await mkdtemp(path.join(tmpdir(), "wf-tx-guard-"));
  countFile = path.join(binDir, "count");
  countBin = path.join(binDir, "count-bin");
  await writeFile(countBin, [
    "#!/bin/bash",
    'echo spawn >> "$WF_CORE_SPAWN_COUNT"',
    "cat >/dev/null",
    'echo \'{"valid":true,"errors":[],"warnings":[]}\'',
    "",
  ].join("\n"), "utf8");
  await chmod(countBin, 0o755);
});

afterAll(async () => {
  await rm(binDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("WF_CORE_SPAWN_COUNT", countFile);
  vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", countBin);
  vi.stubEnv("WORKFLOW_CORE_RUST", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("isInsideDbTransaction", () => {
  it("is false outside any marked scope", () => {
    expect(isInsideDbTransaction()).toBe(false);
  });

  it("stays true across await boundaries and nested scopes, then restores", async () => {
    const seen: boolean[] = [];
    await runInsideDbTransaction(async () => {
      seen.push(isInsideDbTransaction());
      await Promise.resolve();
      seen.push(isInsideDbTransaction());
      await runInsideDbTransaction(async () => {
        await Promise.resolve();
        seen.push(isInsideDbTransaction());
      });
      seen.push(isInsideDbTransaction());
    });
    await expect(runInsideDbTransaction(async () => {
      seen.push(isInsideDbTransaction());
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(seen).toEqual([true, true, true, true, true]);
    expect(isInsideDbTransaction()).toBe(false);
  });

  it("does not leak into async work started outside the marked scope", async () => {
    let siblingFlag = true;
    const sibling = (async () => {
      await Promise.resolve();
      siblingFlag = isInsideDbTransaction();
    })();
    await runInsideDbTransaction(async () => {
      await Promise.resolve();
    });
    await sibling;
    expect(siblingFlag).toBe(false);
  });
});

describe("workflow-core subprocess gate", () => {
  it("spawns the helper normally outside a marked transaction", async () => {
    const before = await spawnCount();
    const result = await validateDagWithNodeFallback(steps);
    expect(result).toEqual({ valid: true, errors: [], warnings: [] }); // canned Rust 응답
    expect(await spawnCount()).toBe(before + 1);
  });

  it("inside a marked transaction it returns the in-process TS result with zero spawns", async () => {
    const before = await spawnCount();
    const result = await runInsideDbTransaction(async () => {
      expect(isInsideDbTransaction()).toBe(true);
      return validateDagWithNodeFallback(steps);
    });
    expect(result).toEqual(validateDagNode(steps));
    expect(result.warnings).toHaveLength(1); // TS 팔 증명 — Rust 응답은 warnings 빈 배열
    expect(await spawnCount()).toBe(before);
  });

  it("runWithNodeFallback takes the TS arm without touching payload or the helper", async () => {
    const before = await spawnCount();
    let payloadCalled = false;
    let interpretCalled = false;
    const result = await runInsideDbTransaction(() => runWithNodeFallback({
      subcommand: "validate-dag",
      payload: () => { payloadCalled = true; return {}; },
      fallback: () => "ts-result",
      interpret: () => { interpretCalled = true; return "rust-result"; },
    }));
    expect(result).toBe("ts-result");
    expect(payloadCalled).toBe(false);
    expect(interpretCalled).toBe(false);
    expect(await spawnCount()).toBe(before);
  });

  it("runWorkflowCoreSubcommand rejects inside a transaction without spawning", async () => {
    const before = await spawnCount();
    await expect(runInsideDbTransaction(() => runWorkflowCoreSubcommand("validate-dag", {})))
      .rejects.toSatisfy(
        (err: unknown) => err instanceof WorkflowCoreUnavailableError
          && err.message === "workflow_core_in_transaction",
      );
    expect(await spawnCount()).toBe(before);
  });

  it("the helper path is usable again after the marked scope exits", async () => {
    await runInsideDbTransaction(async () => {
      await validateDagWithNodeFallback(steps);
    });
    const before = await spawnCount();
    expect(await validateDagWithNodeFallback(steps)).toEqual({ valid: true, errors: [], warnings: [] });
    expect(await spawnCount()).toBe(before + 1);
  });
});

describe("withReplacementFirstDelivery (embedded PostgreSQL)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("wf-tx-guard-");
    db = createDb(temp.connectionString);
    setWorkflowToolStepExecutor(async () => ({ accepted: true }));
  }, 60_000);

  afterAll(async () => {
    setWorkflowToolStepExecutor(null);
    await db.$client.end();
    await temp.cleanup();
    roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it("marks deliver(tx): workflow-core inside uses TS with zero subprocess spawns", async () => {
    const s = await seedReplacement(db);
    roots.push(s.tempRoot);
    const target = (await admitReplacement(db, s.input, s.actor)).run;
    const hooks = { activateMission: async () => {} } as never;
    expect(await claimPlainWorkflowStart(db, target.id, hooks)).toBe("started");
    // 실제 first-delivery 경로가 표시된 트랜잭션 안에서 커밋된다(deliveredAt 기록).
    await syncWorkflowRunState(db, target.id);

    const before = await spawnCount();
    let flag = false;
    let dag: Awaited<ReturnType<typeof validateDagWithNodeFallback>> | undefined;
    await withReplacementFirstDelivery(db, target.id, async () => {
      flag = isInsideDbTransaction();
      dag = await validateDagWithNodeFallback(steps);
    });
    expect(flag).toBe(true);
    expect(dag).toEqual(validateDagNode(steps));
    expect(await spawnCount()).toBe(before);
    expect(isInsideDbTransaction()).toBe(false);
  }, 60_000);
});
