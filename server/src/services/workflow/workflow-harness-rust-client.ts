import { runWorkflowCoreSubcommand, WorkflowCoreContractError } from "./workflow-core-client.js";

/**
 * [목적] Rust paperclip-workflow-core 의 하네스 원시 요소(Stage S22-1 harness_gate)를 부르는 씬 Node
 *   클라이언트. 서브커맨드 4종: evaluate-dispatch-route(확률 게이트 라우팅) · advisor-required-gate /
 *   advisor-checkpoint(자문 3관문 트리거·체크포인트 계약 검증) · apply-step-attribution(검증 결과 →
 *   EWMA 사전 역귀속). 바이너리 해석(PAPERCLIP_WORKFLOW_CORE_BIN 절대경로)·게이트(WORKFLOW_CORE_RUST=0)·
 *   tx 스폰 금지·타임아웃·출력 상한은 workflow-core-client.ts 계약을 그대로 재사용한다.
 * [주의] Node fallback 이 없다 — 이 원시 요소에는 TS 등가 구현이 없다. bin 부재·스폰 실패·비정상 종료·
 *   비JSON·shape 불일치는 전부 reject 다(fail-closed). 어떤 경로도 기본값이나 관대한 해석으로
 *   "진행 허용"을 만들지 않는다. advisor-checkpoint 는 Rust 의 valid/allowsProgress 플래그만 믿지
 *   않고 응답 구조와 판정 일관성(allowsProgress ⇔ decision==="pass")을 다시 검증한다.
 *   자문 판정의 권한 근거는 이 스키마 검증 JSON 뿐이다 — 자연어 마커는 받지 않는다(실행 권한 규칙 9).
 * [수정시 영향] 소비자는 아직 없다(additive). shape 검증을 느슨히 하면 fail-closed 가 깨진 채
 *   allowsProgress:true 가 흐를 수 있다. 스키마는 crates/workflow-core/src/harness_gate.rs 와
 *   1:1 이어야 한다 — 상수·리터럴·gate 이름은 그 파일을 먼저 바꾼 뒤 여기로 옮긴다.
 */

export const HARNESS_SUBCOMMANDS = [
  "evaluate-dispatch-route",
  "advisor-required-gate",
  "advisor-checkpoint",
  "apply-step-attribution",
] as const;
export type HarnessSubcommand = (typeof HARNESS_SUBCOMMANDS)[number];

// ── 1. 확률 게이트 라우팅 (harness_gate.rs §1) ──
export const HARNESS_DEFAULT_SHARP_THRESHOLD = 0.70;
export const HARNESS_FORCED_REASON = "consecutive_errors>=2";
const DISPATCH_ROUTES = ["sharp", "split", "escalate_advisor"] as const;
const RISK_LEVELS = ["low", "medium", "high"] as const;

export type HarnessDispatchRoute = (typeof DISPATCH_ROUTES)[number];
export type HarnessRiskLevel = (typeof RISK_LEVELS)[number];

/** evaluate-dispatch-route 입력 — camelCase. sharpThreshold 는 생략·null·(0,1] 밖이면 기본값으로 폴백. */
export interface HarnessDispatchRouteInput {
  sharpThreshold?: number | null;
  successProbability: number;
  riskLevel: HarnessRiskLevel;
  consecutiveErrors: number;
}

export interface HarnessDispatchRouteDecision {
  route: HarnessDispatchRoute;
  sharpThreshold: number;
  forcedReason: typeof HARNESS_FORCED_REASON | null;
}

// ── 2. 자문 3관문 (harness_gate.rs §2) ──
export const ADVISOR_GATES = ["g1_pre_plan", "g2_second_error", "g3_pre_closeout"] as const;
export const HARNESS_ADVISOR_CHECKPOINT_SCHEMA_VERSION = 1;
export type HarnessAdvisorGate = (typeof ADVISOR_GATES)[number];

/** advisor-required-gate 입력 — 급성 회귀(G2) > 계획 검토(G1) > 머지 전(G3), 해당 없음 null. */
export interface HarnessAdvisorTriggerInput {
  planPendingApproval: boolean;
  consecutiveErrors: number;
  verifierPassed: boolean;
}

export type HarnessAdvisorVerdict =
  | { decision: "pass" }
  | { decision: "challenge"; reason: string };

/** 계약 검증을 통과한 체크포인트 문서 — runId 는 트림본, verdict 는 태그 형태. */
export interface HarnessAdvisorCheckpoint {
  schemaVersion: typeof HARNESS_ADVISOR_CHECKPOINT_SCHEMA_VERSION;
  runId: string;
  gate: HarnessAdvisorGate;
  verdict: HarnessAdvisorVerdict;
}

/** advisor-checkpoint 결과 — invalid 문서는 error 코드와 함께 allowsProgress:false 로 돌아온다. */
export type HarnessAdvisorCheckpointRejectionReason =
  | "not_an_object"
  | "unrecognized_key"
  | "unsupported_schema_version"
  | "missing_run_id"
  | "unknown_gate"
  | "invalid_advisor_verdict";

