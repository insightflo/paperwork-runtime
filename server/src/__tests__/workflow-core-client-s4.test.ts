import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { evaluateWorkflowConditionGroup } from "../services/workflow/control-flow/condition-evaluator.js";
import { WorkProductConditionWaitableError } from "../services/workflow/control-flow/waitable-condition-error.js";
import { resetWorkflowCoreFallbackWarningsForTests } from "../services/workflow/workflow-core-client.js";
import {
  classifyRetryBatchWithNodeFallback,
  evaluateConditionsWithNodeFallback,
  type WorkflowRetryBatchClassifyItem,
} from "../services/workflow/workflow-core-client-s4.js";
import type { WorkflowConditionGroup, WorkflowConditionSource } from "@paperclipai/shared";

/**
 * [목적] Stage 4B Node 브리지(workflow-core-client-s4)의 양 팔 검증.
 *   - Node fallback 팔: WORKFLOW_CORE_RUST=0 → TS 구현 결과 그대로.
 *   - 실 Rust bin 팔: PAPERCLIP_WORKFLOW_CORE_BIN=release bin → 동일 계약.
 *   - 시맨틱 에러(waitable/evaluation_failed)는 어느 팔이든 fallback 없이 전파 —
 *     fake bin 이 TS 와 다른 페이로드를 주는 것으로 어느 팔이 응답했는지 구분한다.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

let dir: string;
let okEvalBin: string;
let waitableBin: string;
let evalFailBin: string;
let wrongShapeBin: string;
let wrongIdBin: string;
let warn: MockInstance;

async function writeBin(name: string, body: string): Promise<string> {
  const binPath = path.join(dir, name);
  await writeFile(binPath, `#!/bin/bash\n${body}\n`, "utf8");
  await chmod(binPath, 0o755);
  return binPath;
}

beforeAll(async () => {
  execFileSync(process.env.CARGO || "cargo",
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "wf-core-s4-"));
  okEvalBin = await writeBin("ok-eval", 'cat >/dev/null; echo \'{"outcome":true,"results":[true]}\'');
  waitableBin = await writeBin("waitable", 'cat >/dev/null; echo \'{"error":{"code":"waitable_type_mismatch","message":"Workflow IF condition failed: rust-side mismatch","sourceStepId":"rust-step","sourceTitle":"rust.json"}}\'');
  evalFailBin = await writeBin("eval-fail", 'cat >/dev/null; echo \'{"error":{"code":"evaluation_failed","message":"Workflow IF condition failed: rust boom"}}\'');
  wrongShapeBin = await writeBin("wrong-shape", 'cat >/dev/null; echo "{}"');
  wrongIdBin = await writeBin("wrong-id", 'cat >/dev/null; echo \'{"items":[{"id":"WRONG","eligible":false,"reason":"disabled"}]}\'');
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

// ── evaluate-conditions fixtures ─────────────────────────────────────

const wpSrc = (stepId: string, jsonPath = "$") =>
  ({ kind: "work_product_json", stepId, path: jsonPath, title: `${stepId}.json` }) as const;

function cond(over: Record<string, unknown>) {
  return { source: wpSrc("p1"), dataType: "string", operator: "equals", rightValue: "x", ...over };
}

function groupOf(conditions: Array<Record<string, unknown>>, combinator: "all" | "any" = "all") {
  return { combinator, conditions } as unknown as WorkflowConditionGroup;
}

function resolverFor(roots: ReadonlyMap<unknown, unknown>) {
  return (source: WorkflowConditionSource) => roots.get(source);
}

const srcA = wpSrc("pa", "$.status");
const srcB = wpSrc("pb", "$.n");
const conditions = [
  cond({ source: srcA, operator: "starts_with", rightValue: "sel" }),
  cond({ source: srcB, dataType: "number", operator: "greater_than", rightValue: 4 }),
];
const roots = new Map<unknown, unknown>([[srcA, { status: "selected" }], [srcB, { n: 5 }]]);

describe("evaluateConditionsWithNodeFallback", () => {
  it("Node arm (WORKFLOW_CORE_RUST=0) returns the TS evaluation without spawning", async () => {
    vi.stubEnv("WORKFLOW_CORE_RUST", "0");
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", wrongShapeBin); // 스폰되면 계약 위반 — Node 팔 증명
    const group = groupOf(conditions);
    const resolveSource = resolverFor(roots);
    expect(await evaluateConditionsWithNodeFallback({ group, resolveSource }))
      .toEqual(evaluateWorkflowConditionGroup({ group, resolveSource }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm returns the same evaluation", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
    const group = groupOf(conditions);
    const resolveSource = resolverFor(roots);
    expect(await evaluateConditionsWithNodeFallback({ group, resolveSource }))
      .toEqual(evaluateWorkflowConditionGroup({ group, resolveSource }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("waitable_type_mismatch propagates as WorkProductConditionWaitableError (no fallback)", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", waitableBin);
    const srcW = wpSrc("real"); // TS fallback 이 던졌다면 stepId "real" — rust-step 이면 Rust 팔 증명
    const group = groupOf([cond({ source: srcW, dataType: "number" })]);
    await expect(evaluateConditionsWithNodeFallback({ group, resolveSource: resolverFor(new Map([[srcW, "x"]])) }))
      .rejects.toSatisfy((err) =>
        err instanceof WorkProductConditionWaitableError
        && err.sourceStepId === "rust-step"
        && err.sourceTitle === "rust.json"
        && err.message === "Workflow IF condition failed: rust-side mismatch");
    expect(warn).not.toHaveBeenCalled();
  });

  it("evaluation_failed propagates as a plain Error (no fallback)", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", evalFailBin);
    const group = groupOf(conditions);
    const promise = evaluateConditionsWithNodeFallback({ group, resolveSource: resolverFor(roots) });
    await expect(promise).rejects.toThrowError("Workflow IF condition failed: rust boom");
    await expect(promise).rejects.toSatisfy((err) => !(err instanceof WorkProductConditionWaitableError));
    expect(warn).not.toHaveBeenCalled();
  });

  it("contract violations fall back to the TS evaluation and warn once", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", wrongShapeBin);
    const group = groupOf(conditions);
    const resolveSource = resolverFor(roots);
    expect(await evaluateConditionsWithNodeFallback({ group, resolveSource }))
      .toEqual(evaluateWorkflowConditionGroup({ group, resolveSource }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("evaluate-conditions"));
  });

  it("readRestrictedJsonPath stays in TS — path errors beat a canned Rust success", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", okEvalBin);
    const srcP = wpSrc("p9", "$.[bad");
    const group = groupOf([cond({ source: srcP })]);
    await expect(evaluateConditionsWithNodeFallback({ group, resolveSource: resolverFor(new Map([[srcP, {}]])) }))
      .rejects.toThrowError('Workflow IF condition failed: invalid JSON path "$.[bad"');
    expect(warn).not.toHaveBeenCalled();
  });
});

// ── classify-retry-batch fixtures ────────────────────────────────────

function retryItem(over: Record<string, unknown>): WorkflowRetryBatchClassifyItem {
  return {
    id: "sr",
    policy: { enabled: true, maxRetries: 3, delaySeconds: 30, backoff: "linear", jitter: false },
    stepRunStatus: "failed",
    retryCount: 0,
    isControlNode: false,
    stepTypeSupported: true,
    isQaStep: false,
    qaRequestChanges: false,
    recoveryActive: false,
    ...over,
  };
}

describe("classifyRetryBatchWithNodeFallback", () => {
  const nowIso = "2026-11-20T00:00:00.000Z";
  const items: WorkflowRetryBatchClassifyItem[] = [
    retryItem({
      id: "ok",
      policy: { enabled: true, maxRetries: 3, delaySeconds: 30, backoff: "linear", jitter: true },
      jitterRandom: 0.5, // factor 0.8+0.5*0.4 = 1.0 → delay 30
      metadata: {
        toolResult: { x: 1 },
        keep: "me",
        workflowRetryAttempts: [{ retryNumber: 0, failedAt: "2026-11-19T00:00:00Z", errorSummary: "Bearer abc123token" }],
      },
      sourceRequestId: "req-1",
      sourceCompletedAt: "2026-11-19T23:59:59.000Z",
      errorSummary: "Authorization: Bearer abc",
    }),
    retryItem({ id: "control", isControlNode: true }),
    retryItem({ id: "disabled", policy: undefined, policySource: { onFailure: "abort_workflow" } }),
    retryItem({ id: "exhausted", retryCount: 3 }),
    retryItem({ id: "qa", isQaStep: true, qaRequestChanges: true }),
    retryItem({ id: "recovery", recoveryActive: true }),
    retryItem({ id: "unsupported", stepTypeSupported: false }),
    retryItem({ id: "status", stepRunStatus: "pending" }),
  ];

  it("returns [] for an empty batch without spawning", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", wrongShapeBin);
    expect(await classifyRetryBatchWithNodeFallback({ items: [] })).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm and Node arm produce identical decisions and patches", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
    const rustArm = await classifyRetryBatchWithNodeFallback({ items, nowIso });
    vi.stubEnv("WORKFLOW_CORE_RUST", "0");
    const nodeArm = await classifyRetryBatchWithNodeFallback({ items, nowIso });
    expect(rustArm).toEqual(nodeArm);
    expect(warn).not.toHaveBeenCalled();

    const ok = rustArm.find((r) => r.id === "ok");
    if (ok?.eligible !== true) throw new Error("expected eligible ok result");
    expect(ok).toMatchObject({ retryNumber: 1, maxRetries: 3, delaySeconds: 30 });
    expect(ok.retryMetadata.nextEligibleAt).toBe("2026-11-20T00:00:30.000Z");
    expect(ok.retryMetadata.lastErrorSummary).toBe("[REDACTED]");
    expect(ok.metadata).not.toHaveProperty("toolResult");
    expect(ok.metadata.keep).toBe("me");
    expect(ok.metadata.workflowRetryAttempts).toHaveLength(2);

    const reasonById = new Map(
      rustArm.filter((r) => !r.eligible).map((r) => [r.id, r.reason] as const),
    );
    expect(reasonById).toEqual(new Map([
      ["control", "control_node"],
      ["disabled", "disabled"],
      ["exhausted", "exhausted"],
      ["qa", "qa_rework"],
      ["recovery", "recovery_active"],
      ["unsupported", "unsupported_step"],
      ["status", "malformed_state"],
    ]));
  });

  it("unavailable helper falls back to Node classification and warns once", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", path.join(dir, "does-not-exist"));
    const first = await classifyRetryBatchWithNodeFallback({ items: [items[0]], nowIso });
    const second = await classifyRetryBatchWithNodeFallback({ items: [items[0]], nowIso });
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({ id: "ok", eligible: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("classify-retry-batch"));
  });

  it("bad shape and id-echo mismatches fall back with contract warnings", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", wrongShapeBin);
    const viaShape = await classifyRetryBatchWithNodeFallback({ items: [items[0]], nowIso });
    expect(viaShape[0]).toMatchObject({ id: "ok", eligible: true });
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", wrongIdBin);
    const viaId = await classifyRetryBatchWithNodeFallback({ items: [items[0]], nowIso });
    expect(viaId).toEqual(viaShape);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("classify_retry_batch_bad"));
  });
});
