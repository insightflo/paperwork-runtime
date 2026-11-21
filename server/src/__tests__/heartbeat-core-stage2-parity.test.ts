// Stage 2 differential parity: heartbeat-stability / -run-context /
// -session-reset / -output-validation (TS) vs paperclip-heartbeat-core (Rust).
// TS results are JSON-normalized (NaN->null, undefined keys dropped) so the
// comparison happens on the same wire representation the Rust CLI emits.
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import * as stab from "../services/heartbeat-stability.js";
import * as runctx from "../services/heartbeat-run-context.js";
import * as reset from "../services/heartbeat-session-reset.js";
import * as outval from "../services/heartbeat-output-validation.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/heartbeat-core/target/release/paperclip-heartbeat-core");

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(
    cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/heartbeat-core/Cargo.toml")],
    { stdio: "inherit" },
  );
}, 240_000);

type Outcome = { threw: false; value: unknown } | { threw: true; error: string };
type P = Record<string, any>;
const j = (v: unknown) => JSON.parse(JSON.stringify(v));
const env2 = (e: any) => e as NodeJS.ProcessEnv;
const tsEnv = (p: P) => ({
  qaStepActiveExecutionTimeoutMs: stab.resolveQaStepActiveExecutionTimeoutMs(env2(p.env)),
  runawayLogLimitBytes: stab.resolveRunawayLogLimitBytes(p.adapterConfig as never, env2(p.env)),
  adapterFailedTransientRetryMaxSec: stab.resolveAdapterFailedTransientRetryMaxSec(env2(p.env)),
  noProgressAdvisoryThreshold: stab.resolveNoProgressAdvisoryThreshold(env2(p.env)),
  noProgressAutoBlockThreshold: stab.resolveNoProgressAutoBlockThreshold(env2(p.env)),
  noProgressWindowMs: stab.resolveNoProgressWindowMs(env2(p.env)),
  provider403RetryDelaysMin: stab.resolveProvider403RetryDelaysMin(env2(p.env)),
  provider403ReasonCodes: stab.resolveProvider403LadderReasonCodes(env2(p.env)),
});
const tsCompute = (p: P) => ({
  runawayAdvisorySoftBytes: stab.resolveRunawayAdvisorySoftBytes(p.runawayLogLimitBytes as number),
  stepAwareTimeoutMs: stab.resolveStepAwareActiveExecutionTimeoutMs({
    baseMs: p.baseMs as number,
    contract: p.contract as never,
    qaStepActiveExecutionTimeoutMs: p.qaStepActiveExecutionTimeoutMs as number,
  }),
  stepTimeoutSignals: stab.stepTimeoutSignalsFromStep(p.step as never),
});
const tsRunCtx = (p: P) => ({
  readNonEmptyString: runctx.readNonEmptyString(p.value),
  taskKey: runctx.deriveTaskKey(p.contextSnapshot as never, p.payload as never),
  fallbackAttempt: runctx.resolveAdapterFallbackAttempt(p.contextRaw),
  agentNameKey: runctx.normalizeAgentNameKey(p.agentName as never),
  sameTaskScope: runctx.isSameTaskScope(p.left as never, p.right as never),
});
const tsReset = (p: P) => ({
  hasQaReworkContract: reset.hasWorkflowQaReworkContract(p.contextSnapshot as never),
  shouldReset: reset.shouldResetTaskSessionForWake(p.contextSnapshot as never),
  reason: reset.describeSessionResetReason(p.contextSnapshot as never),
});
const tsOutVal = (p: P) => ({
  gate: outval.canApplyMissingWorkProductRegistrationGate(p.issue as never, p.stepRunRequiresWorkProduct as never),
  stepRequires: outval.resolveStepRunRequiresWorkProduct(p.metadata),
});
// JSON arrays model ReadonlySet<string>/readonly Date[]; non-array values are
// passed through raw so `.has`/`.some` throws exactly like production misuse.
const toSet = (v: any) => (Array.isArray(v) ? new Set(v) : v) as ReadonlySet<string>;
const toDates = (v: any) =>
  (Array.isArray(v) ? v.map((t: any) => new Date(t)) : v) as readonly Date[];
