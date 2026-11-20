import {
  collectAncestorStepIds as collectAncestorStepIdsNode,
  collectArtifactReferences as collectArtifactReferencesNode,
  findWorkflowToolReferenceErrors as findWorkflowToolReferenceErrorsNode,
  type WorkflowArtifactReferenceStep,
  type WorkflowToolReferenceError,
} from "./step-artifact-references.js";
import {
  isStructuralGateStep as isStructuralGateStepNode,
  readStructuralGateProducerToken as readStructuralGateProducerTokenNode,
  sameStructuralGateProducerToken as sameStructuralGateProducerTokenNode,
  type StructuralGateProducerToken,
  type StructuralGateStep,
} from "./control-flow/structural-gate.js";
import {
  getStructuralTopologyErrors as getStructuralTopologyErrorsNode,
  type StructuralTopologyStep,
} from "./control-flow/structural-topology.js";
import { checkStepEligibility as checkStepEligibilityNode } from "./resume/eligibility.js";
import type { StepEligibilityBlocker, StepHistory } from "./resume/types.js";
import { sortWorkflowStepsByPriority as sortWorkflowStepsByPriorityNode } from "./dag-step-priority.js";
import type { WorkflowStep } from "./dag-engine.js";
import { runWithNodeFallback, WorkflowCoreContractError } from "./workflow-core-client.js";

/**
 * [목적] Stage 7A 서브커맨드(artifact-references / ancestor-step-ids /
 *   tool-reference-errors / gate-producer-token / same-producer-token /
 *   is-structural-gate / structural-topology-errors)와 Stage 7C
 *   (check-step-eligibility / sort-steps-by-priority)의 Node 브리지.
 *   workflow-core-client.ts 의 runWithNodeFallback/게이트/warn-once 계약을 그대로 재사용한다.
 * [주의] 응답 shape 는 TS 반환 타입 계약으로 엄격히 검증한다 — 선언 타입 밖 원소
 *   (예: 비문자열 dep id 로 생긴 ancestors 의 null/숫자, 비문자열 stepId)는 계약 위반으로
 *   TS fallback 하고 TS 팔이 원래 동작을 그대로 재현한다. 시맨틱 TypeError(비iterable
 *   deps·null edge·undefined 기반 토큰 필드 접근)는 Rust 가 exit 1 로 재현하므로
 *   Unavailable 과 구분할 수 없어 warn 후 TS 팔이 같은 예외를 다시 던진다
 *   (호출자는 어느 판정이든 동일 실패를 본다).
 *   F4: 서브프로세스 스폰은 db.transaction 밖 async 호출자에서만 — 호출자가 보장한다.
 * [수정시 영향] shape 검증을 느슨히 하면 parity 를 깨뜨린 채 fallback 없이 흐른다.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** `{key: [...]}` 봉투에서 문자열 배열 필드를 꺼낸다 — shape 불량은 계약 위반. */
function stringArrayField(response: unknown, key: string, reason: string): string[] {
  const value = isRecord(response) ? response[key] : undefined;
  if (!isStringArray(value)) throw new WorkflowCoreContractError(`${reason}_bad_shape`);
  return value;
}

/** `{key: bool}` 봉투에서 boolean 필드를 꺼낸다 — shape 불량은 계약 위반. */
function booleanField(response: unknown, key: string, reason: string): boolean {
  const value = isRecord(response) ? response[key] : undefined;
  if (typeof value !== "boolean") throw new WorkflowCoreContractError(`${reason}_bad_shape`);
  return value;
}

/** TS 와 동일하게 호출자가 넘긴 result Set 을 그대로 채워 반환한다(seed 없으면 새 Set). */
export function collectArtifactReferencesWithNodeFallback(
  value: unknown,
  result?: Set<string>,
): Promise<Set<string>> {
  return runWithNodeFallback({
    subcommand: "artifact-references",
    payload: () => ({ value }),
    fallback: () => collectArtifactReferencesNode(value, result),
    interpret: (response) => {
      const references = stringArrayField(response, "references", "workflow_core_artifact_references");
      const out = result ?? new Set<string>();
      for (const id of references) out.add(id);
      return out;
    },
  });
}

export function collectAncestorStepIdsWithNodeFallback(
  currentStepId: string,
  steps: readonly WorkflowArtifactReferenceStep[],
): Promise<Set<string>> {
  return runWithNodeFallback({
    subcommand: "ancestor-step-ids",
    payload: () => ({ currentStepId, steps }),
    fallback: () => collectAncestorStepIdsNode(currentStepId, steps),
    interpret: (response) =>
      new Set(stringArrayField(response, "ancestors", "workflow_core_ancestor_step_ids")),
  });
}

export function findWorkflowToolReferenceErrorsWithNodeFallback(
  steps: readonly WorkflowArtifactReferenceStep[],
): Promise<WorkflowToolReferenceError[]> {
  return runWithNodeFallback({
    subcommand: "tool-reference-errors",
    payload: () => ({ steps }),
    fallback: () => findWorkflowToolReferenceErrorsNode(steps),
    interpret: (response) => {
      const errors = isRecord(response) ? response.errors : undefined;
      if (!Array.isArray(errors)) {
        throw new WorkflowCoreContractError("workflow_core_tool_reference_errors_bad_shape");
      }
      return errors.map((raw) => {
        if (!isRecord(raw)
          || (raw.stepId !== undefined && typeof raw.stepId !== "string")
          || typeof raw.referencedStepId !== "string"
          || (raw.reason !== "unknown_step" && raw.reason !== "not_ancestor")) {
          throw new WorkflowCoreContractError("workflow_core_tool_reference_errors_bad_item");
        }
        // Rust 는 undefined stepId 의 키를 생략한다 — TS 는 값 undefined 로 키를 유지한다.
        return { stepId: undefined, ...raw } as unknown as WorkflowToolReferenceError;
      });
    },
  });
}

