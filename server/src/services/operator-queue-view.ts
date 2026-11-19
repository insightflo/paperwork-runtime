/**
 * 운영자 큐 뷰 — agent_wakeup_requests 대기열의 읽기·재정렬·편집·취소.
 *
 * 경계: 이 서비스는 agent_wakeup_requests 만 쓴다. heartbeat_runs /
 * workflow_runs 상태는 절대 건드리지 않는다(run-status 초크포인트 존중).
 * 취소는 queued/held_fanout 대기 행만 cancelled 로 전환한다.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";
import { badRequest, notFound, unprocessable } from "../errors.js";

export const QUEUED_WAKEUP_STATUSES = ["queued", "held_fanout"] as const;

export const PROMPT_PREVIEW_MAX_LENGTH = 300;

export interface OperatorQueueItem {
  id: string;
  agentId: string;
  source: string;
  reason: string | null;
  status: string;
  promptPreview: string;
  queueOrder: number | null;
  requestedAt: Date;
  issueId: string | null;
  missionId: string | null;
}

type WakeupRow = typeof agentWakeupRequests.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw badRequest(`잘못된 ${label} 형식입니다`);
}

/** payload.prompt ?? payload.message ?? payload.note ?? reason 을 안전 추출해 300자로 자른다. */
export function buildPromptPreview(
  payload: Record<string, unknown> | null | undefined,
  reason: string | null | undefined,
): string {
  const raw = payload?.prompt ?? payload?.message ?? payload?.note ?? reason ?? "";
  const text = typeof raw === "string" ? raw : "";
  return text.length > PROMPT_PREVIEW_MAX_LENGTH ? text.slice(0, PROMPT_PREVIEW_MAX_LENGTH) : text;
}

function readQueueOrder(payload: Record<string, unknown> | null | undefined): number | null {
  const raw = payload?.queueOrder;
  return typeof raw === "number" && Number.isInteger(raw) ? raw : null;
}

function mapRow(row: WakeupRow): OperatorQueueItem {
  return {
    id: row.id,
    agentId: row.agentId,
    source: row.source,
    reason: row.reason,
    status: row.status,
    promptPreview: buildPromptPreview(row.payload, row.reason),
    queueOrder: readQueueOrder(row.payload),
    requestedAt: row.requestedAt,
    issueId: row.issueId,
    missionId: row.missionId,
  };
}

export function operatorQueueViewService(db: Db) {
  async function listCompanyQueue(companyId: string, agentId?: string): Promise<OperatorQueueItem[]> {
    const conditions = [
      eq(agentWakeupRequests.companyId, companyId),
      inArray(agentWakeupRequests.status, [...QUEUED_WAKEUP_STATUSES]),
    ];
    if (agentId !== undefined) {
      assertUuid(agentId, "agentId");
      conditions.push(eq(agentWakeupRequests.agentId, agentId));
    }
    const rows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(...conditions))
      .orderBy(
        sql`COALESCE((${agentWakeupRequests.payload} ->> 'queueOrder')::int, 1000000) ASC`,
        asc(agentWakeupRequests.requestedAt),
      );
    return rows.map(mapRow);
  }

  async function reorderQueue(companyId: string, orderedIds: string[]): Promise<OperatorQueueItem[]> {
    for (const id of orderedIds) assertUuid(id, "wakeup id");
    await db.transaction(async (tx) => {
      for (let index = 0; index < orderedIds.length; index += 1) {
        await tx
          .update(agentWakeupRequests)
          .set({
            payload: sql`coalesce(${agentWakeupRequests.payload}, '{}'::jsonb) || ${JSON.stringify({ queueOrder: index + 1 })}::jsonb`,
          })
          .where(
            and(
              eq(agentWakeupRequests.id, orderedIds[index]),
              eq(agentWakeupRequests.companyId, companyId),
              inArray(agentWakeupRequests.status, [...QUEUED_WAKEUP_STATUSES]),
            ),
          );
      }
    });
    return listCompanyQueue(companyId);
  }

  async function editQueuedWakeup(
    companyId: string,
    wakeupId: string,
    input: { prompt?: string; note?: string },
  ): Promise<OperatorQueueItem> {
    assertUuid(wakeupId, "wakeup id");
    const [row] = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.id, wakeupId), eq(agentWakeupRequests.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("대기 중인 깨움 요청을 찾을 수 없습니다");
    if (!(QUEUED_WAKEUP_STATUSES as readonly string[]).includes(row.status)) {
      throw unprocessable(`편집 불가 상태입니다(status=${row.status})`);
    }
    const payload: Record<string, unknown> = { ...(row.payload ?? {}) };
    if (input.prompt !== undefined) payload.prompt = input.prompt.trim();
    if (input.note !== undefined) payload.note = input.note.trim();
    const now = new Date();
    await db
      .update(agentWakeupRequests)
      .set({ payload, updatedAt: now })
      .where(eq(agentWakeupRequests.id, wakeupId));
    return mapRow({ ...row, payload, updatedAt: now });
  }

  async function cancelQueuedWakeup(companyId: string, wakeupId: string): Promise<boolean> {
    assertUuid(wakeupId, "wakeup id");
    const now = new Date();
    const updated = await db
      .update(agentWakeupRequests)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(
        and(
          eq(agentWakeupRequests.id, wakeupId),
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, [...QUEUED_WAKEUP_STATUSES]),
        ),
      )
      .returning({ id: agentWakeupRequests.id });
    return updated.length > 0;
  }

  return { listCompanyQueue, reorderQueue, editQueuedWakeup, cancelQueuedWakeup };
}
