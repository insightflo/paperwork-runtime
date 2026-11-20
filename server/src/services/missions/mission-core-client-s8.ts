import {
  isMissionExecutionLiaisonAgent as isMissionExecutionLiaisonAgentNode,
  resolveHermesOpsMode as resolveHermesOpsModeNode,
  type HermesOpsMode,
  type MissionExecutionAssigneeAgent,
} from "./agent-role-boundaries.js";
import { validateDeclaredStructuralPlan as validateDeclaredStructuralPlanNode } from "./structural-plan-validation.js";
import {
  buildDeliveryVerificationCriteria as buildDeliveryVerificationCriteriaNode,
  synthesizeDeliveryVerificationGateStep as synthesizeDeliveryVerificationGateStepNode,
} from "../workflow/delivery-verification-gate.js";
import { renderMissionPlanUnitContractLines as renderMissionPlanUnitContractLinesNode } from "./mission-plan-unit-contract.js";
import { MissionCoreContractError, runMissionCoreWithNodeFallback } from "./mission-core-client.js";

/**
 * [목적] Stage 7B(agent-role-boundaries: is-liaison-agent / resolve-hermes-ops-mode)와
 *   Stage 8B(validate-declared-structural-plan / delivery-build-criteria /
 *   delivery-synthesize-gate-step / plan-unit-contract-lines) 서브커맨드의 Node 브리지.
 *   mission-core-client.ts 의 runMissionCoreWithNodeFallback 게이트·warn-once·시맨틱
 *   에러 계약을 그대로 재사용한다 — 이 파일은 transport 를 소유하지 않는다.
 * [주의] shape 는 TS 반환 계약으로 엄격히 검증한다 — 계약 밖 응답(비bool/비배열/게이트
 *   필수 키 누락/모드 집합 밖 문자열)은 MissionCoreContractError 로 warn-once 후 TS 팔.
 *   exit 1 + stderr 의 시맨틱 에러(TS throw 미러)는 fallback 없이 그대로 전파된다.
 *   서브프로세스 스폰은 db.transaction 밖 async 호출자에서만 — 호출자가 보장한다.
 * [수정시 영향] shape 검증을 느슨히 하면 parity 를 깨뜨린 채 fallback 없이 흐른다.
 */

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
/** shape 불량 → 계약 위반(fallback 대상). reason 은 `mission_core_<reason>_bad_shape` 로 확장된다. */
function shape<T>(cond: boolean, value: T, reason: string): T {
  if (!cond) throw new MissionCoreContractError(`mission_core_${reason}_bad_shape`);
  return value;
}

const HERMES_OPS_MODES: ReadonlySet<string> = new Set(["advisor", "supervision", "relay", "admin"]);

export function isMissionExecutionLiaisonAgentWithNodeFallback(
  agent: MissionExecutionAssigneeAgent,
): Promise<boolean> {
  return runMissionCoreWithNodeFallback("is-liaison-agent", { agent },
    (r) => shape(typeof r === "boolean", r as boolean, "liaison_agent"),
    () => isMissionExecutionLiaisonAgentNode(agent));
}

export function resolveHermesOpsModeWithNodeFallback(
  agent: MissionExecutionAssigneeAgent,
): Promise<HermesOpsMode> {
  return runMissionCoreWithNodeFallback("resolve-hermes-ops-mode", { agent },
    (r) => shape(typeof r === "string" && HERMES_OPS_MODES.has(r), r as HermesOpsMode, "hermes_ops_mode"),
    () => resolveHermesOpsModeNode(agent));
}

export function validateDeclaredStructuralPlanWithNodeFallback(
  units: Parameters<typeof validateDeclaredStructuralPlanNode>[0],
  draftSteps: Parameters<typeof validateDeclaredStructuralPlanNode>[1] = [],
): Promise<string[]> {
  return runMissionCoreWithNodeFallback("validate-declared-structural-plan", { units, draftSteps },
    (r) => shape(isStringArray(r), r as string[], "structural_plan"),
    () => validateDeclaredStructuralPlanNode(units, draftSteps));
}

export function buildDeliveryVerificationCriteriaWithNodeFallback(): Promise<string> {
  return runMissionCoreWithNodeFallback("delivery-build-criteria", {},
    (r) => shape(
      typeof r === "string" && r.startsWith("Delivery Verification:"), r as string, "delivery_criteria"),
    () => buildDeliveryVerificationCriteriaNode());
}

/**
 * Rust 는 input.agentId/dependencyStepIds 가 없으면 출력 키 자체를 생략한다(TS 는 값
 * undefined 로 키를 유지) — 선택 키는 있을 때만 타입을 검사하고 toEqual 비교에 맡긴다.
 */
export function synthesizeDeliveryVerificationGateStepWithNodeFallback(
  input: Parameters<typeof synthesizeDeliveryVerificationGateStepNode>[0],
): Promise<ReturnType<typeof synthesizeDeliveryVerificationGateStepNode>> {
  return runMissionCoreWithNodeFallback("delivery-synthesize-gate-step", { input },
    (r) => shape(
      isObjectRecord(r)
        && r.id === "delivery-verification-gate"
        && typeof r.name === "string"
        && r.qaType === "delivery"
        && (r.agentId === undefined || typeof r.agentId === "string")
        && (r.dependencies === undefined || isStringArray(r.dependencies))
        && r.graphWorkProductRequired === false
        && typeof r.description === "string",
      r, "delivery_gate_step") as ReturnType<typeof synthesizeDeliveryVerificationGateStepNode>,
    () => synthesizeDeliveryVerificationGateStepNode(input));
}

/** TS 구현명은 renderMissionPlanUnitContractLines — 포맷된 계약 라인 배열을 그대로 돌려준다. */
export function formatMissionPlanUnitContractLinesWithNodeFallback(
  unit: Parameters<typeof renderMissionPlanUnitContractLinesNode>[0],
): Promise<string[]> {
  return runMissionCoreWithNodeFallback("plan-unit-contract-lines", { unit },
    (r) => shape(isStringArray(r), r as string[], "unit_contract_lines"),
    () => renderMissionPlanUnitContractLinesNode(unit));
}
