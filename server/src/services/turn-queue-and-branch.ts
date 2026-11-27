/**
 * Turn Queue Control, Mid-Turn Steer Gate, Session Branching & Context Usage Gauge
 *
 * [범위] Stage 30 Wave C/D 서버 프리미티브 — 순수 함수 계층. DB·네트워크·프로세스에
 *   접속하지 않고 큐 편집/재정렬/사이드태스크 분리, 턴 중간 steer 게이트, 체크포인트
 *   브랜칭, 컨텍스트 사용량 게이지 판정만 담당한다.
 *
 * [설계 배경] OpenBot QueuePanel / queue-edit-v1 / acp-session-steering /
 *   010-branch-a-conversation / context-usage-v1 준용.
 *
 * [불변식]
 *   - #personTurn: 에이전트는 사람(user)이 시작한 턴을 중간에 steer할 수 없다 —
 *     거부 시 조용히 큐 적재(fallbackAction: "queue")로 fail-closed 처리한다.
 *   - 큐 연산은 원본 배열을 절대 변이하지 않는다(immutable).
 *   - 빈 본문 편집은 거부한다(fail-closed).
 *   - 대상 항목이 없는 연산은 원본을 그대로 돌려준다(no-op / null).
 */

export interface QueuedTurnItem {
  id: string;
  actorType: "user" | "agent";
  body: string;
  createdAtMs: number;
  sideTaskId?: string | null;
}

export type QueueActorType = QueuedTurnItem["actorType"];

export interface MidTurnSteerInput {
  activeTurnActorType: QueueActorType;
  steerActorType: QueueActorType;
  adapterSupportsSteer: boolean;
}

export interface MidTurnSteerVerdict {
  allowed: boolean;
  fallbackAction: "queue" | "steer";
  reason: "ok" | "adapter_steer_unsupported" | "person_turn_protected";
}

export interface SideTaskSplit<T extends QueuedTurnItem> {
  mainQueue: T[];
  sideTaskItem: T;
}

export interface ContextUsageInput {
  usedTokens: number;
  maxTokens: number;
  compactThresholdPct?: number;
}

export interface ContextUsageVerdict {
  usedPct: number;
  shouldCompact: boolean;
  severity: "ok" | "warn" | "critical";
}

export const CONTEXT_COMPACT_DEFAULT_THRESHOLD_PCT = 80;
export const CONTEXT_COMPACT_CRITICAL_PCT = 92;

export function reorderQueueItem<T extends QueuedTurnItem>(items: readonly T[], id: string, toIndex: number): T[] {
  const fromIndex = items.findIndex((candidate) => candidate.id === id);
  if (fromIndex < 0) return items.slice(); // 대상 없음 → 내용 동일한 사본(no-op)
  // 범위 밖 목표 인덱스는 0..length-1로 클램프한다(경계 편향 없이 가장 가까운 유효 위치).
  const clamped = Math.min(Math.max(toIndex, 0), items.length - 1);
  const next = items.slice();
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return items.slice(); // 방어: 길이 1 스플라이스가 실패하는 경우는 없어야 한다
  const insertAt = Math.min(Math.max(clamped, 0), next.length);
  next.splice(insertAt, 0, moved);
  return next;
}

export function editQueueItem<T extends QueuedTurnItem>(items: readonly T[], id: string, nextBody: string): T[] {
  // 빈 본문은 거부한다(fail-closed) — 큐 항목은 사람·에이전트 양쪽 소비자가 읽는다.
  if (!nextBody || !nextBody.trim()) {
    throw new Error("queue_edit_empty_body");
  }
  const index = items.findIndex((candidate) => candidate.id === id);
  if (index < 0) return items.slice(); // 대상 없음 → 내용 동일한 사본(no-op)
  const next = items.slice();
  const target = next[index]!;
  next[index] = { ...target, body: nextBody };
  return next;
}

export function splitQueueItemToSideTask<T extends QueuedTurnItem>(
  items: readonly T[],
  id: string,
  sideTaskId: string,
): SideTaskSplit<T> | null {
  const index = items.findIndex((candidate) => candidate.id === id);
  if (index < 0) return null; // 대상 없음 → 분리 불가, null로 fail-closed
  const target = items[index]!;
  return {
    mainQueue: items.filter((candidate) => candidate.id !== id),
    sideTaskItem: { ...target, sideTaskId },
  };
}

export function evaluateMidTurnSteer(input: MidTurnSteerInput): MidTurnSteerVerdict {
  // 어댑터가 steer를 지원하지 않으면 선택지 자체가 없다 — 큐 적재로 강등.
  if (!input.adapterSupportsSteer) {
    return { allowed: false, fallbackAction: "queue", reason: "adapter_steer_unsupported" };
  }
  // #personTurn 불변식: 사람이 시작한 턴은 에이전트가 중간에 끼어들 수 없다.
  if (input.activeTurnActorType === "user" && input.steerActorType === "agent") {
    return { allowed: false, fallbackAction: "queue", reason: "person_turn_protected" };
  }
  return { allowed: true, fallbackAction: "steer", reason: "ok" };
}

export function branchTimelineAtCheckpoint<T extends { id: string }>(
  messages: readonly T[],
  checkpointMessageId: string,
): { branchMessages: T[]; truncatedCount: number } | null {
  const index = messages.findIndex((message) => message.id === checkpointMessageId);
  if (index < 0) return null; // 체크포인트 없음 → 브랜치 생성 불가
  // 분기 지점은 체크포인트 메시지까지 포함하고, 그 뒷부분은 절단으로 센다.
  return {
    branchMessages: messages.slice(0, index + 1),
    truncatedCount: messages.length - (index + 1),
  };
}

export function evaluateContextUsage(input: ContextUsageInput): ContextUsageVerdict {
  const thresholdPct = input.compactThresholdPct ?? CONTEXT_COMPACT_DEFAULT_THRESHOLD_PCT;
  // maxTokens <= 0 → 산정 불가. 무한/NaN 대신 만땅·critical로 fail-closed 처리한다.
  const usedPct = input.maxTokens > 0 ? Math.round((input.usedTokens / input.maxTokens) * 100) : 100;
  const shouldCompact = usedPct >= thresholdPct;
  // critical(>=92%)은 사용자 임계와 무관하게 우선 판정한다.
  const severity = usedPct >= CONTEXT_COMPACT_CRITICAL_PCT ? "critical" : usedPct >= thresholdPct ? "warn" : "ok";
  return { usedPct, shouldCompact, severity };
}
