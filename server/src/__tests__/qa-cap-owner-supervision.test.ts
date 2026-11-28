import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, missions,
  operatorDecisions, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { loadQaCapStepRows, seedQaCapBase, seedQaCapWorkflow,
  seedStepHeartbeat, seedWorkflowVerdict } from "./helpers/qa-cap-oversight-fixture.js";
import { detectQaReworkCapExhaustion, ensureQaReworkCapOversightIssue } from "../services/missions/qa-rework-cap-oversight.js";
import { createOwnerActions } from "../services/missions/owner-actions.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { loadLatestMissionOwnerDecision, loadMissionOwnerDecisions, validateOwnerDecisionEvent } from "../services/missions/mission-owner-recovery-ledger.js";
import { issueService } from "../services/issues.js";
import { missionService } from "../services/missions.js";

describe("QA cap owner assignment, supervision submissions and human routing", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("qa-cap-owner-supervision-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await temp?.cleanup(); });

  async function baseFixture() {
    const base = await seedQaCapBase(db);
    await db.update(companies).set({ issuePrefix: `Q${base.companyId.replaceAll("-", "")}` })
      .where(eq(companies.id, base.companyId));
    return base;
  }
  async function seed(layers: string[] = ["artifact"]) {
    const base = await baseFixture();
    const workflow = await seedQaCapWorkflow(db, base, { iteration: 2 });
    const qa = workflow.qas[0]!;
    const hb = await seedStepHeartbeat(db, base, {
      workflowRunId: workflow.runId, workflowStepRunId: qa.stepRunId, issueId: qa.issueId,
    });
    await seedWorkflowVerdict(db, base, {
      workflowRunId: workflow.runId, workflowStepRunId: qa.stepRunId, issueId: qa.issueId, heartbeatRunId: hb,
    });
    await db.update(workflowTransitionEvents).set({ payload: {
      kind: "workflow_validation_verdict", verdict: "request_changes",
      findings: layers.map((layer, index) => ({ id: `finding-${index}`, summary: "Needs correction", layer })),
    } }).where(eq(workflowTransitionEvents.heartbeatRunId, hb));
    const [mission] = await db.select().from(missions).where(eq(missions.id, base.missionId));
    const [oversight] = await db.insert(issues).values({ companyId: base.companyId, missionId: base.missionId,
      title: "Supervision", originKind: "mission_main_executor_oversight", assigneeAgentId: base.agentId,
      status: "in_progress" }).returning();
    const [exhaustion] = await detectQaReworkCapExhaustion({
      db, companyId: base.companyId, stepRows: await loadQaCapStepRows(db, base),
    });
    expect(exhaustion).toBeDefined();
    const onOwnerActionCreated = async (input: { issue: { id: string; assigneeAgentId: string | null } }) => {
      await db.insert(agentWakeupRequests).values({ companyId: base.companyId, agentId: input.issue.assigneeAgentId!,
        source: "assignment", status: "queued", issueId: input.issue.id, missionId: base.missionId });
    };
    const ensure = (snapshot = mission, executor = db) => ensureQaReworkCapOversightIssue({ db: executor, mission: snapshot,
      oversightIssue: oversight, exhaustion, workflowName: "QA Cap", onOwnerActionCreated,
      createIssue: createOwnerActions({ db, deps: {} }).createMissionOwnerActionIssue });
    return { ...base, workflow, mission, oversight, ensure, onOwnerActionCreated };
  }

  async function checkedOut() {
    const s = await seed();
    const result = await s.ensure();
    const cap = result!.issue;
    // No display text is needed for authorization or the decision target.
    await db.update(issues).set({ description: "display only" }).where(eq(issues.id, cap.id));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: s.agentId,
      issueId: s.oversight.id, status: "running" }).returning();
    await issueService(db).checkout(cap.id, s.agentId, ["todo"], run.id);
    return { ...s, cap, run };
  }
  const submit = (s: Awaited<ReturnType<typeof checkedOut>>, agentId = s.agentId, actorId = agentId) =>
    submitMissionOwnerDecision({ db, issueId: s.cap.id,
      actor: { actorType: "agent", actorId, agentId, runId: s.run.id },
      data: { decision: "retry_source_issue", reworkTargetRef: s.workflow.producerIssueId,
        recoveryTarget: { kind: "issue", issueId: s.workflow.producerIssueId } } });

  it("assigns the current DB owner even when the supervision snapshot has no owner", async () => {
    const s = await seed();
    const result = await s.ensure({ ...s.mission, ownerAgentId: null });
    expect(result?.issue.assigneeAgentId).toBe(s.agentId);
    const [stored] = await db.select().from(issues).where(eq(issues.id, result!.issue.id));
    expect(stored.assigneeAgentId).toBe(s.agentId);
  });

  it("repairs a reused unassigned cap issue before returning it to the wake callback", async () => {
    const s = await seed();
    const first = await s.ensure();
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, first!.issue.id));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, first!.issue.id));
    const second = await s.ensure();
    expect(second?.created).toBe(false);
    expect(second?.issue.id).toBe(first!.issue.id);
    expect(second?.issue.assigneeAgentId).toBe(s.agentId);
    const [stored] = await db.select().from(issues).where(eq(issues.id, first!.issue.id));
    expect(stored.assigneeAgentId).toBe(s.agentId);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, stored.id))).toHaveLength(1);
  });

  it("accepts the checked-out owner's supervision decision and preserves durable readback after checkout ends", async () => {
    const s = await checkedOut();
    const recorded = await submit(s);
    expect((await submit(s)).eventId).toBe(recorded.eventId);
    await db.update(issues).set({ checkoutRunId: null, status: "done" }).where(eq(issues.id, s.cap.id));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.run.id));
    expect((await loadLatestMissionOwnerDecision({ db, companyId: s.companyId,
      ownerActionIssueId: s.cap.id }))?.eventId).toBe(recorded.eventId);
    expect((await loadMissionOwnerDecisions({ db, companyId: s.companyId,
      missionId: s.missionId }))[0]?.eventId).toBe(recorded.eventId);
    expect((await validateOwnerDecisionEvent({ db, companyId: s.companyId, ownerActionIssueId: s.cap.id,
      missionOwnerAgentId: s.agentId, producerIssueId: s.workflow.producerIssueId, producerIdentifier: null,
      producerCompletedAt: s.workflow.producerCompletedAt, decisionEventId: recorded.eventId }))?.eventId).toBe(recorded.eventId);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.run.id));
    expect(run.issueId).toBe(s.oversight.id);
  });

  it("waits for an owner transfer commit before repairing a reused cap assignment", async () => {
    const s = await seed();
    const first = await s.ensure();
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, first!.issue.id));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, first!.issue.id));
    const [next] = await db.insert(agents).values({ companyId: s.companyId,
      name: "next owner", role: "mission_owner", status: "active" }).returning();
    const application = `qa-cap-race-${randomUUID()}`;
    const contender = createDb(`${temp.connectionString}?application_name=${application}`);
    let pending: ReturnType<typeof s.ensure> | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.update(missions).set({ ownerAgentId: next.id }).where(eq(missions.id, s.missionId));
        const [blocker] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        pending = s.ensure(s.mission, contender);
        let waiterPid: number | undefined;
        await vi.waitFor(async () => {
          const rows = await db.execute<{ pid: number; query: string; blocked: boolean }>(sql`
            select pid, query, ${blocker.pid} = any(pg_blocking_pids(pid)) as blocked
            from pg_stat_activity where application_name = ${application} and wait_event_type = 'Lock'`);
          const waiter = rows.find((row) => (!waiterPid || row.pid === waiterPid)
            && row.blocked && /from "missions".*for share/is.test(row.query));
          expect(waiter).toBeDefined();
          waiterPid = waiter!.pid;
        }, { timeout: 3_000, interval: 20 });
      });
      expect((await pending)?.issue.assigneeAgentId).toBe(next.id);
      const [stored] = await db.select().from(issues).where(eq(issues.id, first!.issue.id));
      expect(stored.assigneeAgentId).toBe(next.id);
    } finally { await pending?.catch(() => {}); await contender.$client.end({ timeout: 5 }); }
  });

  it.each(["no_claim", "spoofed_title", "foreign_claim", "wrong_parent_kind", "foreign_parent_mission",
    "null_checkout", "other_checkout", "closed_cap", "hidden_cap", "finished_run", "null_issue", "other_issue",
    "other_agent", "other_company", "non_owner", "inactive_mission", "inactive_agent", "spoofed_actor"])("rejects %s without checkout or ledger writes", async (variant) => {
    const s = await checkedOut();
    if (variant === "no_claim" || variant === "spoofed_title") {
      await db.delete(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.issueId, s.cap.id),
        eq(workflowTransitionEvents.eventType, "qa_cap_oversight_claim")));
      if (variant === "spoofed_title") await db.update(issues).set({ title: "[QA Cap] fake",
        description: "<!-- qa-cap-key:0123456789abcdef0123456789abcdef -->" }).where(eq(issues.id, s.cap.id));
    } else if (variant === "foreign_claim") {
      const other = await baseFixture();
      await db.update(workflowTransitionEvents).set({ companyId: other.companyId, missionId: other.missionId })
        .where(and(eq(workflowTransitionEvents.issueId, s.cap.id), eq(workflowTransitionEvents.eventType, "qa_cap_oversight_claim")));
    } else if (variant === "wrong_parent_kind") {
      await db.update(issues).set({ originKind: "workflow_execution" }).where(eq(issues.id, s.oversight.id));
    } else if (variant === "foreign_parent_mission") {
      const other = await baseFixture();
      await db.update(issues).set({ missionId: other.missionId }).where(eq(issues.id, s.oversight.id));
    } else if (variant === "null_checkout" || variant === "other_checkout") {
      const otherRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: s.companyId,
        agentId: s.agentId, issueId: s.cap.id, status: "succeeded" });
      await db.update(issues).set({ checkoutRunId: variant === "null_checkout" ? null : otherRunId }).where(eq(issues.id, s.cap.id));
    } else if (variant === "closed_cap" || variant === "hidden_cap") {
      await db.update(issues).set(variant === "closed_cap" ? { status: "done" } : { hiddenAt: new Date() }).where(eq(issues.id, s.cap.id));
    } else if (variant === "finished_run") {
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.run.id));
    } else if (variant === "null_issue" || variant === "other_issue") {
      await db.update(heartbeatRuns).set({ issueId: variant === "null_issue" ? null : s.workflow.producerIssueId }).where(eq(heartbeatRuns.id, s.run.id));
    } else if (variant === "other_agent" || variant === "non_owner") {
      const [other] = await db.insert(agents).values({ companyId: s.companyId, name: "not owner", role: "operator" }).returning();
      if (variant === "other_agent") await db.update(heartbeatRuns).set({ agentId: other.id }).where(eq(heartbeatRuns.id, s.run.id));
      else s.agentId = other.id;
    } else if (variant === "other_company") {
      const other = await baseFixture();
      await db.update(heartbeatRuns).set({ companyId: other.companyId }).where(eq(heartbeatRuns.id, s.run.id));
    } else if (variant === "inactive_mission") {
      await db.update(missions).set({ status: "completed" }).where(eq(missions.id, s.missionId));
    } else if (variant === "inactive_agent") {
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, s.agentId));
    }
    const before = await db.select().from(issues).where(eq(issues.id, s.cap.id));
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, s.companyId));
    await expect(submit(s, s.agentId, variant === "spoofed_actor" ? randomUUID() : s.agentId))
      .rejects.toMatchObject({ status: variant === "non_owner" ? 403 : 409 });
    expect(await db.select().from(issues).where(eq(issues.id, s.cap.id))).toEqual(before);
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, s.companyId))).toEqual(events);
  });

  it.each(["other_issue", "other_company", "no_claim", "invalid_claim"])("readers reject %s supervision provenance", async (variant) => {
    const s = await checkedOut();
    await submit(s);
    if (variant === "other_issue") {
      await db.update(heartbeatRuns).set({ issueId: s.workflow.producerIssueId }).where(eq(heartbeatRuns.id, s.run.id));
    } else if (variant === "other_company") {
      const other = await baseFixture();
      await db.update(heartbeatRuns).set({ companyId: other.companyId }).where(eq(heartbeatRuns.id, s.run.id));
    } else {
      const claim = and(eq(workflowTransitionEvents.issueId, s.cap.id), eq(workflowTransitionEvents.eventType, "qa_cap_oversight_claim"));
      if (variant === "no_claim") await db.delete(workflowTransitionEvents).where(claim);
      else await db.update(workflowTransitionEvents).set({ payload: { kind: "spoofed" } }).where(claim);
    }
    expect(await loadLatestMissionOwnerDecision({ db, companyId: s.companyId, ownerActionIssueId: s.cap.id })).toBeNull();
    expect(await loadMissionOwnerDecisions({ db, companyId: s.companyId, missionId: s.missionId })).toEqual([]);
  });

  it.each([
    { layers: ["artifact"], cards: 0 }, { layers: ["source_data"], cards: 1 },
    { layers: ["artifact", "source_data"], cards: 1 }, { layers: [], cards: 0 },
  ])("cap findings $layers create $cards human cards and retain the owner action", async ({ layers, cards }) => {
    const s = await seed(layers);
    const result = await missionService(db, { onOwnerActionCreated: s.onOwnerActionCreated })
      .runMainExecutorSupervision({ missionId: s.missionId });
    expect(result).toBeDefined();
    const claims = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.missionId, s.missionId), eq(workflowTransitionEvents.eventType, "qa_cap_oversight_claim")));
    expect(claims).toHaveLength(1);
    const [ownerIssue] = await db.select().from(issues).where(eq(issues.id, claims[0]!.issueId!));
    expect(ownerIssue.assigneeAgentId).toBe(s.agentId);
    const humanCards = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, s.companyId), eq(operatorDecisions.sourceType, "workflow_qa_rejection")));
    expect(humanCards).toHaveLength(cards);
    if (cards) expect(humanCards[0]!.issueId).toBe(ownerIssue.id);
  });
});
