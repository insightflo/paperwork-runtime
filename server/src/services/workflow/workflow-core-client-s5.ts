import {
  classifyStepActivation,
  type EdgeBearingStep,
  type PredFacts,
  type StepActivation,
} from "./control-flow/edge-condition.js";
import { runWithNodeFallback, WorkflowCoreContractError } from "./workflow-core-client.js";

/**
 * [목적] Stage 5 activate 서브커맨드의 Node 브리지 — classifyStepActivation 을 pass 당
 *   1 spawn 배치로 실행해 stepId → StepActivation 맵을 반환한다.
 *   workflow-core-client.ts 의 runWithNodeFallback/게이트/warn-once 계약을 그대로 재사용한다.
 * [주의] 시맨틱 에러는 이 서브커맨드에 없다 — Rust 응답은 {activations:[…]} 봉투뿐이며
 *   shape 불일치·개수 불일치·stepId echo 어긋남은 전부 계약 위반(WorkflowCoreContractError)으로
 *   TS fallback 대상이다. 응답 항목은 입력 순서 유지 계약이므로 index 로 매칭한 뒤 stepId echo 를
 *   교차 검증한다(순서만 믿으면 중간 누락을 못 잡는다).
 *   F4: 서브프로세스 스폰은 db.transaction 밖 async 호출자에서만 — 호출자가 보장한다.
 * [수정시 영향] 호출처: deadlock-reconciler.ts, runnable-step-wakeups-reconciler.ts,
 *   terminal-mission-workflow-continuation.ts(async 스탬프 경유). shape 검증을 느슨히 하면
 *   parity 를 깨뜨린 채 fallback 없이 흐른다.
 */

// 계약: {steps:[EdgeBearingStep…], preds:{stepId:PredFacts}} →
//   {activations:[{stepId,runnable,skippable,waiting}]} — 입력 순서 그대로.
// 반환 Map 은 stepId 기준 — 호출자는 임의 step 의 판정을 O(1) 조회한다.

export function activateStepsWithNodeFallback(
  steps: ReadonlyArray<EdgeBearingStep>,
  predsByStepId: ReadonlyMap<string, PredFacts>,
): Promise<Map<string, StepActivation>> {
  // TS 팔: 호출자가 per-step classify 하던 것과 동일한 결과를 Map 으로 제공한다.
  const fallback = () =>
    new Map<string, StepActivation>(
      steps.map((step) => [step.id, classifyStepActivation(step, predsByStepId)]),
    );
  // 빈 배치는 스폰 없이 즉시 반환 — 게이트가 열려 있어도 굳이 helper 를 부르지 않는다.
  if (steps.length === 0) return Promise.resolve(fallback());
  return runWithNodeFallback({
    subcommand: "activate",
    payload: () => ({ steps, preds: Object.fromEntries(predsByStepId) }),
    fallback,
    interpret: (response) => {
      const r = response as { activations?: unknown };
      if (!r || typeof r !== "object" || !Array.isArray(r.activations)
        || r.activations.length !== steps.length) {
        throw new WorkflowCoreContractError("workflow_core_activate_bad_shape");
      }
      const out = new Map<string, StepActivation>();
      r.activations.forEach((raw, index) => {
        const step = steps[index]!;
        const a = raw as {
          stepId?: unknown;
          runnable?: unknown;
          skippable?: unknown;
          waiting?: unknown;
        };
        if (!a || typeof a !== "object" || a.stepId !== step.id
          || typeof a.runnable !== "boolean"
          || typeof a.skippable !== "boolean"
          || typeof a.waiting !== "boolean") {
          throw new WorkflowCoreContractError("workflow_core_activate_bad_item");
        }
        out.set(step.id, { runnable: a.runnable, skippable: a.skippable, waiting: a.waiting });
      });
      return out;
    },
  });
}
