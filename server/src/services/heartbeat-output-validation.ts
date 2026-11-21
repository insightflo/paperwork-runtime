import { outputValidationViaRust } from "./heartbeat-core-client-s2b.js";

// TS 본문 — Rust 폴백 경로가 이 함수를 직접 쓴다(폴백 시 이중 스폰 방지).
function canApplyMissingWorkProductRegistrationGateTs(issue: {
  originKind: string | null;
  title?: string | null;
  description?: string | null;
}, stepRunRequiresWorkProduct?: boolean) {
  if (issue.originKind === "mission_main_executor_plan") return false;
  if (issue.originKind === "mission_main_executor_oversight") return false;
  if (issue.originKind === "mission_main_executor_unblock") return false;

  // workflow step의 명시 graphWorkProductRequired 플래그(workflow_step_runs.metadata에 stamp)가
  // 권위 source. present면 title/contract 휴리스틱을 무시한다.
  if (stepRunRequiresWorkProduct === true) return true;
  if (stepRunRequiresWorkProduct === false) return false;

  // Legacy fallback: 플래그 미스탬프 step-run(pre-deploy / 미동기화)용 종래 휴리스틱.
  const title = issue.title?.trim() ?? "";
  if (/\b(lead|approval|approve|audit|auditor|validator|validation|validate|verify|QA|review|check)\b/iu.test(title)) return false;
  if (hasDeliverableOutputContract(issue.description)) return true;
  return (
    /\b(synthesi[sz]e|synthesis|generate|produce|create|draft|artifact|document|note|infographic|export|deliver|html|pdf|report)\b/iu.test(title) ||
    /(작성|생성|제작|산출물|문서|자료|보고서|리포트|HTML|PDF)/u.test(title)
  );
}

function hasDeliverableOutputContract(description: string | null | undefined) {
  const text = description?.trim() ?? "";
  return text.includes("Deliverable output (use exactly this directory)") && /`?\[?ARTIFACT\]?`?\s*:/iu.test(text);
}

function resolveStepRunRequiresWorkProductTs(metadata: unknown): boolean | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).graphWorkProductRequired;
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

// [wiring] PAPERCLIP_HEARTBEAT_CORE_BIN 이 절대경로로 설정되면 crates/heartbeat-core 의
// output-validation 시임이 gate 판정을 대신한다. 시임 실패(non-zero — issue.title 이 number
// 등 TS-throw 미러, lone surrogate 의 serde 거부 포함/비JSON/shape 불량)면 위 TS 본문으로
// 조용히 폴백한다 — 호출부 시그니처와 관측 동작(throw 포함)은 불변.
export function canApplyMissingWorkProductRegistrationGate(issue: {
  originKind: string | null;
  title?: string | null;
  description?: string | null;
}, stepRunRequiresWorkProduct?: boolean) {
  const viaRust = outputValidationViaRust({ issue, stepRunRequiresWorkProduct });
  if (viaRust !== null) return viaRust.gate;
  return canApplyMissingWorkProductRegistrationGateTs(issue, stepRunRequiresWorkProduct);
}

/**
 * workflow_step_runs.metadata 에서 graphWorkProductRequired 플래그를 3상으로 판정.
 * - true  → 명시 산출물 step (gate 발동)
 * - false → 명시 비산출물 step (gate 스킵, 휴리스틱도 무시)
 * - undefined → 필드 미스탬프(legacy row / metadata={} / non-boolean) → 종래 휴리스틱 fallback
 * buildWorkflowStepRunMetadata 가 항상 boolean 으로 stamp 하므로 non-boolean은 undefined 취급(legacy 호환).
 *
 * [wiring] Rust output-validation 시임은 issue 를 필수로 요구하므로 gate 계산에 영향을 줄 수
 * 없는 빈 issue({}) 를 실어 보낸다. stepRequires 는 metadata.graphWorkProductRequired 가
 * boolean 으로 stamp 된 경우만 응답에 나오고 — absent(undefined) 는 "미스탬프"의 정상 Rust
 * 결과이며, 번들 반환 null 만이 폴백 신호다(non-JSON-safe metadata(BigInt 등)는 직렬화 가드로
 * TS 로 간다).
 */
export function resolveStepRunRequiresWorkProduct(metadata: unknown): boolean | undefined {
  const viaRust = outputValidationViaRust({ issue: {}, metadata });
  if (viaRust !== null) return viaRust.stepRequires;
  return resolveStepRunRequiresWorkProductTs(metadata);
}
