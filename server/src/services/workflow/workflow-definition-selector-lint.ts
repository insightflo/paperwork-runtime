/**
 * [목적] Workflow Definition 저장 직전(pre-save) 셀렉터 참조 lint. 순수 함수다 —
 * DB·네트워크·프로세스에 접근하지 않고 steps 입력만으로 warn-only 경고를 계산한다.
 * 실행 통제 권위가 아니다(규칙 8): 반환값은 응답 표시·로깅용이며 런타임 분기·재시도·
 * 승인 판정에 읽혀서는 안 된다.
 *
 * 검사 대상은 step.toolArgs 문자열(재귀) 안의 토큰 두 종류다:
 *   {$steps.<refStepId>.workProductPath} / {$steps.<refStepId>.siblingAssetsDir}
 *
 * 경고 코드(스텝 순 → 참조 첫 등장 순으로 결정적 정렬):
 *   - missing_upstream_step: 참조된 <refStepId> 가 steps 에 없다. 이 경우 이후 검사는
 *     생략한다(의존·셀렉터 규칙은 존재하는 upstream을 전제한다).
 *   - missing_dependency: ref 는 존재하지만 소비 스텝의 dependencies(직접+전이) 닫힘셋에 없다.
 *   - missing_work_product_selector: workProductPath 토큰을 참조하는데
 *     step.workProductSelectors[ref] 가 없다(siblingAssetsDir 단독 참조는 대상 아니다).
 *   - selector_type_mismatch_hint: 셀렉터가 title "content.json" 인데 type 이 "document" 가
 *     아니다. 내용 문서 셀렉터는 document 계열을 기대하는 운영 힌트다.
 */

export type WorkflowSelectorLintCode =
  | "missing_upstream_step"
  | "missing_dependency"
  | "missing_work_product_selector"
  | "selector_type_mismatch_hint";

export interface WorkflowSelectorLintWarning {
  stepId: string;
  referencedStepId: string;
  code: WorkflowSelectorLintCode;
  message: string;
}

/** lint 가 검사하는 토큰 문법 — step-artifact-references.ts 의 STEP_ARTIFACT_TOKEN 중
 * workProductDir 을 뺀 부분집합(workProductDir 참조는 이 lint 의 대상이 아니다). */
const SELECTOR_TOKEN = /\{\$steps\.([A-Za-z0-9_-]+)\.(workProductPath|siblingAssetsDir)\}/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type LintStep = {
  id: string;
  dependencies: string[];
  toolArgs: unknown;
  workProductSelectors: Record<string, unknown>;
};

/** steps: unknown 을 안전하게 정규화한다. 배열이 아니거나 개별 항목이 id 없는 레코드가
 * 아니면 그 항목을 조용히 건너뛴다(throw 금지 계약). */
function readLintSteps(steps: unknown): LintStep[] {
  if (!Array.isArray(steps)) return [];
  const result: LintStep[] = [];
  for (const raw of steps) {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) continue;
    result.push({
      id: raw.id,
      dependencies: Array.isArray(raw.dependencies)
        ? raw.dependencies.filter((dep): dep is string => typeof dep === "string")
        : [],
      toolArgs: raw.toolArgs,
      workProductSelectors: isRecord(raw.workProductSelectors) ? raw.workProductSelectors : {},
    });
  }
  return result;
}

/** toolArgs 를 DFS 로 순회하며 문자열 안의 셀렉터 토큰 (ref, tokenKind) 을 수집한다.
 * 반환: ref 첫 등장 순서 배열과 ref 별 토큰 종류 집합. */
function collectSelectorReferences(
  value: unknown,
  order: string[],
  kindsByRef: Map<string, Set<string>>,
  visited: WeakSet<object>,
): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(SELECTOR_TOKEN)) {
      const ref = match[1];
      const kind = match[2] as "workProductPath" | "siblingAssetsDir";
      if (!ref) continue;
      let kinds = kindsByRef.get(ref);
      if (!kinds) {
        kinds = new Set();
        kindsByRef.set(ref, kinds);
        order.push(ref);
      }
      kinds.add(kind);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSelectorReferences(item, order, kindsByRef, visited);
    return;
  }
  if (isRecord(value)) {
    if (visited.has(value)) return; // 순환 참조 방어(JSON 경로에서는 없지만 unknown 계약 방어)
    visited.add(value);
    for (const item of Object.values(value)) collectSelectorReferences(item, order, kindsByRef, visited);
  }
}

/** 소비 스텝에서 dependencies 간선(직접+전이)으로 도달 가능한 스텝 id 집합. */
function dependencyClosure(step: LintStep, byId: Map<string, LintStep>): Set<string> {
  const visited = new Set<string>([step.id]);
  const stack = [...step.dependencies];
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const next = byId.get(id);
    if (next) stack.push(...next.dependencies);
  }
  return visited;
}

/** [산출물 소비 하드닝] 정의 저장 전 셀렉터 참조 경고 계산. 결정적 순서, throw 금지(non-throwing). */
export function lintWorkflowDefinitionSelectors(steps: unknown): WorkflowSelectorLintWarning[] {
  const lintSteps = readLintSteps(steps);
  const warnings: WorkflowSelectorLintWarning[] = [];
  const byId = new Map(lintSteps.map((step) => [step.id, step]));

  for (const step of lintSteps) {
    const order: string[] = [];
    const kindsByRef = new Map<string, Set<string>>();
    collectSelectorReferences(step.toolArgs, order, kindsByRef, new WeakSet());
    if (order.length === 0) continue;
    const closure = dependencyClosure(step, byId);

    for (const referencedStepId of order) {
      const kinds = kindsByRef.get(referencedStepId)!;
      if (!byId.has(referencedStepId)) {
        const kind = kinds.values().next().value as string;
        warnings.push({
          stepId: step.id,
          referencedStepId,
          code: "missing_upstream_step",
          message: `Step "${step.id}" references {$steps.${referencedStepId}.${kind}} but no step with id "${referencedStepId}" exists in the workflow definition.`,
        });
        continue;
      }
      if (!closure.has(referencedStepId)) {
        warnings.push({
          stepId: step.id,
          referencedStepId,
          code: "missing_dependency",
          message: `Step "${step.id}" references {$steps.${referencedStepId}} but "${referencedStepId}" is not in its dependencies (direct or transitive).`,
        });
      }
      const selector = step.workProductSelectors[referencedStepId];
      const selectorOk = isRecord(selector);
      if (kinds.has("workProductPath") && !selectorOk) {
        warnings.push({
          stepId: step.id,
          referencedStepId,
          code: "missing_work_product_selector",
          message: `Step "${step.id}" references {$steps.${referencedStepId}.workProductPath} but has no workProductSelectors entry for "${referencedStepId}".`,
        });
      }
      if (selectorOk && selector.title === "content.json" && selector.type !== "document") {
        warnings.push({
          stepId: step.id,
          referencedStepId,
          code: "selector_type_mismatch_hint",
          message: `Step "${step.id}" selects "${referencedStepId}" with title "content.json" and type "${String(selector.type)}"; content.json selectors are expected to use type "document".`,
        });
      }
    }
  }
  return warnings;
}
