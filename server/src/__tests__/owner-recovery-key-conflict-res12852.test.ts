// RES-12852 regression: the A1 production incident trapped a mission owner after an operator
// resolved its human decision card.
// (A) Ledger: an idempotent replay of an already-committed human request key must compare the
//     authoritative semantic submission — never run-ephemeral CAS metadata such as the
//     expectedCurrentLifetimeId stored in correlationId — while genuine content/scope/mission
//     conflicts stay 409 owner_human_request_key_conflict.
// (B) Wait: recoveryNeeded deliberately survives card resolution (settlement owns closure), but
//     once the linked operator card is resolved, a strictly later structured non-human owner
//     decision (replan_mission/retry_step family) must lift the exact human wait instead of
//     leaving it bound to the answered lifetime (consecutive no-progress lockup).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, missions,
  operatorDecisions, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { saveOwnerHumanRequest } from "../services/missions/owner-human-request-state.js";
import { readExactOwnerRetryHumanWait, type OwnerRetryHumanWaitContext } from "../services/missions/owner-retry-human-wait.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { createMissionOwnerHumanInputDecisionCard } from "../services/missions/mission-owner-human-input-card.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
type World = { companyId: string; missionId: string; ownerAgentId: string; sourceIssueId: string;
  ownerActionIssueId: string; heartbeatRunId: string };
const ESCALATE = { decision: "escalate" as const, reason: "Need a human decision",
  nextAction: "사람 확인", evidence: "원천 근거" };
const envelope = (requestKey: string, expectedCurrentLifetimeId: string | null) =>
  ({ schemaVersion: 1 as const, requestKey, expectedCurrentLifetimeId });

