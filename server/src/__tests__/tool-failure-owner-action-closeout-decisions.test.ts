// server/src/__tests__/tool-failure-owner-action-closeout-decisions.test.ts
//
// [purpose] 툴 실패 오너 액션 카드 자동 종결 시 앵커된 사람 입력 카드(operatorDecisions.issueId = 카드 이슈)
//   정리의 범위 검증. 카드가 done/cancelled 로 닫히면 같은 패스에서 pending 카드만 cancelled 로 바꾼다
//   (cancel 상태 체크: cancelledAt 필수, 취소 감사: operator_decision.cancelled).
//   non-pending·같은 미션의 다른 이슈에 앵커된 카드는 건드리지 않고, 재실행은 아무 것도 쓰지 않는다.

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  type Db, addDecision, addToolFailureCard, closeoutRecords, decisionStatuses, linkCard, runRef, seedRun, seedTenant,
} from "./helpers/tool-failure-closeout-fixture.js";
import {
  TOOL_FAILURE_DECISION_CANCEL_ACTION,
  closeStaleToolFailureOwnerActions,
} from "../services/workflow/tool-failure-owner-action-closeout.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip tool-failure owner action decision closeout tests: ${support.reason ?? "unsupported"}`);

describeDb("tool-failure owner action closeout — anchored operator decisions", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("tool-failure-decisions-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("cancels only the pending decisions anchored to the closed card and audits once; a second pass writes nothing", async () => {
    const seed = await seedRun(db, await seedTenant(db, "decisions"), "completed", "done");
    const cardId = await addToolFailureCard(db, seed, seed.sourceIssueId);
    await linkCard(db, seed, seed.runId, seed.stepRunId, cardId);
    const pending = await addDecision(db, seed, cardId);
    const settled = await addDecision(db, seed, cardId, { status: "cancelled", cancelledAt: new Date() });
    const resolved = await addDecision(db, seed, cardId, {
      status: "resolved", resolvedByUserId: "user-1", resolvedAt: new Date(),
      result: { actionId: "ok", outcome: "submit", selectedOptionIds: [], comment: null },
    });
    // Same mission, different anchor issue (a non-moi card — the DB allows only one pending moi card per
    // mission): must survive the closeout, i.e. scope is the closed card's issueId, not mission or company.
    const elsewhere = await addDecision(db, seed, seed.sourceIssueId, { sourceType: "workflow_recovery" });

    const result = await closeStaleToolFailureOwnerActions({
      db, run: runRef(seed, "completed"),
      stepRuns: [{ id: seed.stepRunId, workflowRunId: seed.runId, status: "completed" }],
    });
    expect(result).toEqual({
      closed: [{ issueId: cardId, previousStatus: "todo", status: "done", reason: "step_completed" }],
      cancelledDecisions: [{ issueId: cardId, operatorDecisionId: pending.id, reason: "step_completed" }],
    });

    const rows = await decisionStatuses(db, [pending.id, settled.id, resolved.id, elsewhere.id]);
    expect(rows.get(pending.id)).toMatchObject({ status: "cancelled" });
    expect(rows.get(pending.id)!.cancelledAt).toBeInstanceOf(Date);
    expect(rows.get(settled.id)).toMatchObject({ status: "cancelled", cancelledAt: settled.cancelledAt });
    expect(rows.get(resolved.id)).toMatchObject({ status: "resolved", cancelledAt: null });
    expect(rows.get(elsewhere.id)).toMatchObject({ status: "pending", cancelledAt: null });

    const cancels = () => db.select().from(activityLog).where(and(
      eq(activityLog.companyId, seed.companyId), eq(activityLog.action, TOOL_FAILURE_DECISION_CANCEL_ACTION)));
    expect((await cancels()).map((row) => row.entityId)).toEqual([pending.id]);
    expect((await cancels())[0]).toMatchObject({
      actorType: "user", actorId: "system:tool-failure-owner-action-closeout", entityType: "operator_decision",
      details: { reason: "owner_action_settled_from_tool_recovery", issueId: cardId, missionId: seed.missionId },
    });
    const [settledActivity] = (await closeoutRecords(db, seed.companyId, [cardId])).activities;
    expect(settledActivity!.details).toMatchObject({ operatorDecisionsCancelled: [pending.id] });

    // A second pass finds no open card and writes nothing new.
    expect(await closeStaleToolFailureOwnerActions({
      db, run: runRef(seed, "completed"), stepRuns: [{ id: seed.stepRunId, workflowRunId: seed.runId, status: "completed" }],
    })).toEqual({ closed: [], cancelledDecisions: [] });
    expect(await cancels()).toHaveLength(1);
  });
});