export type HarnessAdvisorCheckpointResult =
  | { valid: true; allowsProgress: boolean; checkpoint: HarnessAdvisorCheckpoint }
  | { valid: false; allowsProgress: false; error: HarnessAdvisorCheckpointRejectionReason };

// ── 3. 검증 결과 역귀속 (harness_gate/attribution.rs) ──
const ATTRIBUTION_KINDS = ["success", "failed", "rework", "stalled", "isolated", "unrecognized"] as const;
export type HarnessAttributionKind = (typeof ATTRIBUTION_KINDS)[number];

/** EWMA Beta 사전 — γ=0.92, M0=6, measured n≥5 는 Rust 상수다(TS 는 값만 운반). */
export interface HarnessSuccessRatePrior {
  ewmaSuccess: number;
  ewmaFail: number;
  rawSamples: number;
  consecutiveErrors: number;
}

/** 스텝 판정 귀속 입력 — verdictPass null 은 verifier 미개입, false 는 verifier 반려(w=2.0). */
export interface HarnessStepVerdictAttribution {
  runId: string;
  stepRunId: string;
  outcome: string;
  verdictPass: boolean | null;
  stallDetected: boolean;
  durationMs: number;
}

/** recorded=false 면 prior 불변(격리·미인식·귀속 누락) — 호출자는 bounded retry/재배차 경로로. */
export interface HarnessAttributionUpdate {
  runId: string;
  stepRunId: string;
  kind: HarnessAttributionKind;
  recorded: boolean;
  weight: number;
  prior: HarnessSuccessRatePrior;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isNonNegativeUint(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
function contractError(reason: string): WorkflowCoreContractError {
  return new WorkflowCoreContractError(reason);
}

/** 하네스 서브커맨드 1회 실행 + 엄격 해석 — fallback 없음, Unavailable/Contract 는 그대로 거절. */
async function runHarness<T>(
  subcommand: HarnessSubcommand,
  payload: unknown,
  interpret: (response: unknown) => T,
): Promise<T> {
  const response = await runWorkflowCoreSubcommand<unknown>(subcommand, payload);
  return interpret(response);
}

function interpretDispatchRoute(response: unknown): HarnessDispatchRouteDecision {
  const bad = () => contractError("workflow_core_dispatch_route_bad_shape");
  if (!isRecord(response) || !isOneOf(response.route, DISPATCH_ROUTES)) throw bad();
  const { sharpThreshold, forcedReason } = response;
  if (!isFiniteNumber(sharpThreshold) || !(sharpThreshold > 0 && sharpThreshold <= 1)) throw bad();
  if (forcedReason !== null && forcedReason !== HARNESS_FORCED_REASON) throw bad();
  // Rust 불변: 강제 승격 ⇔ escalate_advisor. 어긋난 응답은 신뢰하지 않는다.
  if ((response.route === "escalate_advisor") !== (forcedReason !== null)) throw bad();
  return { route: response.route, sharpThreshold, forcedReason };
}

function interpretAdvisorGate(response: unknown): HarnessAdvisorGate | null {
  if (!isRecord(response) || !("gate" in response)) {
    throw contractError("workflow_core_advisor_gate_bad_shape");
  }
  if (response.gate !== null && !isOneOf(response.gate, ADVISOR_GATES)) {
    throw contractError("workflow_core_advisor_gate_bad_shape");
  }
  return response.gate;
}

function interpretAdvisorVerdict(value: unknown): HarnessAdvisorVerdict {
  const bad = () => contractError("workflow_core_advisor_checkpoint_bad_shape");
  if (isRecord(value) && value.decision === "pass" && !("reason" in value)) return { decision: "pass" };
  if (isRecord(value) && value.decision === "challenge" && typeof value.reason === "string") {
    return { decision: "challenge", reason: value.reason };
  }
  throw bad();
}

function interpretAdvisorCheckpoint(response: unknown): HarnessAdvisorCheckpointResult {
  const bad = () => contractError("workflow_core_advisor_checkpoint_bad_shape");
  if (!isRecord(response)) throw bad();
  if (response.valid === false) {
    // 무효 문서 — 진행 불가만 허용. allowsProgress:true 나 비문자열 error 는 계약 위반.
    if (response.allowsProgress !== false || typeof response.error !== "string") throw bad();
    return { valid: false, allowsProgress: false, error: response.error as HarnessAdvisorCheckpointRejectionReason };
  }
  const checkpoint = response.checkpoint;
  if (response.valid !== true || typeof response.allowsProgress !== "boolean" || !isRecord(checkpoint)) throw bad();
  if (checkpoint.schemaVersion !== HARNESS_ADVISOR_CHECKPOINT_SCHEMA_VERSION
    || typeof checkpoint.runId !== "string" || checkpoint.runId.trim() === ""
    || !isOneOf(checkpoint.gate, ADVISOR_GATES)) {
    throw bad();
  }
  const verdict = interpretAdvisorVerdict(checkpoint.verdict);
  const allowsProgress = verdict.decision === "pass";
  // fail-closed: Rust 플래그가 판정과 어긋나면(예: challenge 인데 true) 절대 통과시키지 않는다.
  if (response.allowsProgress !== allowsProgress) throw bad();
  return {
    valid: true,
    allowsProgress,
    checkpoint: {
      schemaVersion: HARNESS_ADVISOR_CHECKPOINT_SCHEMA_VERSION,
      runId: checkpoint.runId,
      gate: checkpoint.gate,
      verdict,
    },
  };
}

function interpretPrior(value: unknown): HarnessSuccessRatePrior {
  const bad = () => contractError("workflow_core_step_attribution_bad_shape");
  if (!isRecord(value) || !isFiniteNumber(value.ewmaSuccess) || !isFiniteNumber(value.ewmaFail)
    || !isNonNegativeUint(value.rawSamples) || !isNonNegativeUint(value.consecutiveErrors)) {
    throw bad();
  }
  return {
    ewmaSuccess: value.ewmaSuccess,
    ewmaFail: value.ewmaFail,
    rawSamples: value.rawSamples,
    consecutiveErrors: value.consecutiveErrors,
  };
}

function interpretAttributionUpdate(response: unknown): HarnessAttributionUpdate {
  const bad = () => contractError("workflow_core_step_attribution_bad_shape");
  if (!isRecord(response) || typeof response.runId !== "string" || typeof response.stepRunId !== "string"
    || !isOneOf(response.kind, ATTRIBUTION_KINDS) || typeof response.recorded !== "boolean"
    || !isFiniteNumber(response.weight) || response.weight < 0) {
    throw bad();
  }
  const { recorded, weight, kind } = response;
  // Rust 불변: 미기록은 가중 0, 기록은 양수 가중, 격리·미인식은 절대 기록되지 않는다.
  if (recorded ? weight <= 0 || kind === "isolated" || kind === "unrecognized" : weight !== 0) throw bad();
  return { runId: response.runId, stepRunId: response.stepRunId, kind, recorded, weight, prior: interpretPrior(response.prior) };
}

/** dgate `evaluate_route` 포트 — 연속 오류 ≥2 는 p 와 무관하게 escalate_advisor, low 위험 && p ≥ θ 는 sharp, 그 외 split. */
export function evaluateDispatchRoute(input: HarnessDispatchRouteInput): Promise<HarnessDispatchRouteDecision> {
  return runHarness("evaluate-dispatch-route", input, interpretDispatchRoute);
}

/** 결정론 관문 트리거 — G2(연속 오류 ≥2) > G1(계획 승인 대기) > G3(verifier 통과), 해당 없음 null. */
export function requiredAdvisorGate(input: HarnessAdvisorTriggerInput): Promise<HarnessAdvisorGate | null> {
  return runHarness("advisor-required-gate", input, interpretAdvisorGate);
}

/**
 * 자문 체크포인트 계약 검증 — `{schemaVersion:1, runId, gate, decision[, reason]}` 만 통과.
 * 무효 문서는 reject 가 아니라 `valid:false, allowsProgress:false, error` 로 돌아오므로 호출자는
 * 반드시 allowsProgress 를 검사해야 한다. 검사를 잊을 수 없게 하려면 assertAdvisorCheckpointAllowsProgress 를 쓴다.
 */
export function validateAdvisorCheckpoint(doc: unknown): Promise<HarnessAdvisorCheckpointResult> {
  return runHarness("advisor-checkpoint", doc, interpretAdvisorCheckpoint);
}

/** 검증 결과 역귀속 — stall > verifier 반려(w=2.0) > outcome 문자열, 환경류(config_error 등)는 격리. */
export function applyStepAttribution(
  prior: HarnessSuccessRatePrior,
  attribution: HarnessStepVerdictAttribution,
): Promise<HarnessAttributionUpdate> {
  return runHarness("apply-step-attribution", { prior, attribution }, interpretAttributionUpdate);
}

/** 체크포인트가 진행을 허용하지 않는다 — reason 은 반려 사유(challenge) 또는 계약 위반 코드(invalid). */
export class WorkflowHarnessAdvisorBlockedError extends Error {
  constructor(
    readonly reason: string,
    readonly checkpoint: HarnessAdvisorCheckpoint | null,
  ) {
    super(`advisor_checkpoint_blocked: ${reason}`);
    this.name = "WorkflowHarnessAdvisorBlockedError";
  }
}

/** fail-closed 소비 표면 — pass 문서만 통과시키고 그 외는 Blocked 로 던진다(Unavailable/Contract 는 그대로 전파). */
export async function assertAdvisorCheckpointAllowsProgress(doc: unknown): Promise<HarnessAdvisorCheckpoint> {
  const result = await validateAdvisorCheckpoint(doc);
  if (result.valid && result.allowsProgress) return result.checkpoint;
  if (result.valid) {
    const { verdict } = result.checkpoint;
    // 해석기가 allowsProgress⇔pass 를 강제하므로 여기는 challenge 여야 한다 — 아니면 계약 위반.
    if (verdict.decision !== "challenge") throw contractError("workflow_core_advisor_checkpoint_bad_shape");
    throw new WorkflowHarnessAdvisorBlockedError(verdict.reason, result.checkpoint);
  }
  throw new WorkflowHarnessAdvisorBlockedError(result.error, null);
}
