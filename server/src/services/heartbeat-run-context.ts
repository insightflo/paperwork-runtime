// server/src/services/heartbeat-run-context.ts
//
// [파일 목적] heartbeat.ts 에서 기계적 추출된 순수 컨텍스트 헬퍼군 — 동작 무변경.
//   런 contextSnapshot/payload 파생값 해석(빈 문자열 판정, taskKey 우선순위, 폴백 시도 회차,
//   에이전트 이름 정규화)만 담는다. DB·프로세스·시계 접근 없음 — 사이드 이펙트 없이 어디서든 재사용.
//
// [불변식]
//   - 모든 함수는 순수(입력→출력)여야 한다. DB·프로세스·시계 접근 금지.
//   - readNonEmptyString 은 trim 결과만 반환(빈 문자열·비문자열 → null).
//   - deriveTaskKey 의 우선순위(context taskKey→taskId→issueId, payload 동일 순서)는 디스패치
//     세대 앵커(heartbeat-retry-enqueue.ts 의 enqueue 함수들)와 계약을 공유한다 — 변경 금지.
//   - resolveAdapterFallbackAttempt 는 0 미만/비유한 값을 0 으로, normalizeAgentNameKey 는
//     trim+소문자 정규화 결과만 반환(heartbeat.ts 원본 극치와 동일).
//   - 각 함수는 heartbeat-core-client-s2a 의 opt-in Rust 시임을 먼저 시도한다 — 게이트
//     폐쇄·실패·비JSON 안전 입력이면 null 이 돌아와 아래 TS 본문이 그대로 실행된다.
import { asNumber, parseObject } from "../adapters/utils.js";
import type { heartbeatRuns } from "@paperclipai/db";
import { runContextViaRust } from "./heartbeat-core-client-s2a.js";

/** private TS 본문 — 공개 함수·내부 호출이 공유해 deriveTaskKey 가 매 키마다 스폰하지 않는다. */
function readNonEmptyStringTs(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readNonEmptyString(value: unknown): string | null {
  const viaRust = runContextViaRust({ value });
  if (viaRust !== null) return viaRust.readNonEmptyString;
  return readNonEmptyStringTs(value);
}

export function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  const viaRust = runContextViaRust({ contextSnapshot, payload });
  if (viaRust !== null) return viaRust.taskKey;
  return (
    readNonEmptyStringTs(contextSnapshot?.taskKey) ??
    readNonEmptyStringTs(contextSnapshot?.taskId) ??
    readNonEmptyStringTs(contextSnapshot?.issueId) ??
    readNonEmptyStringTs(payload?.taskKey) ??
    readNonEmptyStringTs(payload?.taskId) ??
    readNonEmptyStringTs(payload?.issueId) ??
    null
  );
}

export function resolveAdapterFallbackAttempt(contextRaw: unknown) {
  const viaRust = runContextViaRust({ contextRaw });
  if (viaRust !== null) return viaRust.fallbackAttempt;
  const context = parseObject(contextRaw);
  const parsed = Math.floor(asNumber(context.fallbackAttempt, 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function normalizeAgentNameKey(value: string | null | undefined) {
  const viaRust = runContextViaRust({ agentName: value });
  if (viaRust !== null) return viaRust.agentNameKey;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

export function isSameTaskScope(left: string | null, right: string | null) {
  const viaRust = runContextViaRust({ left, right });
  if (viaRust !== null) return viaRust.sameTaskScope;
  return (left ?? null) === (right ?? null);
}
