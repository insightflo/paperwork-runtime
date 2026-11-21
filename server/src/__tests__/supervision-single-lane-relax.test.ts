// [single-lane relax 2026-11-21] supervision-single-lane-relax 계약 시험.
//   - 순수 평가: pending 카드가 choice/irreversible 이 아니고 소스 최신 terminal 실패가
//     자동 복구 원인(provider_transient/auth_refreshable)일 때만 relax — 그 외 fail-closed.
//   - 감독 통합(embedded pg): pending 카드 + 자동 복구 실패 → 보류 해제 + wakeup 발사,
//     비자동 복구·choice·irreversible·dry-run → 기존 보류(R4) 그대로.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, issues, missions, operatorDecisions, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { missionService } from "../services/missions.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import {
  canRelaxSingleLaneForAutoRecoverableSource, evaluateSingleLaneRelax,
} from "../services/missions/supervision-single-lane-relax.js";
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const T0 = new Date("2026-11-21T00:00:00.000Z");
const ago = (ms: number) => new Date(T0.getTime() - ms);
const plainCard = { decisionKind: null, irreversible: null } as const;

describe("evaluateSingleLaneRelax (pure)", () => {
  const run = (over: Record<string, unknown>) => ({ status: "failed", errorCode: null, error: null, ...over });
  it.each([
    { name: "errorCode adapter_failed", input: run({ errorCode: "adapter_failed" }), causeClass: "provider_transient", signal: "code:adapter_failed" },
    { name: "errorCode stale_queued", input: run({ errorCode: "stale_queued" }), causeClass: "provider_transient" },
    { name: "errorCode token_expired", input: run({ errorCode: "token_expired" }), causeClass: "auth_refreshable", signal: "code:token_expired" },
    { name: "429 text", input: run({ error: "HTTP 429 rate limited by provider" }), causeClass: "provider_transient" },
    { name: "timeout text", input: run({ error: "request timed_out after 30s" }), causeClass: "provider_transient" },
    { name: "status timed_out", input: run({ status: "timed_out" }), causeClass: "provider_transient", signal: "status:timed_out" },
  ])("relaxes when the source failure is auto-recoverable ($name)", ({ input, causeClass, signal }) => {
    const verdict = evaluateSingleLaneRelax({ pendingCards: [plainCard], failedRun: input });
    expect(verdict).toMatchObject({ relax: true, causeClass, reason: "auto_recoverable" });
    if (signal) expect(verdict.matchedSignal).toBe(signal);
  });
  it.each([
    { name: "internal_bug code", input: run({ errorCode: "assertion_failed" }), causeClass: "internal_bug" },
    { name: "internal_bug text", input: run({ error: "invariant violation in step planner" }), causeClass: "internal_bug" },
    { name: "quota code", input: run({ errorCode: "quota_exceeded" }), causeClass: "quota" },
    { name: "unknown code", input: run({ errorCode: "process_lost", error: "crash" }), causeClass: "unknown" },
    { name: "unknown empty", input: run({}), causeClass: "unknown" },
  ])("stays deferred for non-auto-recoverable causes ($name)", ({ input, causeClass }) => {
    const verdict = evaluateSingleLaneRelax({ pendingCards: [plainCard], failedRun: input });
    expect(verdict).toMatchObject({ relax: false, reason: "cause_not_auto_recoverable", causeClass });
  });
  it("stays deferred when there is no terminal run", () => {
    expect(evaluateSingleLaneRelax({ pendingCards: [plainCard], failedRun: null }))
      .toMatchObject({ relax: false, reason: "no_terminal_run" });
  });
  it.each([
    { name: "choice card", cards: [{ decisionKind: "choice" }] },
    { name: "CHOICE (case)", cards: [{ decisionKind: "CHOICE" }] },
    { name: "irreversible card", cards: [{ irreversible: true }] },
    { name: "one bad card among many", cards: [plainCard, { irreversible: true }] },
  ])("never relaxes when a pending card blocks it ($name)", ({ cards }) => {
    expect(evaluateSingleLaneRelax({
      pendingCards: cards,
      failedRun: run({ errorCode: "adapter_failed" }),
    })).toMatchObject({ relax: false, reason: "card_blocks_relax" });
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip single-lane relax db tests: ${support.reason ?? "unsupported"}`);

describeDb("canRelaxSingleLaneForAutoRecoverableSource + supervision (embedded pg)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("single-lane-relax-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  // in_progress(오래됨) 소스 이슈 + terminal 실패 런 + 언블록 앵커 + 구조화 오너 판정 + pending 카드.
  async function world(run: { errorCode?: string | null; error?: string | null; status?: string },
    cardCtx: Record<string, unknown> = {}) {
    const companyId = randomUUID(), ownerAgentId = randomUUID(), workerAgentId = randomUUID(), missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RelaxCo", issuePrefix: `R${companyId.slice(0, 4)}` });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Owner" }, { id: workerAgentId, companyId, name: "Worker" }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Relax mission", status: "active" });
    const source = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution",
      status: "in_progress", title: "Stale source" });
    await db.update(issues).set({ createdAt: ago(3_600_000), updatedAt: ago(3_600_000) }).where(eq(issues.id, source.id));
    await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId, agentId: workerAgentId,
      issueId: source.id, status: run.status ?? "failed", errorCode: run.errorCode ?? null,
      error: run.error ?? null, settledAt: ago(3_300_000), startedAt: ago(3_500_000), finishedAt: ago(3_400_000) });
    const anchor = await issueService(db).create(companyId, {
      assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock",
      originId: source.id, status: "todo", title: "Unblock anchor" });
    const anchorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: anchorRunId, companyId, agentId: ownerAgentId,
      issueId: anchor.id, status: "succeeded", startedAt: ago(3_200_000), finishedAt: ago(3_200_000) });
    await recordMissionOwnerDecision({ db,
      issue: { id: anchor.id, companyId, missionId },
      submission: { decision: "retry_source_issue", reason: "transient failure", nextAction: "retry", evidence: "transient" },
      sourceIssueId: source.id, heartbeatRunId: anchorRunId });
    const cardId = randomUUID();
    await db.insert(operatorDecisions).values({
      id: cardId, companyId, requestKey: `moi1:${randomUUID()}`, requestHash: "h", status: "pending",
      interactionType: "single_select", title: "Recovery card", description: "",
      sourceType: "mission_owner_human_input", sourceId: randomUUID(),
      sourceContext: { missionId, workflowId: null, workflowRunId: null, artifactRefs: [], ...cardCtx },
      issueId: anchor.id, continuationMode: "issue_current_assignee", requestedByAgentId: ownerAgentId,
      definition: { options: [], actions: [], selection: null,
        comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
        approvedScope: [], forbiddenScope: [] },
    });
    return { companyId, missionId, sourceId: source.id, cardId };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const pendingIds = (w: World) => [w.cardId];

  it("DB: relaxes only for auto-recoverable causes, fail-closed otherwise", async () => {
    const w = await world({ errorCode: "token_expired" });
    await expect(canRelaxSingleLaneForAutoRecoverableSource({
      db, companyId: w.companyId, sourceIssueId: w.sourceId, pendingDecisionIds: pendingIds(w), applySafeActions: true,
    })).resolves.toMatchObject({ relax: true, causeClass: "auth_refreshable" });
    expect((await canRelaxSingleLaneForAutoRecoverableSource({
      db, companyId: w.companyId, sourceIssueId: w.sourceId, pendingDecisionIds: pendingIds(w), applySafeActions: false,
    })).reason).toBe("dry_run");
    expect((await canRelaxSingleLaneForAutoRecoverableSource({
      db, companyId: w.companyId, sourceIssueId: w.sourceId, pendingDecisionIds: [], applySafeActions: true,
    })).reason).toBe("no_pending_cards");
    expect((await canRelaxSingleLaneForAutoRecoverableSource({
      db, companyId: w.companyId, sourceIssueId: randomUUID(), pendingDecisionIds: pendingIds(w), applySafeActions: true,
    })).reason).toBe("no_terminal_run");
  });

  const supervise = async (w: World, applySafeActions = true) => {
    const onStaleSourceIssueWakeupRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "w", runId: "r" });
    const svc = missionService(db, { onStaleSourceIssueWakeupRequested });
    const result = await svc.runActiveMissionOwnerSupervision({ companyId: w.companyId,
      staleAfterMinutes: 1, now: T0, applySafeActions, dispatchStaleSourceIssueWakeups: true });
    const findings = result.missions.find((row) => row.missionId === w.missionId)?.findings ?? [];
    return { onStaleSourceIssueWakeupRequested, findings };
  };
  const relaxed = (f: string[]) => f.some((x) => x.includes("stale_source_wakeup_relaxed_auto_recoverable"));
  const deferred = (f: string[]) => f.some((x) => x.includes("stale_source_wakeup_deferred_human_card_pending"));

  it.each([
    { name: "provider_transient adapter_failed", run: { errorCode: "adapter_failed", error: "boom" } },
    { name: "provider_transient 429 text", run: { error: "HTTP 429 rate limited" } },
    { name: "auth_refreshable token_expired", run: { errorCode: "token_expired" } },
  ])("fires the stale-source wakeup despite a pending recovery card ($name)", async ({ run }) => {
    const w = await world(run);
    const { onStaleSourceIssueWakeupRequested, findings } = await supervise(w);
    expect(relaxed(findings)).toBe(true);
    expect(deferred(findings)).toBe(false);
    expect(onStaleSourceIssueWakeupRequested).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "internal_bug assertion_failed", run: { errorCode: "assertion_failed" } },
    { name: "unknown process_lost", run: { errorCode: "process_lost", error: "crash" } },
    { name: "quota_exceeded", run: { errorCode: "quota_exceeded" } },
  ])("stays deferred for non-auto-recoverable causes ($name)", async ({ run }) => {
    const w = await world(run);
    const { onStaleSourceIssueWakeupRequested, findings } = await supervise(w);
    expect(relaxed(findings)).toBe(false);
    expect(deferred(findings)).toBe(true);
    expect(onStaleSourceIssueWakeupRequested).not.toHaveBeenCalled();
  });

  it.each([
    { name: "choice card", ctx: { decisionKind: "choice" } },
    { name: "irreversible card", ctx: { irreversible: true } },
  ])("never relaxes for $name even when the cause is auto-recoverable", async ({ ctx }) => {
    const w = await world({ errorCode: "adapter_failed" }, ctx);
    const { onStaleSourceIssueWakeupRequested, findings } = await supervise(w);
    expect(relaxed(findings)).toBe(false);
    expect(deferred(findings)).toBe(true);
    expect(onStaleSourceIssueWakeupRequested).not.toHaveBeenCalled();
  });

  it("dry-run (applySafeActions: false) preserves the exact deferral behavior", async () => {
    const w = await world({ errorCode: "adapter_failed" });
    const { onStaleSourceIssueWakeupRequested, findings } = await supervise(w, false);
    expect(relaxed(findings)).toBe(false);
    expect(deferred(findings)).toBe(true);
    expect(onStaleSourceIssueWakeupRequested).not.toHaveBeenCalled();
  });
});
