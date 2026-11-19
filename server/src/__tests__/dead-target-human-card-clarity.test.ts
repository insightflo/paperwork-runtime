import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  missions,
  operatorDecisions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { ensureDeadTargetHumanEscalation } from "../services/missions/mission-owner-dead-target-loop.js";
import {
  createMissionOwnerHumanInputDecisionCard,
  isForeignDominantLine,
  SUPERSEDE_FALLBACK_REASON,
  SYMPTOM_EVIDENCE_POINTER,
  SYMPTOM_STATUS_FALLBACK,
} from "../services/missions/mission-owner-human-input-card.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("dead-target human card failure clarity and fallback replacement", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("dead-target-card-clarity-");
    db = createDb(pg.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await pg?.cleanup();
  });

  async function seedWorld(opts: { stepError?: string; loopKey?: string; oversightStatus?: string } = {}) {
    const companyId = randomUUID(), ownerAgentId = randomUUID(), missionId = randomUUID();
    const workflowId = randomUUID(), workflowRunId = randomUUID(), oversightIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Card Clarity Co", issuePrefix: randomUUID().slice(0, 6).toUpperCase() });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Clarity mission", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Onboarding", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, status: "failed", triggeredBy: "test", completedAt: new Date() });
    await db.insert(issues).values({
      id: oversightIssueId, companyId, missionId, title: "[OVERSIGHT] service-onboarding",
      status: opts.oversightStatus ?? "in_progress", originKind: "mission_main_executor_oversight", assigneeAgentId: ownerAgentId,
    });
    if (opts.stepError !== undefined) {
      await db.insert(workflowStepRuns).values({
        workflowRunId, stepId: "collect-service-source", status: "failed", issueId: null,
        lastDispatchErrorSummary: opts.stepError,
      });
    }
    return { companyId, ownerAgentId, missionId, workflowRunId, oversightIssueId };
  }

  it("shows 404 cause, recommends cancel-mission, includes target URL, and drops self-duplicate links on tool-step 404", async () => {
    const stepError =
      'Workflow tool "scrapling-dynamic-fetch" remote endpoint returned status 424: [사람 해석] 수집 대상 주소는 없는 페이지입니다(404). (대상: https://github.com/repos/ray-lea) (원본: {"error":"target fetch failed","targetStatus":404,"url":"https://github.com/repos/ray-lea"})';
    const w = await seedWorld({ stepError });
    const res = await ensureDeadTargetHumanEscalation(db, {
      companyId: w.companyId, missionId: w.missionId, ownerAgentId: w.ownerAgentId,
      loopKey: "tool_recovery_target_missing",
      anchors: [{ id: w.oversightIssueId, status: "in_progress", title: "[OVERSIGHT] service-onboarding", identifier: "RES-1" }],
      ownerActionIssueId: w.oversightIssueId, sourceIssueId: w.oversightIssueId,
      reason: "Tool recovery owner action RES-2 has repeated no_op(target_missing) 3 times: infinite decision-wait loop.",
      evidence: "owner-action=RES-2 reason=target_missing repeats=3",
    });
    expect(res).toEqual({ ensured: true, reason: "card-created" });

    const [card] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, w.companyId));
    expect(card.sourceContext.workflowRunId).toBe(w.workflowRunId);
    const hr = card.definition.humanReview!;
    expect(hr.symptom).toContain("404");
    expect(hr.symptom).not.toContain(SYMPTOM_STATUS_FALLBACK);
    expect(hr.symptom).not.toContain(SYMPTOM_EVIDENCE_POINTER);
    for (const line of (hr.symptom ?? "").split("\n")) {
      expect(isForeignDominantLine(line)).toBe(false);
    }
    expect(hr.interpretation.startsWith("수집 대상 주소는 없는 페이지입니다(404).")).toBe(true);
    expect(card.definition.options.find((o) => o.recommended)?.id).toBe("cancel-mission");
    expect(hr.unresolvedFacts.some((f) => f.includes("404") && f.includes("취소"))).toBe(true);
    expect(hr.evidence.some((e) => e.href === "https://github.com/repos/ray-lea")).toBe(true);
    expect(hr.evidence.filter((e) => e.label === "원천(source) 이슈")).toHaveLength(0);
  });

  it("recommends restart-workflow-from-start and shows 503 cause on retryable tool-step failure", async () => {
    const stepError = 'Workflow tool "scrapling-dynamic-fetch" failed: {"error":"target fetch failed","targetStatus":503,"url":"https://example.com/status"}';
    const w = await seedWorld({ stepError });
    await ensureDeadTargetHumanEscalation(db, {
      companyId: w.companyId, missionId: w.missionId, ownerAgentId: w.ownerAgentId,
      loopKey: "tool_recovery_target_missing",
      anchors: [{ id: w.oversightIssueId, status: "in_progress", title: "[OVERSIGHT] service-onboarding", identifier: "RES-2" }],
      ownerActionIssueId: w.oversightIssueId, sourceIssueId: null,
      reason: "Tool recovery repeated no_op(target_missing) 3 times.",
      evidence: "repeats=3",
    });
    const [card] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, w.companyId));
    const hr = card.definition.humanReview!;
    expect(hr.symptom).toContain("503");
    expect(hr.symptom).not.toContain(SYMPTOM_STATUS_FALLBACK);
    for (const line of (hr.symptom ?? "").split("\n")) {
      expect(isForeignDominantLine(line)).toBe(false);
    }
    expect(hr.interpretation.startsWith("대상 사이트 자체 오류(503)")).toBe(true);
    expect(card.definition.options.find((o) => o.recommended)?.id).toBe("restart-workflow-from-start");
  });

  it("produces pure Korean 2-line symptom when English breaker fires without workflow step error", async () => {
    const w = await seedWorld();
    await ensureDeadTargetHumanEscalation(db, {
      companyId: w.companyId, missionId: w.missionId, ownerAgentId: w.ownerAgentId,
      loopKey: "retry_source_issue",
      anchors: [{ id: w.oversightIssueId, status: "in_progress", title: "[OVERSIGHT]", identifier: null }],
      ownerActionIssueId: w.oversightIssueId, sourceIssueId: null,
      reason: "Owner retry_source_issue targets dead source rejected 3 times (source_terminal).",
      evidence: "notAppliedCount=3",
    });
    const [card] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, w.companyId));
    const hr = card.definition.humanReview!;
    expect(hr.symptom).not.toContain(SYMPTOM_STATUS_FALLBACK);
    expect(hr.symptom).not.toContain(SYMPTOM_EVIDENCE_POINTER);
    for (const line of (hr.symptom ?? "").split("\n")) {
      expect(isForeignDominantLine(line)).toBe(false);
    }
  });

  it("replaces a blank fallback moi1 card on concrete owner diagnosis while keeping repeatCount fold for concrete cards", async () => {
    const w = await seedWorld({ oversightStatus: "in_progress" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: w.companyId, agentId: w.ownerAgentId, issueId: w.oversightIssueId, status: "running",
    });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, w.oversightIssueId));

    // 1) System creates a generic English-stripped fallback moi1 card.
    const blank = await createMissionOwnerHumanInputDecisionCard(db, {
      companyId: w.companyId, missionId: w.missionId, decisionEventId: randomUUID(),
      decision: "escalate", ownerActionIssueId: w.oversightIssueId, ownerActionIssueStatus: "in_progress",
      requestedByAgentId: w.ownerAgentId, actorType: "system",
      reason: "English internal diagnostics only without Korean explanation.",
      evidence: "internal-only", issueTitle: "Oversight", issueIdentifier: "RES-9",
    });
    expect(blank.decision.definition.humanReview?.symptom).toContain(SYMPTOM_STATUS_FALLBACK);

    // 2) Agent submits concrete Korean diagnosis via submitMissionOwnerDecision -> supersedes blank card cleanly.
    const submitted = await submitMissionOwnerDecision({
      db,
      issueId: w.oversightIssueId,
      actor: { actorType: "agent", actorId: w.ownerAgentId, agentId: w.ownerAgentId, runId },
      data: {
        decision: "escalate",
        reason: "입력 주소가 없는 페이지(404)로 확인되어 미션 취소가 필요합니다.",
        evidence: "https://github.com/repos/ray-lea",
        humanRequest: { schemaVersion: 1, requestKey: "owner-404-diagnosis", expectedCurrentLifetimeId: null },
      },
    });
    const allCards = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, w.companyId));
    expect(allCards).toHaveLength(2);
    const cancelledCard = allCards.find((c) => c.id === blank.decision.id)!;
    const pendingCards = allCards.filter((c) => c.status === "pending");
    expect(cancelledCard.status).toBe("cancelled");
    expect(pendingCards).toHaveLength(1);
    expect(pendingCards[0]!.id).toBe(submitted.operatorDecisionId);
    expect(pendingCards[0]!.definition.humanReview?.symptom).toContain("없는 페이지(404)");

    // 3) Concrete moi1 pending card + second concrete moi1 submission still merges via repeatCount (invariant preserved).
    const w2 = await seedWorld();
    const concreteFirst = await createMissionOwnerHumanInputDecisionCard(db, {
      companyId: w2.companyId, missionId: w2.missionId, decisionEventId: randomUUID(),
      decision: "escalate", ownerActionIssueId: w2.oversightIssueId, ownerActionIssueStatus: "in_progress",
      requestedByAgentId: w2.ownerAgentId, actorType: "agent",
      reason: "수집 대상 페이지 응답 지연이 지속되어 확인이 필요합니다.",
      evidence: "https://example.com/slow", issueTitle: "Oversight", issueIdentifier: "RES-10",
    });
    const concreteSecond = await createMissionOwnerHumanInputDecisionCard(db, {
      companyId: w2.companyId, missionId: w2.missionId, decisionEventId: randomUUID(),
      decision: "escalate", ownerActionIssueId: w2.oversightIssueId, ownerActionIssueStatus: "in_progress",
      requestedByAgentId: w2.ownerAgentId, actorType: "agent",
      reason: "다른 구체적 한국어 사유가 추가로 접수되었습니다.",
      evidence: "https://example.com/slow2", issueTitle: "Oversight", issueIdentifier: "RES-10",
    });
    expect(concreteSecond.replayed).toBe(true);
    expect(concreteSecond.decision.id).toBe(concreteFirst.decision.id);
    expect(concreteSecond.decision.sourceContext.missionOwnerHumanInput?.repeatCount).toBe(1);
  });

  it("keeps existing fallback card pending when replacement creation fails and supersedes atomically on replay", async () => {
    expect(SUPERSEDE_FALLBACK_REASON).toBe("superseded_by_concrete_owner_diagnosis");
    const w = await seedWorld({ oversightStatus: "in_progress" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: w.companyId, agentId: w.ownerAgentId, issueId: w.oversightIssueId, status: "running",
    });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, w.oversightIssueId));

    const fallback = await createMissionOwnerHumanInputDecisionCard(db, {
      companyId: w.companyId, missionId: w.missionId, decisionEventId: randomUUID(),
      decision: "escalate", ownerActionIssueId: w.oversightIssueId, ownerActionIssueStatus: "in_progress",
      requestedByAgentId: w.ownerAgentId, actorType: "system",
      reason: "English internal diagnostics only without Korean explanation.",
      evidence: "internal-only", issueTitle: "Oversight", issueIdentifier: "RES-11",
    });

    // Simulate a failing post-commit replacement create (unknown agentId fails ownership inside the tx):
    // withdrawal must roll back so the mission never loses its pending human card.
    await expect(createMissionOwnerHumanInputDecisionCard(db, {
      companyId: w.companyId, missionId: w.missionId, decisionEventId: randomUUID(),
      lifetimeId: randomUUID(), allowSupersedeFallback: true,
      decision: "escalate", ownerActionIssueId: w.oversightIssueId, ownerActionIssueStatus: "in_progress",
      requestedByAgentId: randomUUID(), actorType: "agent",
      reason: "입력 주소가 없는 페이지(404)로 확인되어 미션 취소가 필요합니다.",
      evidence: "https://github.com/repos/ray-lea", issueTitle: "Oversight", issueIdentifier: "RES-11",
    })).rejects.toThrow();

    const afterFailure = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, fallback.decision.id));
    expect(afterFailure[0]!.status).toBe("pending");

    // Subsequent submission / replay while fallback is still pending succeeds atomically and keeps exact idempotency.
    const submitInput = {
      db,
      issueId: w.oversightIssueId,
      actor: { actorType: "agent" as const, actorId: w.ownerAgentId, agentId: w.ownerAgentId, runId },
      data: {
        decision: "escalate" as const,
        reason: "입력 주소가 없는 페이지(404)로 확인되어 미션 취소가 필요합니다.",
        evidence: "https://github.com/repos/ray-lea",
        humanRequest: { schemaVersion: 1 as const, requestKey: "owner-404-atomic-recovery", expectedCurrentLifetimeId: null },
      },
    };
    const firstSubmit = await submitMissionOwnerDecision(submitInput);
    const replaySubmit = await submitMissionOwnerDecision(submitInput);
    expect(replaySubmit.operatorDecisionId).toBe(firstSubmit.operatorDecisionId);

    const finalCards = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, w.companyId));
    expect(finalCards).toHaveLength(2);
    expect(finalCards.find((c) => c.id === fallback.decision.id)!.status).toBe("cancelled");
    expect(finalCards.filter((c) => c.status === "pending").map((c) => c.id)).toEqual([firstSubmit.operatorDecisionId]);
  });
});
