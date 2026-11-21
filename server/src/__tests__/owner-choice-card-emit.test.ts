// [owner-choice-card Stage 3] 정상 흐름 선택 카드 생산자의 종단 계약 시험(embedded pg).
//   - emit 이 계약 위반 payload 를 fail-closed 로 거부하고, 유효 카드를 pending
//     mission_owner_human_input 행(decisionKind:"choice" + 서버 소유 선택 힌트)으로 저장하는지
//   - 저장 카드가 2h TTL 엔진(auto_advance/withdraw)과 기존 resolve 쓰기 경로에 그대로 연결되는지
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, createDb, issueComments, issues, missions,
  operatorDecisionContinuations, operatorDecisions, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { emitMissionOwnerChoiceCard, OWNER_CHOICE_CARD_REQUESTED_ACTION }
  from "../services/missions/owner-choice-card-emit.js";
import { CHOICE_CARD_TTL_MS, sweepExpiredPendingHumanCards } from "../services/missions/owner-human-card-ttl.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const expiredNow = () => new Date(Date.now() + CHOICE_CARD_TTL_MS + 1_000);
const option = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, label: `옵션 ${id}`, summary: `${id} 선택지 요약`, ...extra });
const topicPayload = () => ({
  decisionKind: "choice",
  decisionPoint: "topic_selection",
  prompt: "이번 스프린트 주제를 선택해 주세요.",
  options: [option("topic-alpha"), option("topic-beta", { recommended: true })],
  autoAdvanceProposal: { defaultOptionId: "topic-beta", safe: true, rationale: "권장안이며 되돌릴 수 있습니다." },
});
const publishPayload = () => ({
  decisionKind: "choice",
  decisionPoint: "publish_approval",
  prompt: "보고서를 게시할까요?",
  options: [option("publish-hold"), option("publish-now", { irreversible: true })],
  autoAdvanceProposal: { defaultOptionId: "publish-hold", safe: true, rationale: "보류는 언제든 되돌릴 수 있습니다." },
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip owner-choice-card emit db tests: ${support.reason ?? "unsupported"}`);

describeDb("emitMissionOwnerChoiceCard (embedded pg)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  let companyId: string, ownerAgentId: string, missionId: string, issueId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("owner-choice-card-emit-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });
  beforeEach(async () => {
    for (const table of [activityLog, operatorDecisionContinuations, operatorDecisions,
      issueComments, issues, missions, agents, companies]) {
      await db.delete(table);
    }
    companyId = randomUUID(); ownerAgentId = randomUUID(); missionId = randomUUID(); issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "ChoiceCo", issuePrefix: `C${companyId.slice(0, 4)}` });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Choice mission", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Owner action", status: "in_progress", assigneeAgentId: ownerAgentId });
  });

  const emit = (payload: unknown) => emitMissionOwnerChoiceCard(db, {
    companyId, missionId, issueId,
    actor: { type: "agent", id: ownerAgentId },
    requestKey: `moc1:${randomUUID()}`,
    payload,
  });
  const card = (id: string) => db.select().from(operatorDecisions)
    .where(eq(operatorDecisions.id, id)).then((rows) => rows[0] ?? null);
  const actions = (id: string) => db.select({ action: activityLog.action })
    .from(activityLog).where(eq(activityLog.entityId, id)).then((rows) => rows.map((row) => row.action));

  it("persists a valid topic_selection card with the choice sourceContext and resolvable definition", async () => {
    const { decision } = await emit(topicPayload());
    expect(decision.status).toBe("pending");
    const row = await card(decision.id);
    expect(row).toMatchObject({
      status: "pending", interactionType: "single_select", issueId,
      sourceType: "mission_owner_human_input", requestedByAgentId: ownerAgentId,
      continuationMode: "issue_current_assignee",
    });
    expect(row!.sourceContext).toMatchObject({
      missionId, decisionKind: "choice", decisionPoint: "topic_selection",
      ttlMs: 7_200_000, suggestedDecision: "topic-beta",
      safeAutoAdvance: true, irreversible: false,
    });
    const ctx = row!.sourceContext as unknown as Record<string, unknown>;
    const choiceOptions = ctx.choiceOptions as Array<Record<string, unknown>>;
    expect(choiceOptions.map((option) => option.id)).toEqual(["topic-alpha", "topic-beta"]);
    expect(choiceOptions[1]).toMatchObject({ recommended: true, irreversible: false });
    expect(row!.definition.options.map((option) => option.id)).toEqual(["topic-alpha", "topic-beta"]);
    expect(row!.definition.actions).toEqual([
      expect.objectContaining({ outcome: "submit", requiresSelection: true, tone: "primary" }),
    ]);
    expect(row!.definition.selection).toEqual({ min: 1, max: 1 });
    expect(row!.definition.humanReview).not.toBeNull();
    expect(await actions(decision.id)).toEqual(
      expect.arrayContaining(["operator_decision.created", OWNER_CHOICE_CARD_REQUESTED_ACTION]));
  });

  it("auto-advances a non-irreversible choice card with safeAutoAdvance after the 2h TTL", async () => {
    const { decision } = await emit(topicPayload());
    await expect(sweepExpiredPendingHumanCards(db, { companyId, missionId, now: expiredNow() }))
      .resolves.toEqual({ sweptCount: 1, autoAdvancedIds: [decision.id], withdrawnIds: [] });
    expect(await card(decision.id)).toMatchObject({
      status: "resolved",
      result: { actionId: "auto_advance", outcome: "submit", selectedOptionIds: ["topic-beta"] },
    });
    expect(await db.select().from(operatorDecisionContinuations))
      .toEqual([expect.objectContaining({ operatorDecisionId: decision.id, state: "pending", issueId })]);
    expect(await actions(decision.id)).toContain("mission.owner.human_input_auto_resolved");
  });

  it("never auto-advances an irreversible publish_approval card — withdraws it after the 2h TTL", async () => {
    const { decision } = await emit(publishPayload());
    const row = await card(decision.id);
    expect(row!.sourceContext).toMatchObject({ irreversible: true, safeAutoAdvance: true });
    await expect(sweepExpiredPendingHumanCards(db, { companyId, missionId, now: expiredNow() }))
      .resolves.toEqual({ sweptCount: 1, autoAdvancedIds: [], withdrawnIds: [decision.id] });
    expect(await card(decision.id)).toMatchObject({ status: "cancelled" });
    const seen = await actions(decision.id);
    expect(seen).toContain("mission.owner.human_input_withdrawn");
    expect(seen).not.toContain("mission.owner.human_input_auto_resolved");
  });

  it("lets a human resolve an option through the existing resolution write path", async () => {
    const { decision } = await emit(topicPayload());
    const actionId = (await card(decision.id))!.definition.actions[0]!.id;
    const resolved = await operatorDecisionWriteService(db).resolve(decision.id, {
      actionId, selectedOptionIds: ["topic-alpha"], comment: null,
    }, "board-user-1");
    expect(resolved.applied).toBe(true);
    expect(await card(decision.id)).toMatchObject({
      status: "resolved", resolvedByUserId: "board-user-1",
      result: { actionId, outcome: "submit", selectedOptionIds: ["topic-alpha"] },
    });
    expect(await actions(decision.id)).toContain("operator_decision.resolved");
  });

  it("rejects fail-closed when a safe proposal points at an irreversible option", async () => {
    const bad = {
      ...topicPayload(),
      options: [option("keep"), option("wipe-all", { irreversible: true })],
      autoAdvanceProposal: { defaultOptionId: "wipe-all", safe: true, rationale: "안전하다고 선언" },
    };
    await expect(emit(bad)).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(operatorDecisions)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });
});
