import { parseObject } from "../adapters/utils.js";
import { readNonEmptyString } from "./heartbeat-run-context.js";
import { sessionResetViaRust } from "./heartbeat-core-client-s2b.js";

// TS 본문 — Rust 폴백 경로가 이 함수들을 직접 쓴다(폴백 시 이중 스폰 방지).
function hasWorkflowQaReworkContractTs(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const reworkContract = parseObject(contextSnapshot?.paperclipWorkflowReworkContract);
  return readNonEmptyString(reworkContract.kind) === "workflow_qa_rework";
}

function shouldResetTaskSessionForWakeTs(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;
  if (hasWorkflowQaReworkContractTs(contextSnapshot)) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (
    wakeReason === "issue_assigned" ||
    wakeReason === "mission_owner_planning_issue_created" ||
    wakeReason === "mission_unblock_action_created" ||
    wakeReason === "mission_unblock_action_stalled"
  ) return true;
  return false;
}

function describeSessionResetReasonTs(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return "forceFreshSession was requested";
  if (hasWorkflowQaReworkContractTs(contextSnapshot)) return "workflow QA rework requires a fresh session";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  if (wakeReason === "mission_unblock_action_created") return "wake reason is mission_unblock_action_created";
  if (wakeReason === "mission_unblock_action_stalled") return "wake reason is mission_unblock_action_stalled";
  return null;
}

// [wiring] PAPERCLIP_HEARTBEAT_CORE_BIN 이 절대경로로 설정되면 crates/heartbeat-core 의
// session-reset 시임이 3 함수의 계산을 대신한다. 시임 실패(non-zero/비JSON/shape 불량)면
// 위 TS 본문으로 조용히 폴백한다 — 호출부 시그니처와 관측 동작은 불변. describe 의 null 은
// "사유 없음"의 정상 결과(mission_owner_planning_issue_created 리셋 비대칭 포함)이고,
// 번들 반환 null 만이 폴백 신호다. TS 비대칭("리셋은 되지만 사유 서술은 null")은 Rust 포트가
// 그대로 미러링하며 전수 parity 는 heartbeat-core-stage2-parity 테스트가 담당한다.
export function hasWorkflowQaReworkContract(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const viaRust = sessionResetViaRust(contextSnapshot);
  if (viaRust !== null) return viaRust.hasQaReworkContract;
  return hasWorkflowQaReworkContractTs(contextSnapshot);
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const viaRust = sessionResetViaRust(contextSnapshot);
  if (viaRust !== null) return viaRust.shouldReset;
  return shouldResetTaskSessionForWakeTs(contextSnapshot);
}

export function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const viaRust = sessionResetViaRust(contextSnapshot);
  if (viaRust !== null) return viaRust.reason;
  return describeSessionResetReasonTs(contextSnapshot);
}
