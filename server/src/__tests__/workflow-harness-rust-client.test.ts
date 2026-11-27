import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowCoreContractError, WorkflowCoreUnavailableError } from "../services/workflow/workflow-core-client.js";
import { runInsideDbTransaction } from "../services/workflow/workflow-core-tx-guard.js";
import {
  applyStepAttribution,
  assertAdvisorCheckpointAllowsProgress,
  evaluateDispatchRoute,
  HARNESS_SUBCOMMANDS,
  requiredAdvisorGate,
  validateAdvisorCheckpoint,
  WorkflowHarnessAdvisorBlockedError,
  type HarnessAdvisorCheckpointRejectionReason,
  type HarnessSuccessRatePrior,
  type HarnessStepVerdictAttribution,
} from "../services/workflow/workflow-harness-rust-client.js";
import {
  createCannedBinDir,
  findCargoBin,
  findWorkflowCoreBinary,
  resolveOrBuildWorkflowCoreBinary,
  type CannedBinDir,
} from "./helpers/workflow-harness-rust-fixture.js";

/**
 * [목적] workflow-harness-rust-client 의 fail-closed 계약과 실 Rust bin 호출을 검증한다.
 *   - 게이트/계약 그룹(canned bin, 항상 실행): bin 미설정·WORKFLOW_CORE_RUST=0·tx 안 → 스폰 없이 거절,
 *     비JSON·shape 불일치·Rust 불변 위반 응답(allowsProgress⇔pass, 강제승격⇔forcedReason, 미기록⇔가중0)
 *     → ContractError, 무효 체크포인트 → allowsProgress:false + Blocked.
 *   - live bin 그룹: cargo 사전 빌드 후 harness_gate 단위 테스트와 같은 기대값(γ=0.92, M0=6, θ=0.70, w=2.0)으로
 *     4개 서브커맨드를 두드린다. bin·cargo 부재 시 skip.
 */

const cargoBin = findCargoBin();
const canRunRustParity = findWorkflowCoreBinary() !== null || cargoBin !== null;
let rustBin = "";

const ROUTE_INPUT = { successProbability: 0.94, riskLevel: "low", consecutiveErrors: 0 } as const;
const GATE_INPUT = { planPendingApproval: false, consecutiveErrors: 0, verifierPassed: false } as const;
const PASS_CP = { schemaVersion: 1, runId: "run-1", gate: "g3_pre_closeout", verdict: { decision: "pass" } };
const PASS_DOC = { schemaVersion: 1, runId: "run-1", gate: "g3_pre_closeout", decision: "pass" };
const CHALLENGE_CP = { schemaVersion: 1, runId: "run-1", gate: "g2_second_error", verdict: { decision: "challenge", reason: "P0" } };
const PRIOR: HarnessSuccessRatePrior = { ewmaSuccess: 0, ewmaFail: 0, rawSamples: 0, consecutiveErrors: 0 };
const ATTR: HarnessStepVerdictAttribution = { runId: "run-1", stepRunId: "step-1", outcome: "ok", verdictPass: null, stallDetected: false, durationMs: 1_234 };

/** [서브커맨드, 브리지 호출] — 같은 canned 응답을 4개 서브커맨드에 먹인다. */
const CALLS: [string, () => Promise<unknown>][] = [
  ["evaluate-dispatch-route", () => evaluateDispatchRoute({ ...ROUTE_INPUT })],
  ["advisor-required-gate", () => requiredAdvisorGate({ ...GATE_INPUT })],
  ["advisor-checkpoint", () => validateAdvisorCheckpoint({ ...PASS_DOC })],
  ["apply-step-attribution", () => applyStepAttribution(PRIOR, ATTR)],
];

let fx: CannedBinDir;
const unavailable = (message: string) => ({ name: "WorkflowCoreUnavailableError", message: expect.stringContaining(message) });
const contract = (reason: string) => ({ name: "WorkflowCoreContractError", message: expect.stringContaining(reason) });

