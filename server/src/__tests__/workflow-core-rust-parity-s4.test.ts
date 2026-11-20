import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateWorkflowConditionGroup } from "../services/workflow/control-flow/condition-evaluator.js";
import { WorkProductConditionWaitableError } from "../services/workflow/control-flow/waitable-condition-error.js";
import {
  appendRetryAttempt,
  buildWorkflowRetryMetadata,
  classifyWorkflowStepRetry,
  normalizeWorkflowRetryPolicy,
  sanitizeErrorSummary,
} from "../services/workflow/retry-policy.js";
import type { WorkflowConditionGroup, WorkflowConditionSource } from "@paperclipai/shared";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

function runRust<T>(subcommand: string, payload: unknown): T {
  const stdout = execFileSync(rustBin, [subcommand], { input: JSON.stringify(payload), encoding: "utf8" });
  return JSON.parse(stdout) as T;
}

beforeAll(() => {
  execFileSync(process.env.CARGO || "cargo",
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
}, 120_000);

// ── evaluate-conditions ──────────────────────────────────────────────
// TS 가 readRestrictedJsonPath 까지 수행하고 `left` 만 넘기는 계약 — Rust 는
// 연산자 평가 + all/any 환산만 한다. TS 측은 source 객체 identity 로 left 를 매핑한다.

type CondSpec = {
  source?: Partial<WorkflowConditionSource> & { kind?: string };
  dataType?: unknown;
  operator?: unknown;
  rightValue?: unknown;
  left: unknown;
};
type EvalSpec = { combinator?: unknown; conditions: CondSpec[] };
type EvalOut = { outcome?: boolean; results?: boolean[]; error?: { code: string; message: string; sourceStepId?: string; sourceTitle?: string } };

const srcWp = { kind: "work_product_json", stepId: "prod", path: "$", title: "t.json" } as const;
const srcTool = { kind: "tool_json", stepId: "prod", path: "$", toolName: "measure" } as const;
// 조건마다 고유 source 객체 — resolveSource 가 left 를 정확히 매핑해야 한다.
const wpAt = (i: number) => ({ ...srcWp, stepId: `s${i}` });

function rustEval(spec: EvalSpec): EvalOut {
  return runRust<EvalOut>("evaluate-conditions", {
    combinator: spec.combinator,
    conditions: spec.conditions.map((c, i) => ({ source: wpAt(i), ...c })),
  });
}

function tsEval(spec: EvalSpec) {
  const norm = spec.conditions.map((c, i) => ({ source: wpAt(i), ...c }));
  const leftBySource = new Map(norm.map((c) => [c.source, c.left]));
  const group = {
    combinator: (spec.combinator ?? "all") as "all" | "any",
    conditions: norm.map(({ left: _left, ...rest }) => rest),
  } as unknown as WorkflowConditionGroup;
  return evaluateWorkflowConditionGroup({ group, resolveSource: (s) => leftBySource.get(s) });
}

/** TS 와 동일 경로로 평가해 결과 또는 에러를 비교한다 — waitable 구분까지. */
function expectEvalParity(spec: EvalSpec) {
  const rust = rustEval(spec);
  try {
    const r = tsEval(spec);
    expect(rust.error).toBeUndefined();
    expect({ outcome: rust.outcome, results: rust.results }).toEqual({ outcome: r.outcome, results: r.results });
  } catch (err) {
    const waitable = err instanceof WorkProductConditionWaitableError;
    expect(rust.error?.code).toBe(waitable ? "waitable_type_mismatch" : "evaluation_failed");
    expect(rust.error?.message).toBe((err as Error).message);
    if (waitable) {
      expect(rust.error?.sourceStepId).toBe((err as WorkProductConditionWaitableError).sourceStepId);
      expect(rust.error?.sourceTitle).toBe((err as WorkProductConditionWaitableError).sourceTitle);
    }
  }
}

// ── classify-retry-batch ─────────────────────────────────────────────
// item = classify 입력 + patch 재료. TS 측은 normalize → classify → eligible 시
// step-retry-scheduler.ts 의 buildRetryMetadataPatch 와 같은 구성을 재현한다.

type BatchItem = Record<string, unknown> & { id: string };
const STALE_KEYS = ["toolResult", "toolInvocation", "toolQueue", "cacheHit", "controlFlowSkipped", "workflowRetryExhaustion"];

function tsBatchItem(item: BatchItem, nowIso: string) {
  const policy = (item.policy ?? normalizeWorkflowRetryPolicy((item.policySource ?? {}) as never)) as never;
  const decision = classifyWorkflowStepRetry(
    {
      policy,
      stepRunStatus: item.stepRunStatus,
      retryCount: item.retryCount,
      isControlNode: item.isControlNode,
      stepTypeSupported: item.stepTypeSupported,
      isQaStep: item.isQaStep,
      qaRequestChanges: item.qaRequestChanges,
      recoveryActive: item.recoveryActive,
    } as never,
    () => (typeof item.jitterRandom === "number" ? item.jitterRandom : 0.5),
  );
  if (!decision.eligible) return { id: item.id, eligible: false, reason: decision.reason };
  const cleaned: Record<string, unknown> = { ...((item.metadata as Record<string, unknown>) ?? {}) };
  for (const k of STALE_KEYS) delete cleaned[k];
  cleaned.workflowRetry = buildWorkflowRetryMetadata({
    retryNumber: decision.retryNumber,
    maxRetries: decision.maxRetries,
    delaySeconds: decision.delaySeconds,
    now: new Date(nowIso),
    sourceRequestId: (item.sourceRequestId ?? null) as string | null,
    sourceCompletedAt: (item.sourceCompletedAt ?? null) as string | null,
    lastErrorSummary: (item.errorSummary ?? null) as string | null,
  });
  cleaned.workflowRetryAttempts = appendRetryAttempt(cleaned.workflowRetryAttempts, {
    retryNumber: decision.retryNumber - 1,
    failedAt: (item.sourceCompletedAt ?? null) as string | null,
    errorSummary: sanitizeErrorSummary(item.errorSummary ?? null),
  });
  return {
    id: item.id,
    eligible: true,
    retryNumber: decision.retryNumber,
    maxRetries: decision.maxRetries,
    delaySeconds: decision.delaySeconds,
    retryMetadata: cleaned.workflowRetry,
    metadata: cleaned,
  };
}

function expectBatchParity(nowIso: string, items: BatchItem[]) {
  const rust = runRust<{ items: unknown[] }>("classify-retry-batch", { nowIso, items });
  expect(rust.items).toEqual(items.map((item) => tsBatchItem(item, nowIso)));
}

const baseFlags = { stepRunStatus: "failed", retryCount: 0, isControlNode: false, stepTypeSupported: true, isQaStep: false, qaRequestChanges: false, recoveryActive: false };

describe("paperclip-workflow-core Rust parity (Stage 4A: evaluate-conditions & classify-retry-batch)", () => {
  it("evaluates every operator family and combines all/any identically", () => {
    const specs: EvalSpec[] = [
      { combinator: "all", conditions: [
        { dataType: "string", operator: "equals", rightValue: "selected", left: "selected" },
        { dataType: "number", operator: "greater_than_or_equal", rightValue: 5, left: 5 },
        { dataType: "boolean", operator: "is_true", left: true },
        { dataType: "array", operator: "contains", rightValue: 2, left: [1, 2, 3] },
        { dataType: "object", operator: "has_key", rightValue: "a", left: { a: 1 } },
      ] },
      { combinator: "any", conditions: [
        { dataType: "string", operator: "contains", rightValue: "zz", left: "alpha-beta" },
        { dataType: "number", operator: "less_than", rightValue: 4, left: 5 },
        { dataType: "array", operator: "is_not_empty", left: [] },
      ] },
      { combinator: "all", conditions: [
        { dataType: "string", operator: "not_contains", rightValue: "x", left: "abc" },
        { dataType: "string", operator: "starts_with", rightValue: "al", left: "alpha" },
        { dataType: "string", operator: "ends_with", rightValue: "ha", left: "alpha" },
        { dataType: "string", operator: "is_empty", left: "" },
        { dataType: "number", operator: "not_equals", rightValue: 6, left: 5 },
        { dataType: "boolean", operator: "is_false", left: false },
        { dataType: "object", operator: "is_empty", left: {} },
      ] },
      { combinator: "odd-combinator", conditions: [
        { dataType: "string", operator: "equals", rightValue: "x", left: "y" },
      ] }, // TS: === "all" ? every : some — 비-"all" 도 some 환산.
      { combinator: "all", conditions: [
        { dataType: "date_time", operator: "equals", rightValue: "2026-07-20T01:00:00Z", left: "2026-07-20T10:00:00+09:00" },
        { dataType: "date_time", operator: "after", rightValue: "2026-07-20T01:00:01Z", left: "2026-07-20T10:00:00+09:00" },
        { dataType: "date_time", operator: "before_or_equal", rightValue: "2026-07-20T10:00:00Z", left: "2026-07-20T10:00:00Z" },
        { dataType: "date_time", operator: "not_equals", rightValue: "2026-07-20T11:00:00Z", left: "2026-07-20T10:00:00Z" },
      ] },
    ];
    for (const spec of specs) expectEvalParity(spec);
  });

  it("matches JS coercion semantics for non-strict right values", () => {
    const specs: EvalSpec[] = [
      { combinator: "all", conditions: [
        { dataType: "string", operator: "contains", rightValue: 5, left: "a5b" },       // String(5)="5"
        { dataType: "string", operator: "starts_with", rightValue: true, left: "true-ok" },
        { dataType: "string", operator: "ends_with", rightValue: [1, 2], left: "x1,2" }, // 배열 join
        { dataType: "number", operator: "greater_than", rightValue: "9", left: 10 },     // ToNumber("9")
        { dataType: "number", operator: "less_than", rightValue: "", left: 10 },         // ""→0
        { dataType: "number", operator: "equals", rightValue: "5", left: 5 },            // === 무강제 → false
        { dataType: "number", operator: "not_equals", rightValue: "5", left: 5 },        // !== → true
        { dataType: "object", operator: "has_key", rightValue: 5, left: { "5": 1 } },    // ToPropertyKey(5)
        { dataType: "array", operator: "contains", rightValue: null, left: [null] },     // SameValueZero null
        { dataType: "array", operator: "contains", rightValue: { a: 1 }, left: [{ a: 1 }] }, // 참조 → false
      ] },
      { combinator: "all", conditions: [
        { dataType: "string", operator: "equals", rightValue: "x", left: "x" },
        { dataType: "array", operator: "contains", left: ["undefined"] }, // rightValue absent = undefined
      ] },
    ];
    for (const spec of specs) expectEvalParity(spec);
  });

  it("preserves exact error messages and the waitable_type_mismatch distinction", () => {
    const specs: EvalSpec[] = [
      { combinator: "all", conditions: [{ dataType: "string", operator: "equals", rightValue: "x", left: 5 }] },
      { combinator: "all", conditions: [{ dataType: "number", operator: "equals", rightValue: 1, left: "x" }] },
      { combinator: "all", conditions: [{ dataType: "boolean", operator: "is_true", left: "x" }] },
      { combinator: "all", conditions: [{ source: srcTool, dataType: "number", operator: "equals", rightValue: 1, left: "x" }] }, // tool_json 은 비-waitable
      { combinator: "all", conditions: [{ dataType: "array", operator: "is_empty", left: "x" }] },   // work_product 여도 비-waitable
      { combinator: "all", conditions: [{ dataType: "object", operator: "has_key", rightValue: "a", left: [1] }] },
      { combinator: "all", conditions: [{ dataType: "date_time", operator: "after", rightValue: "2026-07-20T00:00:00Z", left: "07/20/2026" }] },
      { combinator: "all", conditions: [{ dataType: "date_time", operator: "after", rightValue: "07/20/2026", left: "2026-07-20T00:00:00Z" }] },
      // V8: 월말 초과 일자는 rollover — 2025-02-29 가 유효(=03-01)라서 right "x" 가 먼저 실패.
      { combinator: "all", conditions: [{ dataType: "date_time", operator: "equals", rightValue: "x", left: "2025-02-29T00:00:00Z" }] },
      { combinator: "all", conditions: [{ dataType: "date_time", operator: "equals", rightValue: "2025-03-01T00:00:00Z", left: "2025-02-29T00:00:00Z" }] }, // rollover 동치
      { combinator: "all", conditions: [{ dataType: "date_time", operator: "equals", rightValue: "x", left: "2026-13-01T00:00:00Z" }] },
      { combinator: "all", conditions: [{ dataType: "date_time", operator: "equals", rightValue: "x", left: "2026-01-01T00:00:00+24:00" }] },
      { combinator: "all", conditions: [{ dataType: "weird", operator: "equals", left: 1 }] },
      { combinator: "all", conditions: [{ dataType: "string", operator: "regex", left: "x" }] },
      { combinator: "all", conditions: [{ dataType: "number", operator: "equals", rightValue: 1 }] }, // left absent = undefined
      { combinator: "all", conditions: [{ dataType: "string", operator: "equals", rightValue: "x", left: null }] },
    ];
    for (const spec of specs) expectEvalParity(spec);
  });

  it("evaluates all conditions before AND/OR reduction (fail order preserved)", () => {
    expectEvalParity({ combinator: "all", conditions: [
      { dataType: "string", operator: "equals", rightValue: "nope", left: "x" }, // 이미 AND=false
      { dataType: "number", operator: "equals", rightValue: 1, left: "x" },      // 그래도 throw
    ] });
    expectEvalParity({ combinator: "any", conditions: [
      { dataType: "string", operator: "equals", rightValue: "x", left: "x" },    // 이미 OR=true
      { dataType: "number", operator: "equals", rightValue: 1, left: "x" },
    ] });
    // 첫 번째 fail 의 메시지가 나간다(둘 다 불량이면 앞 것).
    expectEvalParity({ combinator: "all", conditions: [
      { dataType: "number", operator: "equals", rightValue: 1, left: "first" },
      { dataType: "string", operator: "equals", rightValue: 1, left: {} },
    ] });
    // T24:00:00Z 는 JS Date.parse 가 받는 유효 시각(익일 자정) — 양쪽 동일하게 평가.
    expectEvalParity({ combinator: "all", conditions: [
      { dataType: "date_time", operator: "equals", rightValue: "2026-01-02T00:00:00Z", left: "2026-01-01T24:00:00Z" },
    ] });
  });

  it("matches classify-retry-batch decisions across every ineligible reason", () => {
    const policy = { enabled: true, maxRetries: 2, delaySeconds: 30, backoff: "fixed" as const, jitter: false };
    expectBatchParity("2026-11-20T00:00:00.000Z", [
      { id: "control", policy, ...baseFlags, isControlNode: true },
      { id: "unsupported", policy, ...baseFlags, stepTypeSupported: false },
      { id: "off", policySource: { onFailure: "abort_workflow" }, ...baseFlags },
      { id: "zero", policySource: { onFailure: "retry", maxRetries: 0 }, ...baseFlags },
      { id: "status", policy, ...baseFlags, stepRunStatus: "pending" },
      { id: "status-odd", policy, ...baseFlags, stepRunStatus: 9 },
      { id: "qa", policy, ...baseFlags, isQaStep: true, qaRequestChanges: true },
      { id: "recovery", policy, ...baseFlags, recoveryActive: true },
      { id: "exhausted", policy, ...baseFlags, retryCount: 2 },
      { id: "ok", policy, ...baseFlags, metadata: {} },
    ]);
  });

  it("matches the scheduler metadata patch incl. delay, jitter, cap, and base-0", () => {
    const nowIso = "2026-11-20T00:00:00.000Z";
    expectBatchParity(nowIso, [
      { id: "linear-jitter", policySource: { onFailure: "retry", maxRetries: 3, graphRetryDelaySeconds: 30, graphRetryBackoff: "linear", graphRetryJitter: true },
        ...baseFlags, jitterRandom: 0.5, metadata: { toolResult: { x: 1 }, toolInvocation: {}, toolQueue: {}, cacheHit: true, controlFlowSkipped: true, workflowRetryExhaustion: { a: 1 }, keep: "me",
          workflowRetryAttempts: [{ retryNumber: 0, failedAt: "2026-11-19T00:00:00Z", errorSummary: "Bearer abc123token" }] },
        sourceRequestId: "req-1", sourceCompletedAt: "2026-11-19T23:59:59.000Z", errorSummary: "Authorization: Bearer abc" },
      { id: "fixed-j0", policySource: { onFailure: "retry", maxRetries: 2, graphRetryDelaySeconds: 100, graphRetryBackoff: "fixed", graphRetryJitter: true },
        ...baseFlags, jitterRandom: 0.0, retryCount: 1, metadata: {}, sourceRequestId: null, sourceCompletedAt: null, errorSummary: { nested: 1 } },
      { id: "exp-cap", policySource: { onFailure: "retry", maxRetries: 9, graphRetryDelaySeconds: 100000, graphRetryBackoff: "exponential", graphRetryJitter: false },
        ...baseFlags, retryCount: 4, metadata: null, errorSummary: null },
      { id: "base0", policySource: { onFailure: "retry", maxRetries: 5, graphRetryDelaySeconds: 0, graphRetryBackoff: "exponential", graphRetryJitter: true },
        ...baseFlags, jitterRandom: 1.0, metadata: { workflowRetry: { stale: true } }, errorSummary: "sk-1234567890abcdefghij1234" },
      { id: "ready-policy", policy: { enabled: true, maxRetries: 4, delaySeconds: 60, backoff: "linear", jitter: true },
        ...baseFlags, jitterRandom: 1.0, retryCount: 1, metadata: {}, errorSummary: "password=hunter2" },
    ]);
  });
});
