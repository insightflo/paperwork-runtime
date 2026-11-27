// server/src/services/routine-quiet-and-outbox.ts
// [Quiet Routine + External Delivery Outbox] 실행 프리미티브 두 가지(순수 in-memory).
// 1) routine_no_update 정적 판정: 구조화 신호(explicitNoUpdateSignal)만 본다 —
//    산문/코멘트 파싱은 금지(저장소 실행-권한 불변식). 조건이 하나라도 어긋나면 quiet=false(fail-closed).
// 2) 크래시-안전 외부 전송 아웃박스: pending → sending → sent | failed | uncertain.
//    부팅 복구 시 sending 은 uncertain 으로만 간다(절대 pending 복귀 금지) — 크래시/재시작 뒤
//    외부 메시지가 이중 전송되지 않게 하는 안티-중복 불변식. uncertain 은 자동 재시도 대상이 아니다.

import { randomUUID } from "node:crypto";

export type OutboxStatus = "pending" | "sending" | "sent" | "failed" | "uncertain";

export interface RoutineQuietRunInput {
  explicitNoUpdateSignal?: boolean;
  changedArtifactCount: number;
  createdAlertCount: number;
}

export interface RoutineQuietRunVerdict {
  quiet: boolean;
  suppressExternalNotify: boolean;
  suppressDownstreamFlow: boolean;
}

export interface ExternalDeliveryMessage {
  id: string;
  idempotencyKey: string;
  companyId: string;
  channel: string;
  payload: unknown;
  status: OutboxStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalDeliveryEnqueueInput {
  idempotencyKey: string;
  companyId: string;
  channel: string;
  payload: unknown;
}

export interface ExternalDeliveryOutbox {
  enqueue(input: ExternalDeliveryEnqueueInput): ExternalDeliveryMessage;
  get(id: string): ExternalDeliveryMessage | null;
  beginSending(id: string): ExternalDeliveryMessage;
  markSent(id: string): ExternalDeliveryMessage;
  markFailed(id: string, error: unknown): ExternalDeliveryMessage;
  recoverInterruptedOnBoot(): number;
  canAutoRetry(id: string): boolean;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function evaluateRoutineQuietRun(input: RoutineQuietRunInput): RoutineQuietRunVerdict {
  // 구조화 신호만: 문자열 "true" 같은 강제 변환도 절대 quiet 이 아니다.
  const explicitSignal = input.explicitNoUpdateSignal === true;
  const countsValid = isNonNegativeInteger(input.changedArtifactCount) && isNonNegativeInteger(input.createdAlertCount);
  const quiet = explicitSignal && countsValid && input.changedArtifactCount === 0 && input.createdAlertCount === 0;
  return { quiet, suppressExternalNotify: quiet, suppressDownstreamFlow: quiet };
}

export function createExternalDeliveryOutbox(): ExternalDeliveryOutbox {
  const messagesById = new Map<string, ExternalDeliveryMessage>();
  const idsByIdempotencyKey = new Map<string, string>();

  function nowIso(): string {
    return new Date().toISOString();
  }

  function requireMessage(id: string): ExternalDeliveryMessage {
    const message = messagesById.get(id);
    if (!message) throw new Error(`outbox message not found: ${id}`);
    return message;
  }

  function assertNonEmpty(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${label} must be a non-empty string`);
    }
    return value;
  }

  function update(message: ExternalDeliveryMessage, status: OutboxStatus, lastError: string | null): ExternalDeliveryMessage {
    const updated: ExternalDeliveryMessage = { ...message, status, lastError, updatedAt: nowIso() };
    messagesById.set(updated.id, updated);
    return { ...updated };
  }

  return {
    enqueue(input) {
      const idempotencyKey = assertNonEmpty(input.idempotencyKey, "idempotencyKey");
      const companyId = assertNonEmpty(input.companyId, "companyId");
      const channel = assertNonEmpty(input.channel, "channel");
      const existingId = idsByIdempotencyKey.get(idempotencyKey);
      // dedup — 같은 키면 기존 레코드를 그대로 반환한다(중복 생성 없음).
      if (existingId) return { ...messagesById.get(existingId)! };
      const now = nowIso();
      const message: ExternalDeliveryMessage = {
        id: randomUUID(),
        idempotencyKey,
        companyId,
        channel,
        payload: input.payload,
        status: "pending",
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      messagesById.set(message.id, message);
      idsByIdempotencyKey.set(idempotencyKey, message.id);
      return { ...message };
    },

    get(id) {
      return messagesById.get(id) ?? null;
    },

    beginSending(id) {
      const message = requireMessage(id);
      // 재진입 허용은 pending(최초)과 failed(재시도)뿐. sent/uncertain 재전송 금지,
      // sending 재시작도 금지(이중 begin 방지).
      if (message.status !== "pending" && message.status !== "failed") {
        throw new Error(`beginSending requires a pending or failed row, got "${message.status}"`);
      }
      return update(message, "sending", message.lastError);
    },

    markSent(id) {
      const message = requireMessage(id);
      if (message.status !== "sending") {
        throw new Error(`markSent requires a sending row, got "${message.status}"`);
      }
      return update(message, "sent", null);
    },

    markFailed(id, error) {
      const message = requireMessage(id);
      if (message.status !== "sending") {
        throw new Error(`markFailed requires a sending row, got "${message.status}"`);
      }
      const text = error instanceof Error ? error.message : String(error);
      return update(message, "failed", assertNonEmpty(text, "error"));
    },

    recoverInterruptedOnBoot() {
      // 크래시/재시작 복구: sending 으로 남아 있던 행은 uncertain 으로만 간다.
      // pending 복귀는 재전송 위험을 만들므로 금지(안티-중복 불변식).
      let recovered = 0;
      for (const message of messagesById.values()) {
        if (message.status === "sending") {
          update(message, "uncertain", "interrupted: delivery outcome unknown after restart");
          recovered += 1;
        }
      }
      return recovered;
    },

    canAutoRetry(id) {
      return messagesById.get(id)?.status === "failed";
    },
  };
}