export function readStructuralGateProducerTokenWithNodeFallback(
  value: unknown,
): Promise<StructuralGateProducerToken | null> {
  return runWithNodeFallback({
    subcommand: "gate-producer-token",
    payload: () => ({ value }),
    fallback: () => readStructuralGateProducerTokenNode(value),
    interpret: (response) => {
      if (!isRecord(response) || !("token" in response)) {
        throw new WorkflowCoreContractError("workflow_core_gate_producer_token_bad_shape");
      }
      if (response.token === null) return null;
      const token = response.token;
      if (!isRecord(token)
        || typeof token.producerStepId !== "string"
        || typeof token.iterationIndex !== "number"
        || !Number.isInteger(token.iterationIndex)
        || typeof token.completedAt !== "string") {
        throw new WorkflowCoreContractError("workflow_core_gate_producer_token_bad_shape");
      }
      return {
        producerStepId: token.producerStepId,
        iterationIndex: token.iterationIndex,
        completedAt: token.completedAt,
      };
    },
  });
}

export function sameStructuralGateProducerTokenWithNodeFallback(
  left: StructuralGateProducerToken | null,
  right: StructuralGateProducerToken | null,
): Promise<boolean> {
  return runWithNodeFallback({
    subcommand: "same-producer-token",
    payload: () => ({ left, right }),
    fallback: () => sameStructuralGateProducerTokenNode(left, right),
    interpret: (response) => booleanField(response, "same", "workflow_core_same_producer_token"),
  });
}

export function isStructuralGateStepWithNodeFallback(
  step: StructuralGateStep | null | undefined,
): Promise<boolean> {
  return runWithNodeFallback({
    subcommand: "is-structural-gate",
    payload: () => ({ step }),
    fallback: () => isStructuralGateStepNode(step),
    interpret: (response) => booleanField(response, "isGate", "workflow_core_is_structural_gate"),
  });
}

export function getStructuralTopologyErrorsWithNodeFallback(
  steps: StructuralTopologyStep[],
): Promise<string[]> {
  return runWithNodeFallback({
    subcommand: "structural-topology-errors",
    payload: () => ({ steps }),
    fallback: () => getStructuralTopologyErrorsNode(steps),
    interpret: (response) =>
      stringArrayField(response, "errors", "workflow_core_structural_topology_errors"),
  });
}

const STEP_ELIGIBILITY_BLOCKERS: ReadonlySet<string> = new Set<StepEligibilityBlocker>(
  ["unsupported_status", "active_work", "executed_step", "external_effect_unknown", "control_tool_effects_unverified"],
);

/** `{steps:[…]}` 응답을 입력 순열로 되돌린다 — id 버킷 소비로 원본 identity·중복 id 를 보존한다. */
function permutedStepsResponse<T extends { id: string }>(steps: readonly T[], raw: unknown, reason: string): T[] {
  if (!Array.isArray(raw) || raw.length !== steps.length) {
    throw new WorkflowCoreContractError(`${reason}_bad_shape`);
  }
  const pool = new Map<string, T[]>();
  for (const step of steps) {
    const bucket = pool.get(step.id);
    if (bucket) bucket.push(step);
    else pool.set(step.id, [step]);
  }
  return raw.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string") {
      throw new WorkflowCoreContractError(`${reason}_bad_item`);
    }
    const step = pool.get(item.id)?.shift();
    if (!step) throw new WorkflowCoreContractError(`${reason}_unknown_step`);
    return step;
  });
}

export function checkStepEligibilityWithNodeFallback(
  history: StepHistory,
): Promise<StepEligibilityBlocker | null> {
  return runWithNodeFallback({
    subcommand: "check-step-eligibility",
    payload: () => ({ history }),
    fallback: () => checkStepEligibilityNode(history),
    interpret: (response) => {
      if (!isRecord(response) || !("blocker" in response)) {
        throw new WorkflowCoreContractError("workflow_core_step_eligibility_bad_shape");
      }
      const blocker = response.blocker;
      if (blocker === null) return null;
      if (typeof blocker !== "string" || !STEP_ELIGIBILITY_BLOCKERS.has(blocker)) {
        throw new WorkflowCoreContractError("workflow_core_step_eligibility_bad_shape");
      }
      return blocker as StepEligibilityBlocker;
    },
  });
}

export function sortWorkflowStepsByPriorityWithNodeFallback(
  steps: WorkflowStep[],
): Promise<WorkflowStep[]> {
  return runWithNodeFallback({
    subcommand: "sort-steps-by-priority",
    payload: () => ({ steps }),
    fallback: () => sortWorkflowStepsByPriorityNode(steps),
    interpret: (response) =>
      permutedStepsResponse(steps, isRecord(response) ? response.steps : undefined, "workflow_core_sorted_steps"),
  });
}
