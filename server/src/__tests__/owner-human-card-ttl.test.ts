// [human-card TTL 2026-11-21] owner-human-card-ttl 계약 시험.
//   - 순수 평가: TTL 만료 판정(기본 24h / choice 2h / ttlMs·expiresAt 재정의), 안전+가역만
//     auto_advance, 비가역·무제안은 withdraw_and_resume.
//   - 스윕 통합(embedded pg): 만료 pending 카드 전이(resolved+cancelled+구조 activity),
//     감독 경로에서 만료 카드가 stale-source 웨이크업 보류를 해제하는지 검증.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, createDb, heartbeatRuns, instanceSettings, issueComments, issues, missions,
  operatorDecisionContinuations, operatorDecisions, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { missionService } from "../services/missions.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { operatorApprovalWaitService } from "../services/operator-approval-wait.js";
import {
  CHOICE_CARD_TTL_MS, DEFAULT_HUMAN_CARD_TTL_MS, HUMAN_CARD_TTL_SWEEP_ACTOR_ID,
  evaluatePendingHumanCardExpiry, sweepExpiredPendingHumanCards,
} from "../services/missions/owner-human-card-ttl.js";
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const T0 = new Date("2026-11-20T00:00:00.000Z");
const ago = (ms: number) => new Date(T0.getTime() - ms);

