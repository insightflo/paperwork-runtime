/**
 * [purpose] Fail-closed workflow step output gate (RES-12860 fake-done fix).
 *   워크플로 단계 이슈의 실행이 성공으로 끝났지만 이번 실행이 work product를 하나도
 *   등록하지 않았을 때, 그 단계가 산출물 계약(designated output directory 블록 또는
 *   후속 step의 `$steps.<stepId>.workProduct` 소비)을 가지면 자동 완료를 보류한다.
 *   0건일 때도 계약을 강제하는 것이 이 gate의 핵심이다 — 산출물이 이미 있는 경우의
 *   후속 무변화 실행 차단(hasAnyProduct && !thisRunRegistered)은 기존 동작을 100% 보존한다.
 *   순수 헬퍼만 두고 DB 접근·상태 변경은 heartbeat 훅이 담당한다.
 */

/** 실행 프롬프트 계약 헤더 — work-products/artifact-registration-instructions.ts 가 주입하는 표준 블록. */
const DELIVERABLE_OUTPUT_HEADER = "Deliverable output (use exactly this directory):";

/**
 * [input] 이슈 본문(실행 프롬프트). [output] 계약 블록의 절대 출력 디렉토리, 없으면 null.
 * 블록 다음 줄이 `- <path>` 형태여야 하고 절대 경로(`/` 시작)만 인정한다 — 상대 경로·
 * 없는 블록은 계약으로 인정하지 않아 false positive 자동 완료 보류를 막는다.
 */
export function extractDeliverableOutputDir(issueDescription: string | null | undefined): string | null {
  if (!issueDescription) return null;
  const headerIndex = issueDescription.indexOf(DELIVERABLE_OUTPUT_HEADER);
  if (headerIndex < 0) return null;
  const afterHeader = issueDescription.slice(headerIndex + DELIVERABLE_OUTPUT_HEADER.length);
  const dirLine = /^[ \t]*\r?\n[ \t]*-[ \t]*(.*)/.exec(afterHeader);
  if (!dirLine) return null;
  const dir = dirLine[1].trim();
  return dir.startsWith("/") ? dir : null;
}

/**
 * [input] 워크플로 정의 스냅샷(`{ steps: [...] }`), 판단 대상 stepId.
 * [output] 이 step의 산출물을 다른 step이 소비하는지 또는 step 자체에 산출물 계약 필드가 있는지.
 * 소비 판정은 다른 step의 input/toolArgs/args/dependsOn 안에 직렬화된 `$steps.<stepId>.`
 * 토큰으로만 한다 — `$steps.` 접두 없는 단순 dependsOn id는 일반 DAG 의존이므로 소비로
 * 보지 않는다(비산출물 일반 step의 기존 자동 완료를 깨지 않기 위함).
 */
export function stepHasDownstreamWorkProductConsumer(definitionSnapshot: unknown, stepId: string): boolean {
  const steps = definitionSnapshot != null && typeof definitionSnapshot === "object"
    ? (definitionSnapshot as { steps?: unknown }).steps
    : null;
  if (!Array.isArray(steps) || !stepId) return false;
  const consumptionToken = `$steps.${stepId}.`;
  for (const step of steps) {
    if (step == null || typeof step !== "object") continue;
    const record = step as Record<string, unknown>;
    if (record.id !== stepId) continue;
    // step 자신이 산출물 계약 필드를 선언하면 이 step이 산출물을 내야 한다(선언 그 자체가 계약).
    if (record.workProductContract != null || record.expectedOutputs != null || record.deliverable != null) {
      return true;
    }
    return [...steps].some((other) => {
      if (other == null || typeof other !== "object" || other === step) return false;
      const otherRecord = other as Record<string, unknown>;
      let serialized: string;
      try {
        serialized = JSON.stringify([otherRecord.input, otherRecord.toolArgs, otherRecord.args, otherRecord.dependsOn]) ?? "";
      } catch {
        return false;
      }
      return serialized.includes(consumptionToken);
    });
  }
  return false;
}

export type WorkflowStepAutoCompleteVerdict = {
  defer: boolean;
  reason: "follow_up_without_new_evidence" | "missing_required_step_deliverable" | null;
  expectedOutputDir: string | null;
};

/**
 * [input] heartbeat의 완료 판단 재료(등록 산출물 유무, 이번 실행 등록 여부, 이슈 본문,
 * linked step의 stepId, 워크플로 정의 스냅샷). [output] 자동 완료 보류 여부와 구조화 사유.
 * - 산출물이 있고 이번 실행이 새로 등록한 게 없으면 기존 follow_up 차단을 그대로 반환한다.
 * - 산출물이 0건일 때는 계약(디렉토리 블록 또는 후속 소비)이 있을 때만 보류한다 —
 *   계약 없는 일반 step의 자동 완료는 기존 동작 유지다.
 */
export function shouldDeferWorkflowStepAutoComplete(input: {
  hasAnyProduct: boolean;
  thisRunRegistered: boolean;
  issueDescription?: string | null;
  stepId?: string | null;
  definitionSnapshot?: unknown;
}): WorkflowStepAutoCompleteVerdict {
  const expectedOutputDir = extractDeliverableOutputDir(input.issueDescription);
  if (input.hasAnyProduct && !input.thisRunRegistered) {
    return { defer: true, reason: "follow_up_without_new_evidence", expectedOutputDir };
  }
  if (!input.hasAnyProduct && !input.thisRunRegistered) {
    const consumed = input.stepId != null
      && stepHasDownstreamWorkProductConsumer(input.definitionSnapshot, input.stepId);
    if (expectedOutputDir !== null || consumed) {
      return { defer: true, reason: "missing_required_step_deliverable", expectedOutputDir };
    }
  }
  return { defer: false, reason: null, expectedOutputDir: null };
}
