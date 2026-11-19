import { eq } from "drizzle-orm";
import { toolDefinitions, type Db } from "@paperclipai/db";
import type { WorkflowStep } from "../dag-engine.js";
import { hashStructuredValue } from "../../issue-execution-cards/hash.js";
import {
  REVIEWED_RESUME_POLICIES,
  type ReviewedResumePolicy,
  type ReviewedResumePolicyToolBinding,
} from "./reviewed-policy.js";

/**
 * [파일 목적] Task6a preview policy 해석 — REVIEWED_RESUME_POLICIES 에서 (companyId,
 *   definitionHash) 유일 매치를 찾고, 현재 toolDefinitions registry 행과 정확 대조해
 *   affected step 의 effect 를 확정한다. 검토 매니페스트가 유일한 effect 권위다.
 * [불변식]
 *   - 도구 이름 allowlist/prose/env/client 로 effect 를 추론하지 않는다. manifest 도구 효과
 *     추론이 아니라 "검토된 그래프 + 정확한 live registry binding" 이 권위다.
 *   - 매칭 키: exact (companyId, definitionHash) 가 우선이다. definitionHash 는 해시
 *     payload 에 workflowRunId·provenance 를 포함해 run 마다 유일하므로(2026-11-15 실증 —
 *     동일 steps 라도 run 이 다르면 해시가 다르다), stepsHash 를 선언한 엔트리는
 *     resumeStepsHash({executionMode, steps}) 로 동일 그래프 형태의 모든 run 에 적용된다.
 *     두 경로 모두 유일 매치(0 또는 2+ 포함)가 아니면 policy 부재로 fail-closed 한다.
 *   - binding 해석: id/updatedAt(ISO)/configHash/enabled=true 전부 현재 행과 정확 일치해야
 *     한다. 하나라도 어기면 그 step effect 는 unknown 으로 실패한다(same-name 다른-config 행도
 *     거부된다 — configHash 대조).
 *   - policy 부재: complete 노드이면서 toolName/toolNames/tools/conditionGroup 이 전부 없는
 *     경우에만 effect 'none'. 그 외 전부 unknown. 그리고 policy 부재는 항상 전역
 *     external_effect_unknown blocker 를 만든다(미검토 publication/gate 매핑 차단).
 *   - registry 행/policy 는 factsHash 원천이며 preview 응답으로 설정/시크릿을 노출하지 않는다.
 */

export type ResumedStepEffect = "none" | "read_only" | "external" | "unknown";

export interface ResumedPolicyView {
  policy: ReviewedResumePolicy | null;
  registryRows: (typeof toolDefinitions.$inferSelect)[];
  policyMissing: boolean;
}

/** 현재 registry 전체 행(company scope, id 오름차순)과 매치 policy 를 조회한다.
 *  definition 은 재개 대상 run 의 frozen 실행정의다(definitionHash/executionMode/steps). */
export async function loadResumedPolicy(
  tx: Pick<Db, "select">,
  companyId: string,
  definition: { definitionHash: string; executionMode: string; steps: unknown[] },
): Promise<ResumedPolicyView> {
  const registryRows = await tx.select().from(toolDefinitions)
    .where(eq(toolDefinitions.companyId, companyId))
    .orderBy(toolDefinitions.id);
  const scoped = REVIEWED_RESUME_POLICIES.filter((policy) =>
    policy.schemaVersion === 1 && policy.companyId === companyId);
  const byRun = scoped.filter((policy) => policy.definitionHash === definition.definitionHash);
  const byShape = byRun.length === 1 ? byRun : scoped.filter((policy) =>
    policy.stepsHash !== undefined && policy.stepsHash === resumeStepsHash(definition));
  if (byShape.length !== 1) {
    // 0 개 = 미검토, 2 개 이상 = 모순된 매니페스트 — 둘 다 policy 부재로 fail-closed.
    return { policy: null, registryRows, policyMissing: true };
  }
  return { policy: byShape[0]!, registryRows, policyMissing: false };
}

/** 그래프 형태 안정 해시 — workflowRunId/provenance 제외. capture 저장 steps(jsonb)와
 *  동일 값으로 계산하면 동일 정의 버전의 모든 run 이 같은 해시를 갖는다. */
export function resumeStepsHash(definition: { executionMode: string; steps: unknown[] }): string {
  return hashStructuredValue({ executionMode: definition.executionMode, steps: definition.steps });
}

function registryBindingHash(row: typeof toolDefinitions.$inferSelect): string {
  return hashStructuredValue({
    name: row.name,
    enabled: row.enabled,
    adapterType: row.adapterType,
    adapterConfig: row.adapterConfig,
    inputSchema: row.inputSchema,
  });
}

// [주의] scripts/resume-policy-bindings.ts 가 이 파일의 resumeStepsHash 와 hash 규칙을
//   import 해 재사용한다 — registryBindingHash/stepsHash 규칙을 바꾸면 스크립트 검증도
//   함께 갱신해야 한다(바인딩 채취·검증은 스크립트가 단일 소스다).

/** binding 이 현재 registry 행과 정확히 resolve 되는가(id/updatedAt/configHash/enabled). */
export function bindingResolves(
  binding: ReviewedResumePolicyToolBinding,
  registryRows: (typeof toolDefinitions.$inferSelect)[],
): boolean {
  if (typeof binding.id !== "string" || typeof binding.updatedAt !== "string"
    || typeof binding.configHash !== "string") {
    return false;
  }
  const row = registryRows.find((candidate) => candidate.id === binding.id);
  if (!row || row.enabled !== true) return false;
  if (row.updatedAt.toISOString() !== binding.updatedAt) return false;
  return registryBindingHash(row) === binding.configHash;
}

/** complete 노드이며 도구/조건 잔존이 전혀 없는 경우만 policy 부재에서 'none' 이 된다. */
function noneEligibleWithoutPolicy(step: WorkflowStep): boolean {
  return step.type === "complete"
    && step.toolName === undefined
    && step.toolNames === undefined
    && step.tools === undefined
    && step.conditionGroup === undefined;
}

/** frozen step 하나의 effect 확정 — manifest effect + 정확 binding 대조. */
export function effectForStep(
  step: WorkflowStep,
  view: ResumedPolicyView,
): ResumedStepEffect {
  if (view.policy === null) {
    return noneEligibleWithoutPolicy(step) ? "none" : "unknown";
  }
  const declared = view.policy.steps[step.id];
  if (!declared) return "unknown";
  if (declared.effect !== "none" && declared.effect !== "read_only" && declared.effect !== "external") {
    return "unknown";
  }
  for (const binding of declared.toolBindings) {
    if (!bindingResolves(binding, view.registryRows)) return "unknown";
  }
  return declared.effect;
}

/** 승인 필수 step 목록 — required gates + publication(중복 제거, 사전순). */
export function approvalRequiredStepIds(policy: ReviewedResumePolicy | null): string[] {
  if (policy === null) return [];
  return [...new Set([...policy.requiredGateStepIds, ...policy.publicationStepIds])].sort();
}

/** generation 발생 가능성 — policy 부재는 가능성 있음으로 보고한다(conservative). */
export function generationPossible(
  policy: ReviewedResumePolicy | null,
  affectedStepIds: string[],
): boolean {
  if (policy === null) return true;
  const generation = new Set(policy.generationStepIds);
  return affectedStepIds.some((stepId) => generation.has(stepId));
}
