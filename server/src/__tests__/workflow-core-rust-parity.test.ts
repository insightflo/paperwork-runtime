import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  classifyStepActivation,
  findSkippableSteps,
  type PredFacts,
} from "../services/workflow/control-flow/edge-condition.js";
import { hasDisallowedCycle } from "../services/workflow/control-flow/cycle-validator.js";
import { validateDag } from "../services/workflow/dag-validation.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";
import {
  appendRetryAttempt,
  calculateWorkflowRetryDelaySeconds,
  classifyWorkflowStepRetry,
  hasMalformedWorkflowRetry,
  isStepRunAwaitingRetry,
  isWorkflowRetryDue,
  normalizeWorkflowRetryPolicy,
  readWorkflowRetryMetadata,
  sanitizeErrorSummary,
} from "../services/workflow/retry-policy.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

function runRust<T>(subcommand: string, payload: unknown): T {
  const stdout = execFileSync(rustBin, [subcommand], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return JSON.parse(stdout) as T;
}

beforeAll(() => {
  const cargoBin = process.env.CARGO || "cargo";
  execFileSync(
    cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" },
  );
}, 120_000);

describe("paperclip-workflow-core Rust parity (retry-policy & retry-metadata)", () => {
  it("matches normalizeWorkflowRetryPolicy across edge cases", () => {
    const cases = [
      { onFailure: "retry" },
      { onFailure: "retry", maxRetries: 0 },
      { onFailure: "retry", maxRetries: "3" as unknown as number },
      { onFailure: "abort_workflow", maxRetries: 3 },
      { onFailure: "retry", graphRetryBackoff: "Exponential", graphRetryDelaySeconds: 3.9, graphRetryJitter: true },
      { onFailure: "retry", graphRetryBackoff: "aggressive", graphRetryDelaySeconds: -5 },
    ];
    for (const c of cases) {
      expect(runRust("normalize-policy", c)).toEqual(normalizeWorkflowRetryPolicy(c));
    }
  });

  it("matches calculateWorkflowRetryDelaySeconds and classifyWorkflowStepRetry", () => {
    const delayCases = [
      { delaySeconds: 10, backoff: "fixed" as const, jitter: false, retryNumber: 3, randomSample: 0.5 },
      { delaySeconds: 10, backoff: "linear" as const, jitter: false, retryNumber: 3, randomSample: 0.5 },
      { delaySeconds: 10, backoff: "exponential" as const, jitter: false, retryNumber: 4, randomSample: 0.5 },
      { delaySeconds: 0, backoff: "exponential" as const, jitter: true, retryNumber: 5, randomSample: 0.9 },
      { delaySeconds: 100, backoff: "fixed" as const, jitter: true, retryNumber: 1, randomSample: 0.0 },
      { delaySeconds: 100, backoff: "fixed" as const, jitter: true, retryNumber: 1, randomSample: 1.0 },
      { delaySeconds: 200_000, backoff: "linear" as const, jitter: false, retryNumber: 1, randomSample: 0.5 },
      { delaySeconds: 1e18, backoff: "exponential" as const, jitter: false, retryNumber: 2000, randomSample: 0.5 },
    ];
    for (const c of delayCases) {
      const ts = calculateWorkflowRetryDelaySeconds(c, c.retryNumber, () => c.randomSample);
      expect(runRust<{ delaySeconds: number }>("calculate-delay", c).delaySeconds).toBe(ts);
    }

    const basePolicy = { enabled: true, maxRetries: 2, delaySeconds: 30, backoff: "linear" as const, jitter: false };
    const classCases = [
      { policy: basePolicy, stepRunStatus: "failed", retryCount: 0, isControlNode: false, stepTypeSupported: true, isQaStep: false, qaRequestChanges: false, recoveryActive: false },
      { policy: basePolicy, stepRunStatus: "failed", retryCount: 2, isControlNode: false, stepTypeSupported: true, isQaStep: false, qaRequestChanges: false, recoveryActive: false },
      { policy: basePolicy, stepRunStatus: "failed", retryCount: 0, isControlNode: true, stepTypeSupported: true, isQaStep: false, qaRequestChanges: false, recoveryActive: false },
      { policy: basePolicy, stepRunStatus: "failed", retryCount: 0, isControlNode: false, stepTypeSupported: true, isQaStep: true, qaRequestChanges: true, recoveryActive: false },
      { policy: basePolicy, stepRunStatus: "pending", retryCount: 0, isControlNode: false, stepTypeSupported: true, isQaStep: false, qaRequestChanges: false, recoveryActive: false },
    ];
    for (const c of classCases) {
      expect(runRust("classify-retry", { ...c, randomSample: 0.5 })).toEqual(
        classifyWorkflowStepRetry(c, () => 0.5),
      );
    }
  });

  it("matches sanitizeErrorSummary, appendRetryAttempt, and retry metadata predicates", () => {
    const errors = [
      '{"apiKey":"secret"}',
      "Authorization: Bearer abc123token failed",
      "éBearer secret123",
      "error with sk-1234567890abcdefghij1234",
      "password=hunter2\nline2",
      {},
      [],
      [1, 2],
      "   ",
    ];
    for (const value of errors) {
      expect(runRust<{ summary: string | null }>("sanitize-error", { value }).summary).toBe(
        sanitizeErrorSummary(value),
      );
    }

    const history = [{ retryNumber: 0, failedAt: "2026-11-20T00:00:00.000Z", errorSummary: "err 1" }, { bad: true }];
    const attempt = { retryNumber: 1, failedAt: "2026-11-20T00:01:00.000Z", errorSummary: "Bearer secretToken" };
    expect(runRust("append-attempt", { history, attempt })).toEqual(appendRetryAttempt(history, attempt));

    const validRetry = {
      state: "waiting",
      retryNumber: 1,
      maxRetries: 2,
      nextEligibleAt: "2026-11-20T01:00:00.000Z",
      sourceRequestId: "req-1",
    };
    const nowIso = "2026-11-20T01:00:00.000Z";
    expect(runRust("read-metadata", { metadata: validRetry })).toEqual(readWorkflowRetryMetadata(validRetry));
    expect(runRust("is-due", { metadata: validRetry, nowIso })).toEqual({
      due: isWorkflowRetryDue(validRetry, new Date(nowIso)),
      awaiting: isStepRunAwaitingRetry(validRetry),
      malformed: hasMalformedWorkflowRetry(validRetry),
    });
    const wrapped = { workflowRetry: validRetry };
    expect(runRust("is-due", { metadata: wrapped, nowIso })).toEqual({
      due: isWorkflowRetryDue(wrapped, new Date(nowIso)),
      awaiting: isStepRunAwaitingRetry(wrapped),
      malformed: hasMalformedWorkflowRetry(wrapped),
    });

    for (const badTs of ["292471209-01-01T00:00:00Z", "10000-01-01T00:00:00Z", "2026-1-1T0:0:0Z"]) {
      const m = { workflowRetry: { ...validRetry, nextEligibleAt: badTs } };
      expect(runRust("is-due", { metadata: m, nowIso })).toEqual({
        due: isWorkflowRetryDue(m, new Date(nowIso)),
        awaiting: isStepRunAwaitingRetry(m),
        malformed: hasMalformedWorkflowRetry(m),
      });
    }
    for (const okTs of ["2026-11-20T09:00:00+09:00", "2026-11-20"]) {
      const m = { workflowRetry: { ...validRetry, nextEligibleAt: okTs } };
      expect(runRust("is-due", { metadata: m, nowIso })).toEqual({
        due: isWorkflowRetryDue(m, new Date(nowIso)),
        awaiting: isStepRunAwaitingRetry(m),
        malformed: hasMalformedWorkflowRetry(m),
      });
    }
  });

  it("matches validateDag, hasDisallowedCycle, classifyStepActivation, and findSkippableSteps", () => {
    const validDag: WorkflowStep[] = [
      { id: "a", title: "A", type: "agent", dependencies: [] },
      {
        id: "qa",
        title: "QA",
        type: "agent",
        dependencies: ["a"],
        conditionalDependencies: [{ stepId: "a", when: "success" }],
      },
      {
        id: "loop",
        title: "Loop",
        type: "agent",
        dependencies: [],
        conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
      },
    ];
    expect(runRust("validate-dag", { steps: validDag })).toEqual(validateDag(validDag));
    expect(runRust<{ hasCycle: boolean }>("has-disallowed-cycle", { steps: validDag }).hasCycle).toBe(
      hasDisallowedCycle(validDag),
    );

    const cyclicDag: WorkflowStep[] = [
      { id: "x", title: "X", type: "agent", dependencies: ["y"] },
      { id: "y", title: "Y", type: "agent", dependencies: ["x"] },
    ];
    expect(runRust("validate-dag", { steps: cyclicDag })).toEqual(validateDag(cyclicDag));
    expect(runRust<{ hasCycle: boolean }>("has-disallowed-cycle", { steps: cyclicDag }).hasCycle).toBe(
      hasDisallowedCycle(cyclicDag),
    );

    const preds: Record<string, PredFacts> = {
      a: { status: "failed", isQaGate: false, verdict: null, failureRecoveryChannel: "closed" },
    };
    const predsMap = new Map(Object.entries(preds));
    const stepOnSuccess = { id: "s1", dependencies: ["a"] };
    const stepOnFailure = { id: "s2", dependencies: [], conditionalDependencies: [{ stepId: "a", when: "failure" as const }] };
    expect(runRust("classify-activation", { step: stepOnSuccess, preds })).toEqual(
      classifyStepActivation(stepOnSuccess, predsMap),
    );
    expect(runRust("classify-activation", { step: stepOnFailure, preds })).toEqual(
      classifyStepActivation(stepOnFailure, predsMap),
    );
    expect(runRust<{ stepIds: string[] }>("find-skippable", { steps: [stepOnSuccess, stepOnFailure], preds }).stepIds).toEqual(
      findSkippableSteps([stepOnSuccess, stepOnFailure], predsMap).map((s) => s.id),
    );

    // find-skippable launchedStepIds limiting
    for (const launched of [undefined, ["s1"], ["s1", "s2"]] as const) {
      const payload = { steps: [stepOnSuccess, stepOnFailure], preds, launchedStepIds: launched ? [...launched] : undefined };
      expect(runRust<{ stepIds: string[] }>("find-skippable", payload).stepIds).toEqual(
        findSkippableSteps([stepOnSuccess, stepOnFailure], predsMap, launched ? { launchedStepIds: new Set(launched) } : {}).map((s) => s.id),
      );
    }
  });

  it("matches classifyStepActivation on waiting, B2 recovery channel, and every when kind", () => {
    type Step = Parameters<typeof classifyStepActivation>[0];
    // [stepOverride, preds] — waiting(non-terminal/absent) → B2 dispatchReady gate →
    //   qa_request_changes verdict lattice → condition_true/false → back-edge forward-gate
    //   exclusion → non-string stepId/when/deps + non-object pred → hard-required success vs always.
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ dependencies: ["a"] }, { a: { status: "running" } }],
      [{ dependencies: ["a", "b"] }, { a: { status: "completed" } }],
      [{ dependencies: ["a"] }, { a: { status: "failed", dispatchReady: false, failureRecoveryChannel: "closed" } }],
      [{ dependencies: ["a"] }, { a: { status: "failed", dispatchReady: false, failureRecoveryChannel: "open" } }],
      [{ dependencies: ["a"] }, { a: { status: "failed", dispatchReady: false } }],
      [{ dependencies: ["a"] }, { a: { status: "completed", dispatchReady: false } }],
      [{ dependencies: ["a"] }, { a: { status: "failed", dispatchReady: true, failureRecoveryChannel: "closed" } }],
      [{ conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes" }] }, { qa: { status: "failed", isQaGate: true, verdict: "request_changes" } }],
      [{ conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes" }] }, { qa: { status: "failed", isQaGate: true, verdict: "pass" } }],
      [{ conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes" }] }, { qa: { status: "failed", isQaGate: true, verdict: null, verdictChecked: true } }],
      [{ conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes" }] }, { qa: { status: "failed", isQaGate: true, verdict: null } }],
      [{ conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes" }] }, { qa: { status: "failed", isQaGate: false, verdict: null } }],
      [{ conditionalDependencies: [{ stepId: "if1", when: "condition_true" }] }, { if1: { status: "completed", controlOutcome: "condition_true" } }],
      [{ conditionalDependencies: [{ stepId: "if1", when: "condition_false" }] }, { if1: { status: "completed", controlOutcome: "condition_true" } }],
      [{ conditionalDependencies: [{ stepId: "if1", when: "condition_true" }] }, { if1: { status: "failed", controlOutcome: "condition_true" } }],
      [{ conditionalDependencies: [{ stepId: "a", when: "qa_request_changes", isBackEdge: true, maxIterations: 3 }] }, { a: { status: "pending" } }],
      [{ conditionalDependencies: [{ stepId: "a", isBackEdge: true }] }, {}],
      [{ dependencies: ["a", 5], conditionalDependencies: [{ stepId: 7 }, { stepId: "a", when: 9 }] }, { a: { status: "completed" } }],
      [{ dependencies: ["a", "b", "c"] }, { a: 9, b: { status: 7 }, c: { status: "completed", dispatchReady: "no" } }],
      [{ dependencies: ["a"], conditionalDependencies: [{ stepId: "b", when: "always" }] }, { a: { status: "failed" }, b: { status: "skipped" } }],
      [{ dependencies: ["a"], conditionalDependencies: [{ stepId: "b", when: "always" }] }, { a: { status: "completed" }, b: { status: "skipped" } }],
    ];
    for (const [over, preds] of cases) {
      const step = { id: "s", ...over } as Step;
      expect(runRust("classify-activation", { step, preds })).toEqual(
        classifyStepActivation(step, new Map(Object.entries(preds as Record<string, PredFacts>))),
      );
    }
  });

  it("matches validateDag/hasDisallowedCycle on orphans, duplicates, reachability, and back-edge gates", () => {
    const p = (cond?: object) => ({ id: "p", dependencies: [], conditionalDependencies: cond ? [cond] : [] });
    const dags = [
      [{ id: "a", dependencies: [] }, { id: "b", dependencies: ["a"] }], // unreachable warning
      [{ id: "a", dependencies: ["ghost"] }, { id: "b", dependencies: [], conditionalDependencies: [{ stepId: "nope", when: "failure" }] }], // orphan dep + stepId
      [{ id: "a", dependencies: [] }, { id: "a", dependencies: [] }], // duplicate IDs
      [p({ stepId: "q", when: "qa_request_changes", isBackEdge: true, maxIterations: 3 }), { id: "q", dependencies: ["p"] }], // bounded loop 허용
      [p({ stepId: "q", when: "qa_request_changes", isBackEdge: true, maxIterations: 0 }), { id: "q", dependencies: ["p"] }], // maxIterations<1 → cycle 거부
      [p({ stepId: "q", when: "qa_request_changes", isBackEdge: true }), { id: "q", dependencies: ["p"] }], // maxIterations absent → cycle 거부
      [{ id: "a", dependencies: [] }, { id: "b", dependencies: [5, "a"], conditionalDependencies: [{ stepId: 9 }] }], // non-string dep/stepId
    ] as unknown as WorkflowStep[][];
    for (const steps of dags) {
      expect(runRust("validate-dag", { steps })).toEqual(validateDag(steps));
      expect(runRust<{ hasCycle: boolean }>("has-disallowed-cycle", { steps }).hasCycle).toBe(hasDisallowedCycle(steps));
    }
  });

  it("matches control-node validation errors for malformed IF/Complete steps", () => {
    const group = { combinator: "all", conditions: [
      { source: { kind: "work_product_json", stepId: "a", path: "$.score", title: "s" }, dataType: "number", operator: "greater_than", rightValue: 3 },
    ] };
    const a = { id: "a", dependencies: [] };
    const dags = [
      [a, { id: "if1", type: "if", dependencies: ["a"] }], // no conditionGroup, no outputs
      [a, { id: "if1", type: "if", dependencies: ["a"], conditionGroup: group },
        { id: "t1", dependencies: [], conditionalDependencies: [{ stepId: "if1", when: "condition_true" }] },
        { id: "f1", dependencies: ["if1"] }], // missing false output + legacy dependent
      [a, { id: "t1", dependencies: [], conditionalDependencies: [{ stepId: "a", when: "condition_true" }] }], // non-IF condition pred
      [a, { id: "done", type: "complete", dependencies: [] }], // Complete: 0 incoming
      [a, { id: "done", type: "complete", dependencies: [], conditionalDependencies: [{ stepId: "a", when: "condition_true" }, { stepId: "a", when: "condition_false" }] }], // 2 incoming
      [a, { id: "done", type: "complete", dependencies: ["a"] }], // legacy-only incoming
      [a, { id: "if1", type: "if", dependencies: ["a"], conditionGroup: group, agentId: "bot" },
        { id: "done", type: "complete", dependencies: [], conditionalDependencies: [{ stepId: "if1", when: "condition_true", isBackEdge: true, maxIterations: 2 }] }], // back-edges + agent
    ] as unknown as WorkflowStep[][];
    for (const steps of dags) {
      expect(runRust("validate-dag", { steps })).toEqual(validateDag(steps));
    }
  });
});