beforeAll(async () => {
  fx = await createCannedBinDir("wf-harness-");
}, 30_000);

afterAll(async () => {
  await fx.cleanup();
});

beforeEach(() => {
  vi.stubEnv("WORKFLOW_CORE_RUST", ""); // 게이트 열림
  vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", fx.cannedBin);
  vi.stubEnv("WF_HARNESS_SPAWN_COUNT", fx.countFile);
  vi.stubEnv("WF_HARNESS_CANNED", "{}");
});

afterEach(() => vi.unstubAllEnvs());

describe("workflow-harness-rust-client: fail-closed gates (no Node fallback)", () => {
  // [케이스, env 변경] — 게이트가 닫히면 어떤 진입점도 스폰하지 않고 Unavailable 로 거절한다.
  const closedGates: [string, () => void][] = [
    ["bin unset", () => vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", "")],
    ["WORKFLOW_CORE_RUST=0", () => vi.stubEnv("WORKFLOW_CORE_RUST", "0")],
    ["relative bin path", () => vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", "paperclip-workflow-core")],
  ];
  it.each(closedGates)("%s → every subcommand rejects workflow_core_disabled without spawning", async (_name, close) => {
    close();
    for (const [name, run] of CALLS) await expect(run(), name).rejects.toMatchObject(unavailable("workflow_core_disabled"));
    expect(await fx.spawnCount()).toBe(0);
  });

  it("inside a marked DB transaction → rejects workflow_core_in_transaction without spawning", async () => {
    for (const [name, run] of CALLS) {
      await expect(runInsideDbTransaction(run), name).rejects.toMatchObject(unavailable("workflow_core_in_transaction"));
    }
    expect(await fx.spawnCount()).toBe(0);
  });

  it("missing binary, non-zero exit and non-JSON stdout all reject (never a default value)", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", path.join(fx.dir, "does-not-exist"));
    await expect(CALLS[0][1]()).rejects.toMatchObject(unavailable("workflow_core_spawn_ENOENT"));
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", fx.exitBin);
    await expect(CALLS[0][1]()).rejects.toMatchObject(unavailable("workflow_core_exit_1: boom"));
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", fx.garbageBin);
    for (const [name, run] of CALLS) await expect(run(), name).rejects.toMatchObject(contract("workflow_core_bad_json"));
  });

  it("wrong-shape stdout ({}) → ContractError on all four subcommands", async () => {
    for (const [name, run] of CALLS) await expect(run(), name).rejects.toMatchObject(contract("bad_shape"));
    expect(await fx.spawnCount()).toBe(CALLS.length);
  });

  it("advisor-checkpoint: Rust allowsProgress flag contradicting the verdict/schema is rejected, not trusted", async () => {
    vi.stubEnv("WF_HARNESS_CANNED", JSON.stringify({ valid: true, allowsProgress: true, checkpoint: CHALLENGE_CP }));
    await expect(validateAdvisorCheckpoint(PASS_DOC)).rejects.toMatchObject(contract("workflow_core_advisor_checkpoint_bad_shape"));
    await expect(assertAdvisorCheckpointAllowsProgress(PASS_DOC)).rejects.toBeInstanceOf(WorkflowCoreContractError);
    for (const bad of [
      { valid: false, allowsProgress: true, error: "missing_run_id" },
      { valid: true, allowsProgress: true, checkpoint: { schemaVersion: 2 } },
      { valid: true, allowsProgress: true, checkpoint: { ...PASS_DOC, verdict: { decision: "pass", reason: "x" } } },
      { valid: true, allowsProgress: true, checkpoint: { ...PASS_DOC, gate: "g9", verdict: { decision: "pass" } } },
      { valid: true, allowsProgress: "true", checkpoint: { ...PASS_DOC, verdict: { decision: "pass" } } },
    ]) {
      vi.stubEnv("WF_HARNESS_CANNED", JSON.stringify(bad));
      await expect(validateAdvisorCheckpoint(PASS_DOC), JSON.stringify(bad)).rejects.toMatchObject(contract("bad_shape"));
    }
  });

  it("advisor-checkpoint: invalid document (valid:false) passes through as blocked with its reason code", async () => {
    vi.stubEnv("WF_HARNESS_CANNED", JSON.stringify({ valid: false, allowsProgress: false, error: "unsupported_schema_version" }));
    expect(await validateAdvisorCheckpoint({ ...PASS_DOC, schemaVersion: 2 })).toEqual({
      valid: false, allowsProgress: false, error: "unsupported_schema_version",
    });
    await expect(assertAdvisorCheckpointAllowsProgress({ ...PASS_DOC, schemaVersion: 2 })).rejects.toMatchObject({
      reason: "unsupported_schema_version", checkpoint: null,
    });
    await expect(assertAdvisorCheckpointAllowsProgress({ ...PASS_DOC, schemaVersion: 2 })).rejects.toBeInstanceOf(WorkflowHarnessAdvisorBlockedError);
  });

  it("advisor-checkpoint: valid challenge is valid but blocked; pass passes the assert helper", async () => {
    vi.stubEnv("WF_HARNESS_CANNED", JSON.stringify({ valid: true, allowsProgress: false, checkpoint: CHALLENGE_CP }));
    expect(await validateAdvisorCheckpoint(PASS_DOC)).toMatchObject({ valid: true, allowsProgress: false });
    await expect(assertAdvisorCheckpointAllowsProgress(PASS_DOC)).rejects.toMatchObject({
      name: "WorkflowHarnessAdvisorBlockedError", reason: "P0", checkpoint: { runId: "run-1" },
    });
    vi.stubEnv("WF_HARNESS_CANNED", JSON.stringify({ valid: true, allowsProgress: true, checkpoint: PASS_CP }));
    expect(await assertAdvisorCheckpointAllowsProgress(PASS_DOC)).toEqual(PASS_CP);
  });

  it("route/attribution/gate responses violating Rust invariants are rejected", async () => {
    vi.stubEnv("WF_HARNESS_CANNED", JSON.stringify({ route: "escalate_advisor", sharpThreshold: 0.7, forcedReason: null }));
    await expect(CALLS[0][1]()).rejects.toMatchObject(contract("workflow_core_dispatch_route_bad_shape"));
    vi.stubEnv("WF_HARNESS_CANNED", JSON.stringify({ route: "sharp", sharpThreshold: 1.5, forcedReason: null }));
    await expect(CALLS[0][1]()).rejects.toMatchObject(contract("bad_shape"));
    vi.stubEnv("WF_HARNESS_CANNED", JSON.stringify({ gate: "g4" }));
    await expect(CALLS[1][1]()).rejects.toMatchObject(contract("workflow_core_advisor_gate_bad_shape"));
    const update = { runId: "run-1", stepRunId: "step-1", recorded: true, weight: 1, prior: PRIOR };
    vi.stubEnv("WF_HARNESS_CANNED", JSON.stringify({ ...update, kind: "isolated" }));
    await expect(CALLS[3][1]()).rejects.toMatchObject(contract("workflow_core_step_attribution_bad_shape"));
    vi.stubEnv("WF_HARNESS_CANNED", JSON.stringify({ ...update, kind: "success", recorded: false }));
    await expect(CALLS[3][1]()).rejects.toMatchObject(contract("bad_shape"));
  });

  it("exposes exactly the four harness_gate subcommands", () => {
    expect(HARNESS_SUBCOMMANDS).toEqual(["evaluate-dispatch-route", "advisor-required-gate", "advisor-checkpoint", "apply-step-attribution"]);
  });
});

describe.skipIf(!canRunRustParity)("workflow-harness-rust-client: live paperclip-workflow-core (harness_gate)", () => {
  beforeAll(() => {
    rustBin = resolveOrBuildWorkflowCoreBinary(cargoBin);
  }, 180_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
  });

  const route = (p: number, risk: "low" | "medium" | "high", errors: number, sharpThreshold?: number | null) =>
    evaluateDispatchRoute({ successProbability: p, riskLevel: risk, consecutiveErrors: errors, sharpThreshold });
  const prior = (ewmaSuccess: number, ewmaFail: number, rawSamples: number, consecutiveErrors: number): HarnessSuccessRatePrior =>
    ({ ewmaSuccess, ewmaFail, rawSamples, consecutiveErrors });
  const attr = (outcome: string, verdictPass: boolean | null, extra: Partial<HarnessStepVerdictAttribution> = {}): HarnessStepVerdictAttribution =>
    ({ ...ATTR, outcome, verdictPass, ...extra });
  const SHARP_DEFAULT = { route: "sharp", sharpThreshold: 0.7, forcedReason: null };
  const SPLIT_DEFAULT = { route: "split", sharpThreshold: 0.7, forcedReason: null };
  const ESCALATE_DEFAULT = { route: "escalate_advisor", sharpThreshold: 0.7, forcedReason: "consecutive_errors>=2" };

  it("evaluate-dispatch-route: sharp only for low risk at/above θ, second consecutive error forces advisor", async () => {
    expect(await route(0.94, "low", 0)).toEqual(SHARP_DEFAULT);
    expect((await route(0.7, "low", 0)).route).toBe("sharp");
    for (const [p, risk] of [[0.6999, "low"], [1, "medium"], [1, "high"], [0.5, "low"], [1.01, "low"], [-0.01, "low"]] as const) {
      expect(await route(p, risk, 0), `${p}/${risk}`).toEqual(SPLIT_DEFAULT);
    }
    expect((await route(0.9, "low", 1)).route).toBe("sharp");
    for (const [p, risk] of [[1, "low"], [0, "high"], [1.01, "low"]] as const) {
      expect(await route(p, risk, 2), `${p}/${risk}`).toEqual(ESCALATE_DEFAULT);
    }
    expect((await route(1, "low", 3)).route).toBe("escalate_advisor");
  });

  it("evaluate-dispatch-route: dynamic threshold honored, invalid threshold falls back to 0.70", async () => {
    expect(await route(0.94, "low", 0, 0.95)).toEqual({ route: "split", sharpThreshold: 0.95, forcedReason: null });
    expect((await route(0.94, "low", 0, 0.5)).route).toBe("sharp");
    for (const bad of [0, -0.1, 1.5, null, undefined]) {
      expect(await route(0.94, "low", 0, bad), String(bad)).toEqual(SHARP_DEFAULT);
    }
  });

  it("malformed input (bad enum/number/empty stdin) exits 1 → Unavailable, never a decision", async () => {
    await expect(evaluateDispatchRoute({ ...ROUTE_INPUT, riskLevel: "critical" as never })).rejects.toMatchObject(unavailable("workflow_core_exit_1"));
    await expect(evaluateDispatchRoute({ ...ROUTE_INPUT, successProbability: "x" as never })).rejects.toMatchObject(unavailable("workflow_core_exit_1"));
    await expect(evaluateDispatchRoute({ ...ROUTE_INPUT, consecutiveErrors: -1 })).rejects.toMatchObject(unavailable("workflow_core_exit_1"));
    await expect(validateAdvisorCheckpoint(undefined)).rejects.toMatchObject(unavailable("workflow_core_exit_1: EOF"));
    await expect(applyStepAttribution(prior(1, 1, 3, -1), attr("ok", null))).rejects.toMatchObject(unavailable("workflow_core_exit_1"));
    await expect(applyStepAttribution(PRIOR, attr("ok", null, { durationMs: -1 }))).rejects.toMatchObject(unavailable("workflow_core_exit_1"));
  });

  it("advisor-required-gate: G2 > G1 > G3 precedence, none when no trigger, agrees with route escalation", async () => {
    const gate = (planPendingApproval: boolean, consecutiveErrors: number, verifierPassed: boolean) =>
      requiredAdvisorGate({ planPendingApproval, consecutiveErrors, verifierPassed });
    // [planPendingApproval, consecutiveErrors, verifierPassed, expected gate|null] — G2 > G1 > G3
    const cases = [
      [false, 0, false, null], [false, 1, false, null], [true, 0, false, "g1_pre_plan"], [false, 2, false, "g2_second_error"],
      [false, 0, true, "g3_pre_closeout"], [true, 2, true, "g2_second_error"], [false, 2, true, "g2_second_error"], [true, 1, true, "g1_pre_plan"],
    ] as const;
    for (const [plan, errors, verifier, expected] of cases) {
      expect(await gate(plan, errors, verifier), JSON.stringify([plan, errors, verifier])).toBe(expected);
    }
    for (const errors of [0, 1, 2, 5]) {
      const escalated = (await route(1, "low", errors)).route === "escalate_advisor";
      expect(await gate(false, errors, false) === "g2_second_error").toBe(escalated);
    }
  });

  it("advisor-checkpoint: valid pass/challenge documents normalize runId and reason", async () => {
    expect(await validateAdvisorCheckpoint({ ...PASS_DOC, runId: " run-1 " })).toEqual({ valid: true, allowsProgress: true, checkpoint: PASS_CP });
    expect(await validateAdvisorCheckpoint({ ...PASS_DOC, gate: "g2_second_error", decision: "challenge", reason: "  P0  " }))
      .toEqual({ valid: true, allowsProgress: false, checkpoint: CHALLENGE_CP });
    await expect(assertAdvisorCheckpointAllowsProgress({ ...PASS_DOC, decision: "challenge", reason: "P0" }))
      .rejects.toMatchObject({ name: "WorkflowHarnessAdvisorBlockedError", reason: "P0", checkpoint: { runId: "run-1" } });
    expect(await validateAdvisorCheckpoint({ ...PASS_DOC, decision: "challenge", reason: "   " }))
      .toMatchObject({ valid: true, allowsProgress: false, checkpoint: { verdict: { decision: "challenge", reason: "unspecified" } } });
    expect(await assertAdvisorCheckpointAllowsProgress(PASS_DOC)).toEqual(PASS_CP);
  });

  it("advisor-checkpoint: invalid documents fail closed with a reason code and never allow progress", async () => {
    const cases: [unknown, HarnessAdvisorCheckpointRejectionReason][] = [
      [{ schemaVersion: 1, runId: "r", gate: "g2_second_error", decision: "challenge" }, "invalid_advisor_verdict"],
      [{ schemaVersion: 1, runId: "r", gate: "g2_second_error", decision: "challenge", reason: 7 }, "invalid_advisor_verdict"],
      [{ schemaVersion: 1, runId: "r", gate: "g1_pre_plan", decision: "human" }, "invalid_advisor_verdict"],
      [{ schemaVersion: 1, runId: "r", gate: "g1_pre_plan" }, "invalid_advisor_verdict"],
      [{ schemaVersion: 2, runId: "r", gate: "g1_pre_plan", decision: "pass" }, "unsupported_schema_version"],
      [{ runId: "r", gate: "g1_pre_plan", decision: "pass" }, "unsupported_schema_version"],
      [{ schemaVersion: 1, runId: "  ", gate: "g1_pre_plan", decision: "pass" }, "missing_run_id"],
      [{ schemaVersion: 1, gate: "g1_pre_plan", decision: "pass" }, "missing_run_id"],
      [{ schemaVersion: 1, runId: "r", gate: "g9", decision: "pass" }, "unknown_gate"],
      [{ schemaVersion: 1, runId: "r", gate: "G1_PRE_PLAN", decision: "pass" }, "unknown_gate"],
      [{ schemaVersion: 1, runId: "r", decision: "pass" }, "unknown_gate"],
      [{ schemaVersion: 1, runId: "r", gate: "g1_pre_plan", decision: "pass", extra: 1 }, "unrecognized_key"],
      ["pass", "not_an_object"], [null, "not_an_object"], [[], "not_an_object"],
      [["advisor:pass"], "not_an_object"], [7, "not_an_object"],
    ];
    for (const [doc, error] of cases) {
      expect(await validateAdvisorCheckpoint(doc), JSON.stringify(doc)).toEqual({ valid: false, allowsProgress: false, error });
      const blocked = assertAdvisorCheckpointAllowsProgress(doc);
      await expect(blocked).rejects.toBeInstanceOf(WorkflowHarnessAdvisorBlockedError);
      await expect(blocked).rejects.toMatchObject({ reason: error, checkpoint: null });
    }
  });

  it("apply-step-attribution: success/rework/verifier-fail update the EWMA prior with the dgate constants", async () => {
    const ok = await applyStepAttribution(prior(1, 1, 3, 1), attr("ok", null));
    expect(ok).toMatchObject({ runId: "run-1", stepRunId: "step-1", kind: "success", recorded: true, weight: 1, prior: { rawSamples: 4, consecutiveErrors: 0 } });
    expect(ok.prior.ewmaSuccess).toBeCloseTo(1.92, 12);
    expect(ok.prior.ewmaFail).toBeCloseTo(0.92, 12);
    expect(await applyStepAttribution(prior(1, 1, 3, 0), attr("completed", true))).toMatchObject({ kind: "success", weight: 1 });
    expect((await applyStepAttribution(PRIOR, attr(" OK ", null))).kind).toBe("success");
    const rejected = await applyStepAttribution(prior(2, 1, 4, 0), attr("ok", false));
    expect(rejected).toMatchObject({ kind: "failed", recorded: true, weight: 2, prior: { rawSamples: 5, consecutiveErrors: 1 } });
    expect(rejected.prior.ewmaSuccess).toBeCloseTo(1.84, 12);
    expect(rejected.prior.ewmaFail).toBeCloseTo(2.92, 12);
    expect(await applyStepAttribution(PRIOR, attr("fail", false))).toMatchObject({ kind: "failed", weight: 2 });
    expect(await applyStepAttribution(PRIOR, attr("fail", null))).toMatchObject({ kind: "failed", weight: 1 });
    expect(await applyStepAttribution(PRIOR, attr("error", true))).toMatchObject({ kind: "failed", weight: 1 });
    expect(await applyStepAttribution(prior(1, 0, 1, 1), attr("rework", null))).toMatchObject({ kind: "rework", recorded: true, weight: 1, prior: { consecutiveErrors: 2 } });
    const stalled = await applyStepAttribution(prior(1, 0, 1, 0), attr("ok", true, { stallDetected: true }));
    expect(stalled).toMatchObject({ kind: "stalled", recorded: true, weight: 1, prior: { consecutiveErrors: 1 } });
    expect(stalled.prior.ewmaFail).toBeCloseTo(1, 12);
  });

  it("apply-step-attribution: environmental/unrecognized/unbound outcomes are not recorded (prior unchanged)", async () => {
    const before = prior(1, 1, 3, 2);
    const notRecorded = (kind: string) => ({ runId: "run-1", stepRunId: "step-1", kind, recorded: false, weight: 0, prior: before });
    for (const outcome of ["config_error", "interrupted", "rerouted", "skipped"]) {
      expect(await applyStepAttribution(before, attr(outcome, false)), outcome).toEqual(notRecorded("isolated"));
    }
    expect(await applyStepAttribution(before, attr("banana", null))).toEqual(notRecorded("unrecognized"));
    const unbound = await applyStepAttribution(before, attr("ok", null, { runId: " " }));
    expect(unbound).toEqual({ runId: " ", stepRunId: "step-1", kind: "success", recorded: false, weight: 0, prior: before });
    await expect(applyStepAttribution(before, attr("ok", null, { stepRunId: "" })))
      .resolves.toMatchObject({ kind: "success", recorded: false, weight: 0, prior: before });
  });
});