describe("evaluatePendingHumanCardExpiry (pure)", () => {
  it("returns expired:false for a card inside the default 24h TTL", () => {
    expect(evaluatePendingHumanCardExpiry({
      createdAt: ago(60_000), now: T0,
      sourceContext: { missionId: "m" }, suggestedDecision: "retry",
    })).toEqual({ expired: false });
  });
  it.each(["no_action_waiting", "retry", "resume", "continue"] as const)(
    "auto-advances an expired card with safe suggestion %s", (decision) => {
      expect(evaluatePendingHumanCardExpiry({
        createdAt: ago(DEFAULT_HUMAN_CARD_TTL_MS + 1), now: T0,
        sourceContext: {}, suggestedDecision: decision,
      })).toEqual({ expired: true, action: "auto_advance", decision });
    });
  it("auto-advances via safeAutoAdvance even with an unlisted suggestion", () => {
    expect(evaluatePendingHumanCardExpiry({
      createdAt: ago(DEFAULT_HUMAN_CARD_TTL_MS + 1), now: T0,
      sourceContext: { safeAutoAdvance: true }, suggestedDecision: "custom_wait",
    })).toEqual({ expired: true, action: "auto_advance", decision: "custom_wait" });
  });
  it.each([{ irreversible: true }, { suggestedAction: "deploy" }, { action: "payment" }])(
    "never auto-advances irreversible cards %j — withdraws instead", (ctx) => {
      expect(evaluatePendingHumanCardExpiry({
        createdAt: ago(DEFAULT_HUMAN_CARD_TTL_MS + 1), now: T0,
        sourceContext: { safeAutoAdvance: true, ...ctx }, suggestedDecision: "retry",
      })).toEqual({ expired: true, action: "withdraw_and_resume", reason: "ttl_expired" });
    });
  it("withdraws an expired card that has no suggestion", () => {
    expect(evaluatePendingHumanCardExpiry({
      createdAt: ago(DEFAULT_HUMAN_CARD_TTL_MS + 1), now: T0, sourceContext: {},
    })).toEqual({ expired: true, action: "withdraw_and_resume", reason: "ttl_expired" });
  });
  it("honours ttlMs / expiresAt / choice overrides", () => {
    const base = { createdAt: ago(120_000), now: T0 };
    expect(evaluatePendingHumanCardExpiry({ ...base, sourceContext: { ttlMs: 60_000 } }).expired).toBe(true);
    expect(evaluatePendingHumanCardExpiry({ ...base, sourceContext: { ttlMs: 300_000 } }).expired).toBe(false);
    expect(evaluatePendingHumanCardExpiry({ ...base, sourceContext: { expiresAt: ago(1).toISOString() } }).expired).toBe(true);
    expect(evaluatePendingHumanCardExpiry({ ...base, sourceContext: { expiresAt: new Date(T0.getTime() + 60_000).toISOString() } }).expired).toBe(false);
    // choice 카드는 2h TTL — 기본 TTL 안이라도 만료된다.
    const choiceCreated = ago(CHOICE_CARD_TTL_MS + 1);
    expect(evaluatePendingHumanCardExpiry({ createdAt: choiceCreated, now: T0, decisionKind: "choice", sourceContext: {} }).expired).toBe(true);
    expect(evaluatePendingHumanCardExpiry({ createdAt: choiceCreated, now: T0, sourceContext: {} }).expired).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip human-card TTL db tests: ${support.reason ?? "unsupported"}`);

describeDb("sweepExpiredPendingHumanCards (embedded pg)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  let companyId: string, ownerAgentId: string, workerAgentId: string, missionId: string, anchorIssueId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("human-card-ttl-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });
  beforeEach(async () => {
    for (const table of [activityLog, operatorDecisionContinuations, operatorDecisions,
      workflowTransitionEvents, heartbeatRuns, issueComments, issues, missions, agents, instanceSettings, companies]) {
      await db.delete(table);
    }
    companyId = randomUUID(); ownerAgentId = randomUUID(); workerAgentId = randomUUID(); missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "TtlCo", issuePrefix: `T${companyId.slice(0, 4)}` });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Owner" }, { id: workerAgentId, companyId, name: "Worker" }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "TTL mission", status: "active" });
    anchorIssueId = randomUUID();
    await db.insert(issues).values({ id: anchorIssueId, companyId, missionId, title: "Owner action", status: "in_progress", assigneeAgentId: ownerAgentId });
  });
  async function insertCard(over: { createdAt: Date; sourceContext?: Record<string, unknown>; issueId?: string | null; sourceType?: string }) {
    const id = randomUUID();
    await db.insert(operatorDecisions).values({
      id, companyId, requestKey: `moi1:${randomUUID()}`, requestHash: "h", status: "pending",
      interactionType: "single_select", title: "Human input", description: "",
      sourceType: over.sourceType ?? "mission_owner_human_input", sourceId: randomUUID(),
      sourceContext: { missionId, workflowId: null, workflowRunId: null, artifactRefs: [], ...(over.sourceContext ?? {}) },
      issueId: over.issueId === undefined ? anchorIssueId : over.issueId,
      definition: { options: [], actions: [], selection: null,
        comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
        approvedScope: [], forbiddenScope: [] },
      continuationMode: "issue_current_assignee", requestedByAgentId: ownerAgentId,
      createdAt: over.createdAt,
    });
    return id;
  }
  const card = (id: string) => db.select().from(operatorDecisions).where(eq(operatorDecisions.id, id)).then((r) => r[0] ?? null);
  const actions = (id: string) => db.select({ action: activityLog.action, details: activityLog.details })
    .from(activityLog).where(eq(activityLog.entityId, id)).then((rows) => rows.map((r) => r.action));

  it("leaves a non-expired pending card untouched", async () => {
    const id = await insertCard({ createdAt: ago(60_000) });
    await expect(sweepExpiredPendingHumanCards(db, { companyId, missionId, now: T0 }))
      .resolves.toEqual({ sweptCount: 0, autoAdvancedIds: [], withdrawnIds: [] });
    expect(await card(id)).toMatchObject({ status: "pending" });
  });
  it.each(["no_action_waiting", "retry"] as const)("auto-advances an expired card with safe suggestion %s", async (decision) => {
    const id = await insertCard({ createdAt: ago(DEFAULT_HUMAN_CARD_TTL_MS + 1), sourceContext: { suggestedDecision: decision } });
    await expect(sweepExpiredPendingHumanCards(db, { companyId, missionId, now: T0 }))
      .resolves.toEqual({ sweptCount: 1, autoAdvancedIds: [id], withdrawnIds: [] });
    expect(await card(id)).toMatchObject({
      status: "resolved", resolvedByUserId: HUMAN_CARD_TTL_SWEEP_ACTOR_ID,
      result: { actionId: "auto_advance", outcome: "submit", selectedOptionIds: [decision] },
    });
    expect(await db.select().from(operatorDecisionContinuations))
      .toEqual([expect.objectContaining({ operatorDecisionId: id, state: "pending", issueId: anchorIssueId })]);
    expect(await actions(id)).toContain("mission.owner.human_input_auto_resolved");
    expect((await operatorApprovalWaitService(db).markersForIssueIds([anchorIssueId])).get(anchorIssueId)?.waiting).toBe(false);
  });
  it("withdraws (never auto-advances) an expired irreversible card and unblocks the wait marker", async () => {
    const id = await insertCard({
      createdAt: ago(DEFAULT_HUMAN_CARD_TTL_MS + 1),
      sourceContext: { suggestedDecision: "retry", irreversible: true },
    });
    await expect(sweepExpiredPendingHumanCards(db, { companyId, missionId, now: T0 }))
      .resolves.toEqual({ sweptCount: 1, autoAdvancedIds: [], withdrawnIds: [id] });
    expect(await card(id)).toMatchObject({ status: "cancelled", cancelledAt: T0 });
    const seen = await actions(id);
    expect(seen).toEqual(expect.arrayContaining(["operator_decision.cancelled", "mission.owner.human_input_withdrawn"]));
    expect(seen).not.toContain("mission.owner.human_input_auto_resolved");
    expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(0);
  });
  it("withdraws an expired card without suggestion so supervision recovery can resume", async () => {
    const id = await insertCard({ createdAt: ago(DEFAULT_HUMAN_CARD_TTL_MS + 1) });
    await expect(sweepExpiredPendingHumanCards(db, { companyId, now: T0 }))
      .resolves.toEqual({ sweptCount: 1, autoAdvancedIds: [], withdrawnIds: [id] });
    expect(await card(id)).toMatchObject({ status: "cancelled" });
  });
  it("scopes the sweep to the requested mission", async () => {
    const otherMission = randomUUID();
    await db.insert(missions).values({ id: otherMission, companyId, ownerAgentId, title: "Other", status: "active" });
    const otherIssue = randomUUID();
    await db.insert(issues).values({ id: otherIssue, companyId, missionId: otherMission, title: "Other action", status: "todo" });
    const id = await db.insert(operatorDecisions).values({
      id: randomUUID(), companyId, requestKey: `moi1:${randomUUID()}`, requestHash: "h", status: "pending",
      interactionType: "single_select", title: "Other card", description: "",
      sourceType: "mission_owner_human_input", sourceId: randomUUID(),
      sourceContext: { missionId: otherMission, workflowId: null, workflowRunId: null, artifactRefs: [] },
      issueId: otherIssue, continuationMode: "none",
      definition: { options: [], actions: [], selection: null,
        comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
        approvedScope: [], forbiddenScope: [] },
      createdAt: ago(DEFAULT_HUMAN_CARD_TTL_MS + 1),
    }).returning({ id: operatorDecisions.id }).then((r) => r[0]!.id);
    await expect(sweepExpiredPendingHumanCards(db, { companyId, missionId, now: T0 }))
      .resolves.toEqual({ sweptCount: 0, autoAdvancedIds: [], withdrawnIds: [] });
    expect(await card(id)).toMatchObject({ status: "pending" });
  });

  it("unblocks stale-source wakeup during supervision once the pending card expires", async () => {
    // 준비: in_progress 소스 이슈(오래됨) + 종결 실패 런 + 구조화 오너 판정 + 설정 게이트 on.
    const source = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution",
      status: "in_progress", title: "Stale source" });
    await db.update(issues).set({ createdAt: ago(3_600_000), updatedAt: ago(3_600_000) }).where(eq(issues.id, source.id));
    const failedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: failedRunId, companyId, agentId: workerAgentId,
      issueId: source.id, status: "failed", errorCode: "adapter_failed", error: "boom",
      startedAt: ago(3_500_000), finishedAt: ago(3_400_000) });
    const anchor = await issueService(db).create(companyId, {
      assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock",
      originId: source.id, status: "todo", title: "Unblock anchor" });
    const anchorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: anchorRunId, companyId, agentId: ownerAgentId,
      issueId: anchor.id, status: "succeeded", startedAt: ago(3_300_000), finishedAt: ago(3_300_000) });
    await recordMissionOwnerDecision({ db,
      issue: { id: anchor.id, companyId, missionId },
      submission: { decision: "retry_source_issue", reason: "transient failure", nextAction: "retry", evidence: "transient" },
      sourceIssueId: source.id, heartbeatRunId: anchorRunId });
    await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableStaleSourceIssueWakeupV1: true } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableStaleSourceIssueWakeupV1: true } } });
    // 만료된 pending 사람 카드(제안 없음) — 스윕이 회수하고 보류를 해제해야 한다.
    const cardId = await insertCard({ createdAt: ago(DEFAULT_HUMAN_CARD_TTL_MS + 1), issueId: anchor.id });

    const onStaleSourceIssueWakeupRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "w", runId: "r" });
    const svc = missionService(db, { onStaleSourceIssueWakeupRequested });
    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: T0, applySafeActions: true });

    expect(await card(cardId)).toMatchObject({ status: "cancelled" });
    expect(onStaleSourceIssueWakeupRequested).toHaveBeenCalledTimes(1);
    const findings = result.missions.find((row) => row.missionId === missionId)?.findings ?? [];
    expect(findings.some((f) => f.includes("stale_source_wakeup_deferred_human_card_pending"))).toBe(false);
  });

  it("does NOT resolve or cancel expired pending cards in dry-run supervision (applySafeActions: false)", async () => {
    // 위와 동일한 stale-source 셋업 — dry-run 은 카드 상태를 쓰지 않고 보류만 보고해야 한다.
    const source = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution",
      status: "in_progress", title: "Stale source" });
    await db.update(issues).set({ createdAt: ago(3_600_000), updatedAt: ago(3_600_000) }).where(eq(issues.id, source.id));
    const failedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: failedRunId, companyId, agentId: workerAgentId,
      issueId: source.id, status: "failed", errorCode: "adapter_failed", error: "boom",
      startedAt: ago(3_500_000), finishedAt: ago(3_400_000) });
    const anchor = await issueService(db).create(companyId, {
      assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock",
      originId: source.id, status: "todo", title: "Unblock anchor" });
    const anchorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: anchorRunId, companyId, agentId: ownerAgentId,
      issueId: anchor.id, status: "succeeded", startedAt: ago(3_300_000), finishedAt: ago(3_300_000) });
    await recordMissionOwnerDecision({ db,
      issue: { id: anchor.id, companyId, missionId },
      submission: { decision: "retry_source_issue", reason: "transient failure", nextAction: "retry", evidence: "transient" },
      sourceIssueId: source.id, heartbeatRunId: anchorRunId });
    await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableStaleSourceIssueWakeupV1: true } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableStaleSourceIssueWakeupV1: true } } });
    const cardId = await insertCard({ createdAt: ago(DEFAULT_HUMAN_CARD_TTL_MS + 1), issueId: anchor.id });

    const onStaleSourceIssueWakeupRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "w", runId: "r" });
    const svc = missionService(db, { onStaleSourceIssueWakeupRequested });
    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: T0, applySafeActions: false });

    expect(await card(cardId)).toMatchObject({ status: "pending", resolvedAt: null, cancelledAt: null, resolvedByUserId: null });
    expect(await actions(cardId)).toEqual([]);
    expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(0);
    expect(onStaleSourceIssueWakeupRequested).toHaveBeenCalledTimes(0);
    const findings = result.missions.find((row) => row.missionId === missionId)?.findings ?? [];
    expect(findings.some((f) => f.includes("stale_source_wakeup_deferred_human_card_pending"))).toBe(true);
  });
});
