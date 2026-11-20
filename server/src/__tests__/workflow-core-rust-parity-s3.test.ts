import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  classifyStepActivation,
  findSkippableSteps,
  type PredFacts,
} from "../services/workflow/control-flow/edge-condition.js";
import { buildPredFactsMap, findRunnableSteps } from "../services/workflow/dag-readiness-facts.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";
import { renderWorkflowToolStepArgsWithResolvedValues } from "../services/workflow/tool-step-template-render.js";

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

afterEach(() => {
  vi.useRealTimers();
});

type Step = Record<string, unknown>;
type StepRunMap = Parameters<typeof findRunnableSteps>[1];

const NOW = "2026-11-20T12:00:00.000Z";
const PAST = "2000-01-01T00:00:00Z";
const FUTURE = "9999-01-01T00:00:00Z";

/**
 * findRunnableSteps 는 내부에서 new Date() 를 두 번 찍는다 — Rust nowIso 와 같은 순간으로
 * 고정해 grace-wait `<=` 경계와 retry-due 판정이 양쪽에서 동일하게 평가되게 한다.
 * preds 는 buildPredFactsMap 산출물을 그대로 Rust 에 공급한다(TS 게이트와 동일 사실망).
 */
function runnableBoth(input: {
  steps: Step[];
  stepRuns: Record<string, unknown>;
  launchedStepIds?: string[];
}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const steps = input.steps as unknown as WorkflowStep[];
  const stepRunMap = new Map(Object.entries(input.stepRuns)) as unknown as StepRunMap;
  const tsIds = findRunnableSteps(steps, stepRunMap, {
    launchedStepIds: input.launchedStepIds ? new Set(input.launchedStepIds) : undefined,
  }).map((s) => s.id);
  const preds = Object.fromEntries(buildPredFactsMap(steps, stepRunMap));
  const rust = runRust<{ stepIds: string[] }>("runnable-steps", {
    steps: input.steps,
    preds,
    stepRuns: input.stepRuns,
    options: { launchedStepIds: input.launchedStepIds, nowIso: NOW },
  });
  expect(rust.stepIds).toEqual(tsIds);
  return rust.stepIds;
}

function tsRender(input: {
  args: unknown;
  runDate: string;
  pathsByStepId?: Record<string, string>;
  runMetadata?: Record<string, unknown>;
}) {
  return renderWorkflowToolStepArgsWithResolvedValues({
    args: input.args,
    runDate: input.runDate,
    runId: "run-1",
    pathsByStepId: new Map(Object.entries(input.pathsByStepId ?? {})),
    runMetadata: input.runMetadata ?? {},
  });
}

function rustRender(input: {
  args: unknown;
  runDate: string;
  pathsByStepId?: Record<string, string>;
  runMetadata?: Record<string, unknown>;
}) {
  return runRust<{ args?: unknown; error?: { code: string; token: string; message: string } }>(
    "render-tool-args",
    {
      args: input.args,
      runDate: input.runDate,
      runId: "run-1",
      pathsByStepId: input.pathsByStepId ?? {},
      runMetadata: input.runMetadata ?? {},
      separator: path.sep,
    },
  );
}