describeDb("RES-12852 owner recovery key conflict and post-resolution wait", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("res12852-owner-key-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  async function world(title = "RES-12852"): Promise<World> {
    const w = { companyId: randomUUID(), missionId: randomUUID(), ownerAgentId: randomUUID(),
      sourceIssueId: randomUUID(), ownerActionIssueId: randomUUID(), heartbeatRunId: randomUUID() };
    await db.insert(companies).values({ id: w.companyId, name: title, issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: w.ownerAgentId, companyId: w.companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: w.missionId, companyId: w.companyId, ownerAgentId: w.ownerAgentId,
      title, status: "active" });
    await db.insert(issues).values([
      { id: w.sourceIssueId, companyId: w.companyId, missionId: w.missionId, title: "Source", status: "blocked" },
      { id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId, title: "Owner action",
        status: "in_progress", assigneeAgentId: w.ownerAgentId, originKind: "mission_main_executor_unblock",
        originId: w.sourceIssueId },
    ]);
    await db.insert(heartbeatRuns).values({ id: w.heartbeatRunId, companyId: w.companyId,
      agentId: w.ownerAgentId, issueId: w.ownerActionIssueId, status: "running" });
    return w;
  }
  const issueRef = (w: World) => ({ id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId });
  async function submitHuman(w: World, key: string, expected: string | null,
    submission = ESCALATE, connection: Db = db) {
    return connection.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { companyId: w.companyId, missionId: w.missionId,
        ownerActionIssueId: w.ownerActionIssueId, agentId: w.ownerAgentId, heartbeatRunId: w.heartbeatRunId });
      const recorded = await recordMissionOwnerDecision({ db: tx, issue: issueRef(w), submission,
        sourceIssueId: w.sourceIssueId, heartbeatRunId: w.heartbeatRunId,
        humanRequest: envelope(key, expected) });
      return saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: key,
        expectedCurrentLifetimeId: expected, identityMode: "keyed",
        decisionEventId: recorded.eventId, submission });
    });
  }
  async function recordNonHuman(w: World, decision: "replan_mission" | "retry_source_issue",
    connection: Db | { transaction: Db["transaction"] } = db) {
    return connection.transaction(async (tx) => recordMissionOwnerDecision({ db: tx, issue: issueRef(w),
      submission: { decision }, sourceIssueId: w.sourceIssueId, heartbeatRunId: w.heartbeatRunId }));
  }
  async function resolveCard(lifetimeId: string) {
    const [card] = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.requestKey, `moi2:${lifetimeId}`));
    expect(card).toBeTruthy();
    await operatorDecisionWriteService(db).resolve(card!.id,
      { actionId: "approve", selectedOptionIds: ["approve"], comment: "입력 수정 후 재시도" }, "board");
    const [answered] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, card!.id));
    expect(answered!.status).toBe("resolved");
  }
  const waitContext = (w: World): OwnerRetryHumanWaitContext => ({
    companyId: w.companyId, missionId: w.missionId, ownerActionIssueId: w.ownerActionIssueId,
    originalSourceIssueId: w.sourceIssueId, retryIssueId: w.sourceIssueId });
  async function inspectWait(w: World) {
    return db.transaction(async (tx) => {
      await tx.select({ id: missions.id }).from(missions).where(and(eq(missions.id, w.missionId),
        eq(missions.companyId, w.companyId))).for("update");
      return readExactOwnerRetryHumanWait(tx, waitContext(w));
    });
  }

  // --- Bug A: idempotent replay compares the authoritative semantic submission only ---

  it("returns the original decision when an identical human request replays with a later expectedCurrentLifetimeId", async () => {
    const w = await world();
    const first = await recordMissionOwnerDecision({ db, issue: issueRef(w), submission: ESCALATE,
      sourceIssueId: w.sourceIssueId, heartbeatRunId: w.heartbeatRunId,
      humanRequest: envelope("K", null) });
    // Pointer advanced between runs (renewal/replacement): the replaying run names the current
    // lifetime while the committed original recorded its own CAS input. The semantic submission
    // is identical, so the ledger must stay idempotent instead of 409 key-conflicting.
    const replay = await recordMissionOwnerDecision({ db, issue: issueRef(w), submission: ESCALATE,
      sourceIssueId: w.sourceIssueId, heartbeatRunId: randomUUID(),
      humanRequest: envelope("K", first.eventId) });
    expect(replay.eventId).toBe(first.eventId);
    expect(replay.createdAt).toEqual(first.createdAt);
    const decisions = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, w.companyId),
      eq(workflowTransitionEvents.eventType, "mission_owner_decision")));
    expect(decisions).toHaveLength(1);
  });

  it("still rejects different submission content under the same human request key", async () => {
    const w = await world();
    const first = await recordMissionOwnerDecision({ db, issue: issueRef(w), submission: ESCALATE,
      sourceIssueId: w.sourceIssueId, heartbeatRunId: w.heartbeatRunId,
      humanRequest: envelope("K", null) });
    await expect(recordMissionOwnerDecision({ db, issue: issueRef(w),
      submission: { ...ESCALATE, reason: "다른 내용" }, sourceIssueId: w.sourceIssueId,
      heartbeatRunId: randomUUID(), humanRequest: envelope("K", first.eventId) }))
      .rejects.toMatchObject({ status: 409, details: { reason: "owner_human_request_key_conflict" } });
    const decisions = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, w.companyId),
      eq(workflowTransitionEvents.eventType, "mission_owner_decision")));
    expect(decisions).toHaveLength(1);
  });

  it("still rejects the same human request key reused under a different mission", async () => {
    const w = await world();
    await recordMissionOwnerDecision({ db, issue: issueRef(w), submission: ESCALATE,
      sourceIssueId: w.sourceIssueId, heartbeatRunId: w.heartbeatRunId, humanRequest: envelope("K", null) });
    const other = await world("Other mission");
    await db.update(missions).set({ companyId: w.companyId }).where(eq(missions.id, other.missionId));
    await db.update(issues).set({ companyId: w.companyId }).where(eq(issues.id, other.ownerActionIssueId));
    await db.update(heartbeatRuns).set({ companyId: w.companyId }).where(eq(heartbeatRuns.id, other.heartbeatRunId));
    await expect(recordMissionOwnerDecision({ db,
      issue: { id: other.ownerActionIssueId, companyId: w.companyId, missionId: other.missionId },
      submission: ESCALATE, sourceIssueId: other.sourceIssueId, heartbeatRunId: other.heartbeatRunId,
      humanRequest: envelope("K", null) }))
      .rejects.toMatchObject({ status: 409, details: { reason: "owner_human_request_key_conflict" } });
  });

  // --- Bug B: a resolved card plus a later non-human owner decision lifts the exact wait ---

  it("lifts the exact human wait once the card is resolved and a later non-human decision exists", async () => {
    const w = await world();
    const first = await submitHuman(w, "res12852:A", null);
    await createMissionOwnerHumanInputDecisionCard(db, { ...first.lifetime.cardInput,
      lifetimeId: first.lifetime.lifetimeId });
    expect(await inspectWait(w)).toMatchObject({ kind: "waiting",
      bindingIds: [first.lifetime.lifetimeId] });
    await resolveCard(first.lifetime.lifetimeId);
    // Owner followed the operator's answer with a legitimate non-human follow-up decision.
    await recordNonHuman(w, "replan_mission");
    expect(await inspectWait(w)).toMatchObject({ kind: "clear" });
  });

  it("keeps the wait while the linked card is still pending even after a later non-human decision", async () => {
    const w = await world();
    const first = await submitHuman(w, "res12852:B", null);
    await createMissionOwnerHumanInputDecisionCard(db, { ...first.lifetime.cardInput,
      lifetimeId: first.lifetime.lifetimeId });
    await recordNonHuman(w, "replan_mission");
    expect(await inspectWait(w)).toMatchObject({ kind: "waiting",
      bindingIds: [first.lifetime.lifetimeId] });
  });

  it("keeps the wait when the card is resolved but no later owner decision exists", async () => {
    const w = await world();
    const first = await submitHuman(w, "res12852:C", null);
    await createMissionOwnerHumanInputDecisionCard(db, { ...first.lifetime.cardInput,
      lifetimeId: first.lifetime.lifetimeId });
    await resolveCard(first.lifetime.lifetimeId);
    expect(await inspectWait(w)).toMatchObject({ kind: "waiting",
      bindingIds: [first.lifetime.lifetimeId] });
  });

  it("keeps the wait bound to a later human replacement lifetime after the predecessor card is resolved", async () => {
    const w = await world();
    const first = await submitHuman(w, "res12852:D1", null);
    await createMissionOwnerHumanInputDecisionCard(db, { ...first.lifetime.cardInput,
      lifetimeId: first.lifetime.lifetimeId });
    await resolveCard(first.lifetime.lifetimeId);
    const second = await submitHuman(w, "res12852:D2", first.lifetime.lifetimeId);
    await createMissionOwnerHumanInputDecisionCard(db, { ...second.lifetime.cardInput,
      lifetimeId: second.lifetime.lifetimeId });
    expect(await inspectWait(w)).toMatchObject({ kind: "waiting",
      bindingIds: [second.lifetime.lifetimeId] });
  });
});