const tsProgress = (p: P) =>
  stab.hasRunProgressEvidence({
    run: p.run as never,
    workProductRunIds: toSet(p.workProductRunIds),
    transitionRunIds: toSet(p.transitionRunIds),
    agentCommentTimestamps: toDates(p.agentCommentTimestamps),
  });

function ts(fn: () => unknown): Outcome {
  try {
    return { threw: false, value: j(fn()) };
  } catch (err) {
    return { threw: true, error: err instanceof Error ? err.message : String(err) };
  }
}
function rustRaw(subcommand: string, stdin: string): Outcome {
  const res = spawnSync(rustBin, [subcommand], { input: stdin, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    return { threw: true, error: String(res.error ?? res.stderr).trim() };
  }
  return { threw: false, value: JSON.parse(String(res.stdout)) };
}
const rust = (subcommand: string, payload: unknown) => rustRaw(subcommand, JSON.stringify(payload));

function expectParity(t: Outcome, r: Outcome): void {
  if (r.threw !== t.threw) {
    throw new Error(`throw parity mismatch: ts=${JSON.stringify(t)} rust=${JSON.stringify(r)}`);
  }
  if (!t.threw && !r.threw) expect(r.value).toEqual(t.value);
}

function cases(sub: string, tsFn: (p: P) => unknown, list: Array<[string, P]>) {
  return () => {
    for (const [name, p] of list) {
      it(`parity: ${name}`, () => {
        expectParity(ts(() => tsFn(p)), rust(sub, p));
      });
    }
  };
}

describe("stability-env: env resolvers + provider-403 knobs", cases("stability-env", tsEnv, [
  ["empty env -> all defaults", { env: {} }],
  ["qa seconds->ms floored", { env: { PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: "900.9" } }],
  ["qa '0' disables", { env: { PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: "0" } }],
  ["qa hex via StringToNumber", { env: { PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: "0x10" } }],
  ["qa FEFF-wrapped parses", { env: { PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: "\uFEFF60\uFEFF" } }],
  ["qa garbage -> default", { env: { PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: " abc " } }],
  ["runaway adapterConfig wins over env", { env: { PAPERCLIP_RUNAWAY_LOG_LIMIT_BYTES: "9" }, adapterConfig: { runawayLogLimitBytes: 5e6 } }],
  ["runaway adapterConfig -3 -> 0", { adapterConfig: { runawayLogLimitBytes: -3 } }],
  ["runaway adapterConfig non-number -> env", { adapterConfig: { runawayLogLimitBytes: "9e6" }, env: { PAPERCLIP_RUNAWAY_LOG_LIMIT_BYTES: "1234567.9" } }],
  ["runaway env '0' disables", { env: { PAPERCLIP_RUNAWAY_LOG_LIMIT_BYTES: "0" } }],
  ["transient retry '0'", { env: { PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC: "0" } }],
  ["noProgress window sec->ms", { env: { PAPERCLIP_NO_PROGRESS_WINDOW_SEC: "7200" } }],
  ["advisory '1e1' notation", { env: { PAPERCLIP_NO_PROGRESS_ADVISORY_THRESHOLD: "1e1" } }],
  ["403 delays 'off' -> []", { env: { PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: " off " } }],
  ["403 delays parseInt prefixes", { env: { PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: "2x, 7, -3, 0, 15.9" } }],
  ["403 delays all garbage -> []", { env: { PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: "x,y" } }],
  ["403 codes CSV dedup+upper", { env: { PAPERCLIP_PROVIDER_403_RETRY_REASON_CODES: "a_b, A_B,, c-d, A_B" } }],
  ["403 codes 'none' -> []", { env: { PAPERCLIP_PROVIDER_403_RETRY_REASON_CODES: "NONE" } }],
  ["env non-string value -> throws", { env: { PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: 5 } }],
  ["env null -> throws", { env: null }],
  ["env non-object -> all defaults", { env: 5 }],
]));

describe("stability-compute: advisory bytes + step-aware timeout + signals", cases("stability-compute", tsCompute, [
  ["soft = floor(16MiB*0.6)", { runawayLogLimitBytes: 16777216, step: {} }],
  ["soft min-1MiB floor", { runawayLogLimitBytes: 1048576, step: {} }],
  ["soft capped at tiny limit", { runawayLogLimitBytes: 900000, step: {} }],
  ["soft limit 0 -> 0", { runawayLogLimitBytes: 0, step: {} }],
  ["soft limit string ToNumber", { runawayLogLimitBytes: "9000000", step: {} }],
  ["soft limit 'abc' -> 0", { runawayLogLimitBytes: "abc", step: {} }],
  ["soft limit true -> 1 byte", { runawayLogLimitBytes: true, step: {} }],
  ["base<=0 -> 0", { baseMs: 0, step: {} }],
  ["nullish contract -> raw base", { baseMs: 100, contract: null, step: {} }],
  ["contract stepTimeoutSeconds wins", { baseMs: 100, contract: { stepTimeoutSeconds: 10 }, step: {} }],
  ["qa contract + qa timeout", { baseMs: 100, contract: { isQaStep: true }, qaStepActiveExecutionTimeoutMs: 2000, step: {} }],
  ["qa contract + qa 0 -> base", { baseMs: 100, contract: { isQaStep: true }, qaStepActiveExecutionTimeoutMs: 0, step: {} }],
  ["no base + stepTimeout -> NaN -> null", { contract: { stepTimeoutSeconds: 10 }, step: {} }],
  ["no base + null contract -> key dropped", { contract: null, step: {} }],
  ["base 'abc' + null contract -> raw", { baseMs: "abc", contract: null, step: {} }],
  ["signals timeout floor", { step: { timeoutSeconds: 5.9 } }],
  ["signals timeout negative -> 0", { step: { timeoutSeconds: -2 } }],
  ["signals type ' QA ' -> qa", { step: { type: " QA " } }],
  ["signals qaType slug", { step: { qaType: "delivery" } }],
  ["signals bad qaType + validator type", { step: { qaType: "no space", type: "validator" } }],
  ["signals type approval -> not qa", { step: { type: "approval" } }],
  ["step null -> throws", { step: null }],
]));

describe("run-context", cases("run-context", tsRunCtx, [
  ["ctx taskKey wins", { contextSnapshot: { taskKey: " K1 " }, payload: { taskId: "p" } }],
  ["ctx taskId next", { contextSnapshot: { taskKey: "  ", taskId: "t" } }],
  ["ctx issueId", { contextSnapshot: { issueId: "i" } }],
  ["payload taskKey", { contextSnapshot: {}, payload: { taskKey: "pk" } }],
  ["payload taskId", { payload: { taskId: "pt" } }],
  ["payload issueId", { payload: { issueId: "pi" } }],
  ["all blank/non-string -> null", { contextSnapshot: { taskKey: " " }, payload: { taskId: 5 } }],
  ["ctx non-object -> payload", { contextSnapshot: 5, payload: { taskKey: "x" } }],
  ["value trims", { value: "  a b  " }],
  ["value FEFF-only -> null", { value: "\uFEFF\uFEFF" }],
  ["value NEL kept (U+0085 not JS-WS)", { value: "\u0085x" }],
  ["value non-string -> null", { value: 5 }],
  ["fallbackAttempt floor", { contextRaw: { fallbackAttempt: 3.9 } }],
  ["fallbackAttempt negative -> 0", { contextRaw: { fallbackAttempt: -2 } }],
  ["fallbackAttempt string -> 0", { contextRaw: { fallbackAttempt: "3" } }],
  ["contextRaw array -> 0", { contextRaw: [1, 2] }],
  ["agentNameKey trim+lower", { agentName: "  AG Ent X  " }],
  ["agentNameKey NBSP-blank -> null", { agentName: " \u00A0 " }],
  ["sameScope both absent -> true", {}],
  ["sameScope equal", { left: "a", right: "a" }],
  ["sameScope left only -> false", { left: "a" }],
  ["sameScope numbers", { left: 5, right: 5 }],
  ["sameScope num vs str -> false", { left: 5, right: "5" }],
]));

describe("session-reset", cases("session-reset", tsReset, [
  ["empty ctx -> false/null", { contextSnapshot: {} }],
  ["forceFreshSession -> reason1", { contextSnapshot: { forceFreshSession: true } }],
  ["forceFreshSession 'true' string -> no", { contextSnapshot: { forceFreshSession: "true" } }],
  ["rework contract", { contextSnapshot: { paperclipWorkflowReworkContract: { kind: "workflow_qa_rework" } } }],
  ["rework kind trimmed", { contextSnapshot: { paperclipWorkflowReworkContract: { kind: " workflow_qa_rework " } } }],
  ["rework contract non-object", { contextSnapshot: { paperclipWorkflowReworkContract: "x" } }],
  ["rework kind mismatch", { contextSnapshot: { paperclipWorkflowReworkContract: { kind: "other" } } }],
  ["wake issue_assigned", { contextSnapshot: { wakeReason: "issue_assigned" } }],
  ["wake planning_issue_created resets w/o reason", { contextSnapshot: { wakeReason: "mission_owner_planning_issue_created" } }],
  ["wake action_created", { contextSnapshot: { wakeReason: "mission_unblock_action_created" } }],
  ["wake action_stalled", { contextSnapshot: { wakeReason: "mission_unblock_action_stalled" } }],
  ["wake other -> no reset", { contextSnapshot: { wakeReason: "timer" } }],
  ["wake non-string -> no reset", { contextSnapshot: { wakeReason: 5 } }],
  ["ctx null", { contextSnapshot: null }],
]));

describe("output-validation: gate + stepRunRequiresWorkProduct", cases("output-validation", tsOutVal, [
  ["origin plan -> false", { issue: { originKind: "mission_main_executor_plan", title: "create report" } }],
  ["origin oversight -> false", { issue: { originKind: "mission_main_executor_oversight" } }],
  ["origin unblock -> false", { issue: { originKind: "mission_main_executor_unblock" } }],
  ["flag true beats review title", { issue: { originKind: "x", title: "final review" }, stepRunRequiresWorkProduct: true }],
  ["flag false beats deliverable", { issue: { originKind: "x", title: "create report" }, stepRunRequiresWorkProduct: false }],
  ["skip-title 'QA sign-off'", { issue: { originKind: "x", title: "QA sign-off" } }],
  ["'checkers' — \\b blocks 'check'", { issue: { originKind: "x", title: "checkers" } }],
  ["deliverable 'create report'", { issue: { originKind: "x", title: "Create the report" } }],
  ["deliverable 'synthetize' z-spelling", { issue: { originKind: "x", title: "synthetize notes" } }],
  ["iu \\b fold: leading long-s '\\u017fynthesize notes' -> true", { issue: { originKind: "x", title: "\u017fynthesize notes" } }],
  ["iu \\b fold: trailing long-s 'report\\u017f' -> false", { issue: { originKind: "x", title: "report\u017f" } }],
  ["iu \\b fold: kelvin-k 'chec\\u212a status' -> false (skip)", { issue: { originKind: "x", title: "chec\u212a status" } }],
  ["ko '보고서 작성'", { issue: { originKind: "x", title: "보고서 작성" } }],
  ["ko 검토 w/ 보고서 noun -> true", { issue: { originKind: "x", title: "보고서 검토" } }],
  ["no deliverable -> false", { issue: { originKind: "x", title: "read the memo" } }],
  ["desc phrase + ARTIFACT:", { issue: { originKind: "x", title: "collect inputs", description: "Deliverable output (use exactly this directory) ARTIFACT: ./out" } }],
  ["desc phrase w/o ARTIFACT -> title path", { issue: { originKind: "x", title: "read", description: "Deliverable output (use exactly this directory) save.md" } }],
  ["desc ARTIFACT w/o phrase -> false", { issue: { originKind: "x", title: "read", description: "ARTIFACT: ./out" } }],
  ["desc `[ARTIFACT]` : variant", { issue: { originKind: "x", title: "read", description: "Deliverable output (use exactly this directory) `[ARTIFACT]` :" } }],
  ["issue title number -> throws", { issue: { originKind: "x", title: 5 } }],
  ["issue desc number -> throws", { issue: { originKind: "x", title: "read", description: 5 } }],
  ["issue null -> throws", { issue: null }],
  ["issue missing -> throws", {}],
  ["metadata flag true", { issue: { originKind: "x" }, metadata: { graphWorkProductRequired: true } }],
  ["metadata flag false", { issue: { originKind: "x" }, metadata: { graphWorkProductRequired: false } }],
  ["metadata non-bool -> null", { issue: { originKind: "x" }, metadata: { graphWorkProductRequired: "yes" } }],
  ["metadata array -> null", { issue: { originKind: "x" }, metadata: [true] }],
]));

describe("progress-evidence", cases("progress-evidence", tsProgress, [
  ["workProduct hit", { workProductRunIds: ["r1"], transitionRunIds: [], agentCommentTimestamps: [], run: { id: "r1" } }],
  ["transition hit", { workProductRunIds: [], transitionRunIds: ["r1"], agentCommentTimestamps: [], run: { id: "r1" } }],
  ["comment inside window", { workProductRunIds: [], transitionRunIds: [], agentCommentTimestamps: [1500], run: { id: "r1", startedAt: 1000, finishedAt: 2000, createdAt: 500 } }],
  ["comment before window", { workProductRunIds: [], transitionRunIds: [], agentCommentTimestamps: [900], run: { id: "r1", startedAt: 1000, finishedAt: 2000, createdAt: 500 } }],
  ["comment at window end", { workProductRunIds: [], transitionRunIds: [], agentCommentTimestamps: [2000], run: { id: "r1", startedAt: 1000, finishedAt: 2000, createdAt: 500 } }],
  ["no finishedAt -> end=start", { workProductRunIds: [], transitionRunIds: [], agentCommentTimestamps: [1000], run: { id: "r1", startedAt: 1000, finishedAt: null, createdAt: 500 } }],
  ["no startedAt -> createdAt window", { workProductRunIds: [], transitionRunIds: [], agentCommentTimestamps: [500], run: { id: "r1", startedAt: null, finishedAt: 2000, createdAt: 500 } }],
  ["no evidence -> false", { workProductRunIds: [], transitionRunIds: [], agentCommentTimestamps: [], run: { id: "r1", startedAt: 1000, createdAt: 500 } }],
  ["run missing -> throws", { workProductRunIds: [], transitionRunIds: [], agentCommentTimestamps: [] }],
  ["wpr missing -> throws", { transitionRunIds: [], agentCommentTimestamps: [], run: { id: "r1" } }],
  ["wpr non-array -> throws", { workProductRunIds: "r1", transitionRunIds: [], agentCommentTimestamps: [], run: { id: "r1" } }],
  ["comments non-array -> throws", { workProductRunIds: [], transitionRunIds: [], agentCommentTimestamps: 5, run: { id: "r1" } }],
  ["invalid date string -> false", { workProductRunIds: [], transitionRunIds: [], agentCommentTimestamps: ["not-a-date"], run: { id: "r1", startedAt: 1000, createdAt: 500 } }],
  ["numeric id in set", { workProductRunIds: [5], transitionRunIds: [], agentCommentTimestamps: [], run: { id: 5 } }],
]));

describe("stage2 CLI contract", () => {
  it("fails closed on unknown subcommand and malformed stdin", () => {
    for (const out of [
      rustRaw("stability-e", "{}"),
      rustRaw("stability-env", "{not json"),
      rustRaw("run-context", ""),
    ]) {
      expect(out.threw).toBe(true);
    }
  });
});