describe("paperclip-workflow-core Rust parity (Stage 3: readiness & render)", () => {
  it("matches findRunnableSteps across the launch/readiness filter pipeline", () => {
    const steps: Step[] = [
      { id: "a", type: "agent", dependencies: [] },
      { id: "b", type: "agent", dependencies: ["a"] },
      { id: "c", type: "if", dependencies: [] },
      { id: "d", type: "if", dependencies: [] },
      { id: "e", type: "agent", dependencies: [] },
      { id: "f", type: "agent", dependencies: [] },
      { id: "g", type: "agent", dependencies: [], workProductSelectors: { a: {} } },
      { id: "h", type: "agent", dependencies: [], workProductSelectors: "ab" },
      { id: "i", type: "agent", dependencies: ["ghost"] },
      { id: "j", type: "agent", dependencies: [], triggerOn: "escalation" },
      { id: "k", type: "agent", dependencies: [] },
    ];
    const grace = (nextEvaluateAt: string) => ({
      controlNodeGraceWait: { since: "2026-11-20T11:00:00Z", nextEvaluateAt },
    });
    const retry = (nextEligibleAt: string) => ({
      workflowRetry: { state: "waiting", retryNumber: 1, maxRetries: 2, nextEligibleAt },
    });
    const stepRuns = {
      a: { status: "completed" },
      b: { status: "pending" },
      // grace `<=` 경계: nextEvaluateAt == now 면 release pass 자신도 차단.
      c: { status: "pending", issueId: null, metadata: grace(NOW) },
      d: { status: "pending", issueId: null, metadata: grace("2026-11-20T11:59:59.999Z") },
      e: { status: "pending", metadata: retry(PAST) },
      f: { status: "pending", metadata: retry(FUTURE) },
      g: { status: "pending" },
      h: { status: "pending" },
      i: { status: "pending" },
      j: { status: "pending" },
      k: { status: "running" },
    };
    expect(runnableBoth({ steps, stepRuns })).toEqual(["b", "d", "e", "g"]);
    expect(runnableBoth({ steps, stepRuns, launchedStepIds: ["b", "c", "d", "h"] })).toEqual(["b", "d"]);
  });

  it("skips grace-wait for issue-carrying IF runs and blocks malformed retries fail-closed", () => {
    const steps: Step[] = [
      { id: "a", dependencies: [] },
      { id: "c", type: "if", dependencies: [] },
      { id: "x", type: "agent", dependencies: ["a"] },
      { id: "m", type: "agent", dependencies: [] },
    ];
    const stepRuns = {
      a: { status: "completed" },
      // issueId != null → grace 미적용 대상 — nextEvaluateAt 미래여도 발화한다.
      c: { status: "pending", issueId: "i9", metadata: { controlNodeGraceWait: { since: PAST, nextEvaluateAt: FUTURE } } },
      x: { status: "pending" },
      // workflowRetry 가 truthy 하지만 필수 필드 결손 → due=false → dispatch 차단.
      m: { status: "pending", metadata: { workflowRetry: { state: "waiting" } } },
    };
    expect(runnableBoth({ steps, stepRuns })).toEqual(["c", "x"]);
  });

  it("matches findSkippableSteps option filters and activate batch output", () => {
    const steps: Step[] = [
      { id: "s1", dependencies: ["a"] },
      { id: "s2", dependencies: ["b"] },
      { id: "s3", dependencies: [], conditionalDependencies: [{ stepId: "a", when: "failure" }] },
      { id: "s4", dependencies: ["c"] },
      { id: "s5", dependencies: [], conditionalDependencies: [{ stepId: "a", when: "always" }] },
    ];
    const preds: Record<string, PredFacts> = {
      a: { status: "failed", isQaGate: false, verdict: null },
      b: { status: "completed", isQaGate: false, verdict: null },
      c: { status: "pending", isQaGate: false, verdict: null },
    };
    const predsMap = new Map(Object.entries(preds));
    const typed = steps as unknown as WorkflowStep[];
    const combos: Array<{ launchedStepIds?: string[]; eligibleStepIds?: string[] }> = [
      {},
      { launchedStepIds: ["s1", "s4"] },
      { eligibleStepIds: ["s4"] },
      { launchedStepIds: ["s1", "s2", "s4"], eligibleStepIds: ["s1", "s4"] },
    ];
    for (const options of combos) {
      const eligible = options.eligibleStepIds ? new Set(options.eligibleStepIds) : undefined;
      const tsIds = findSkippableSteps(typed, predsMap, {
        launchedStepIds: options.launchedStepIds ? new Set(options.launchedStepIds) : undefined,
        isStepEligible: eligible ? (step) => eligible.has(step.id) : undefined,
      }).map((s) => s.id);
      expect(runRust<{ stepIds: string[] }>("skippable-steps", { steps, preds, options }).stepIds).toEqual(tsIds);
    }
    expect(runRust<{ stepIds: string[] }>("skippable-steps", { steps, preds, options: {} }).stepIds).toEqual(["s1"]);

    const rust = runRust<{ activations: unknown[] }>("activate", { steps, preds });
    expect(rust.activations).toEqual(
      steps.map((step) => ({ stepId: step.id, ...classifyStepActivation(step as WorkflowStep, predsMap) })),
    );
    expect(rust.activations).toEqual([
      { stepId: "s1", runnable: false, skippable: true, waiting: false },
      { stepId: "s2", runnable: true, skippable: false, waiting: false },
      { stepId: "s3", runnable: true, skippable: false, waiting: false },
      { stepId: "s4", runnable: false, skippable: false, waiting: true },
      { stepId: "s5", runnable: true, skippable: false, waiting: false },
    ]);
  });

  it("matches the render token chain incl. step paths and metadata serialization", () => {
    const input = {
      args: [
        "{$runDate}|{$date}|{$workflowRunId}|{$runMonth}",
        "{$steps.s1.workProductPath}|{$steps.s1.workProductDir}|{$steps.s1.siblingAssetsDir}|{$steps.x.workProductPath}",
        "{$runMetadata.s}|{$runMetadata.n}|{$runMetadata.o}|{$runMetadata.missing}|{$childInputs.c}",
      ],
      runDate: "2026-11-20",
      pathsByStepId: { s1: path.join("w", "out", "f.json") },
      runMetadata: { s: "txt", n: 1.5, o: { b: 1, a: 2 }, workflowChildInputs: { c: "v" } },
    };
    const ts = tsRender(input);
    expect(rustRender(input).args).toEqual(ts);
    expect(ts).toEqual([
      "2026-11-20|2026-11-20|run-1|202611",
      `${path.join("w", "out", "f.json")}|${path.join("w", "out")}|${path.join("w", "out", "assets")}|{$steps.x.workProductPath}`,
      'txt|1.5|{"b":1,"a":2}|{$runMetadata.missing}|v',
    ]);
  });

  it("keeps the {$runMonth} literal when runDate fails the YYYY-MM prefix check", () => {
    for (const runDate of ["not-a-date", "", "2026-13-01", "2026-09"]) {
      const input = { args: "{$runMonth}", runDate };
      expect(rustRender(input).args).toEqual(tsRender(input));
    }
    expect(tsRender({ args: "{$runMonth}", runDate: "not-a-date" })).toBe("{$runMonth}");
    expect(tsRender({ args: "{$runMonth}", runDate: "2026-13-01" })).toBe("202613"); // 월 범위 검사 없음.
  });

  it("strips bash $-residue identically through the render pipeline", () => {
    const input = {
      args: { a: "$/srv/x", b: "$'/y'", c: "$$", d: "$HOME", nested: ["$/p", { deep: "$'/q'" }] },
      runDate: "d",
    };
    expect(rustRender(input).args).toEqual(tsRender(input));
    expect(tsRender(input)).toEqual({
      a: "/srv/x", b: "'/y'", c: "$$", d: "$HOME", nested: ["/p", { deep: "'/q'" }],
    });
  });

  it("fails closed with the identical unresolved {$childInputs} error contract", () => {
    const cases = [
      { args: "{$childInputs.bad-key}", runMetadata: { workflowChildInputs: { a: 1 } } },
      { args: "{$childInputs.absent}", runMetadata: { workflowChildInputs: { a: 1 } } },
      { args: "{$childInputs.c}", runMetadata: {} },
      { args: ["ok", "{$childInputs.x}"], runMetadata: { workflowChildInputs: [1] } },
    ];
    for (const partial of cases) {
      const input = { runDate: "d", ...partial };
      const rust = rustRender(input);
      expect(rust.error?.code).toBe("unresolved_child_inputs");
      expect(() => tsRender(input)).toThrowError(rust.error!.message);
    }
    const rust = rustRender({
      args: "{$childInputs.bad-key}",
      runDate: "d",
      runMetadata: { workflowChildInputs: { a: 1 } },
    });
    expect(rust.error?.token).toBe("{$childInputs.bad-key}");
    expect(rust.error?.message).toBe(
      "Unresolved {$childInputs} token in tool args: {$childInputs.bad-key}"
      + " (child input keys must be declared on the parent workflow step inputs)",
    );
  });

  it("passes non-string args through untouched and keeps null args as null", () => {
    const input = {
      args: { n: 42, f: 1.5, flag: true, none: null, list: [1, "x{$runDate}"] },
      runDate: "2026-11-20",
    };
    expect(rustRender(input).args).toEqual(tsRender(input));
    const nullInput = { args: null, runDate: "d" };
    expect(rustRender(nullInput).args).toEqual(tsRender(nullInput));
  });
});
