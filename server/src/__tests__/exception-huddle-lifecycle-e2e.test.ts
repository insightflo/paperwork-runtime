import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  collabChannels,
  collabMessages,
  collabThreads,
  companies,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  type Db,
} from "@paperclipai/db";
import {
  conveneExceptionHuddle,
  decideExceptionHuddle,
  getExceptionHuddle,
  postExceptionHuddleTurn,
  type ExceptionHuddleView,
} from "../services/missions/exception-huddle-service.js";
import {
  maybeConveneQaFailureHuddle,
  type QaFailureHuddleInput,
} from "../services/missions/exception-huddle-qa-hook.js";
import {
  evaluateHuddleDecision,
  type ExceptionHuddleState,
} from "../services/missions/exception-huddle-state.js";
import { planExceptionHuddleExecution } from "../services/missions/exception-huddle-executor.js";
import { parseExceptionHuddleDecideToolArgs } from "../services/missions/exception-huddle-tool-spec.js";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

const T0 = new Date("2026-11-28T01:00:00.000Z");
const at = (elapsedMs: number) => new Date(T0.getTime() + elapsedMs);

let db: Db;
let closeDb: () => void = () => undefined;

beforeAll(async () => {
  const terminal = await terminalDatabase();
  db = terminal.db;
  closeDb = terminal.close;
}, 60_000);
afterAll(() => closeDb());

async function seedWorld() {
  const [company] = await db.insert(companies).values({ name: `HuddleLifecycle-${randomUUID()}`, issuePrefix: randomUUID() }).returning();
  const [owner] = await db.insert(agents).values({ companyId: company.id, name: `owner-${randomUUID()}`, status: "running" }).returning();
  const [producer] = await db.insert(agents).values({ companyId: company.id, name: `producer-${randomUUID()}`, status: "running" }).returning();
  const [validator] = await db.insert(agents).values({ companyId: company.id, name: `validator-${randomUUID()}`, status: "running" }).returning();
  const [mission] = await db.insert(missions).values({
    companyId: company.id,
    ownerAgentId: owner.id,
    title: `mission-${randomUUID()}`,
  }).returning();
  const [workflow] = await db.insert(workflowDefinitions).values({
    companyId: company.id,
    missionId: mission.id,
    name: `workflow-${randomUUID()}`,
  }).returning();
  const [run] = await db.insert(workflowRuns).values({
    companyId: company.id,
    missionId: mission.id,
    workflowId: workflow.id,
    triggeredBy: "exception-huddle-lifecycle-e2e",
  }).returning();
  const [issue] = await db.insert(issues).values({
    companyId: company.id,
    missionId: mission.id,
    assigneeAgentId: producer.id,
    title: `issue-${randomUUID()}`,
  }).returning();
  return { company, owner, producer, validator, missionId: mission.id, workflowRunId: run.id, sourceIssueId: issue.id };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

function qaInput(world: World, overrides: Partial<QaFailureHuddleInput> = {}): QaFailureHuddleInput {
  return {
    companyId: world.company.id,
    missionId: world.missionId,
    workflowRunId: world.workflowRunId,
    sourceStepId: "qa-review",
    sourceIssueId: world.sourceIssueId,
    ownerAgentId: world.owner.id,
    producerAgentId: world.producer.id,
    validatorAgentId: world.validator.id,
    verdict: "REQUEST_CHANGES",
    errorCode: null,
    errorSummary: null,
    failureKind: "qa_rejection",
    qaFailureCount: 1,
    workProductLinks: ["work-product://draft-report"],
    failureSummary: "QA rejected unsupported claims in the draft",
    ...overrides,
  };
}

async function invokeQaHook(world: World, overrides: Partial<QaFailureHuddleInput> = {}) {
  const input = qaInput(world, overrides);
  const result = await maybeConveneQaFailureHuddle(input, {
    db,
    convene: (txDb, conveneInput) => conveneExceptionHuddle(txDb, { ...conveneInput, now: T0 }),
  });
  return { input, result };
}

function postTurn(world: World, threadId: string, actorAgentId: string, body: string, elapsedMs: number) {
  return postExceptionHuddleTurn(db, {
    companyId: world.company.id,
    threadId,
    actorAgentId,
    body,
    now: at(elapsedMs),
  });
}

function stateOnly(huddle: ExceptionHuddleView): ExceptionHuddleState {
  const { failureSummary: _failureSummary, ...state } = huddle;
  return state;
}

async function decideWithOwnerTool(world: World, threadId: string, rawDecision: unknown, now: Date) {
  const parsed = parseExceptionHuddleDecideToolArgs({ threadId, decision: rawDecision });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error);
  const current = await getExceptionHuddle(db, world.company.id, threadId);
  if (!current) throw new Error("expected persisted huddle");
  const evaluation = evaluateHuddleDecision(stateOnly(current.huddle), {
    actorAgentId: world.owner.id,
    decision: parsed.decision,
    now,
  });
  expect(evaluation.ok).toBe(true);
  if (!evaluation.ok) throw new Error(evaluation.code);
  expect(evaluation.state.status).toBe("decided");
  const persisted = await decideExceptionHuddle(db, {
    companyId: world.company.id,
    threadId,
    actorAgentId: world.owner.id,
    decision: parsed.decision,
    now,
  });
  return { parsed, evaluation, persisted };
}

async function wakeupsForThread(threadId: string) {
  const rows = await db.select().from(agentWakeupRequests);
  return rows.filter((row) => (row.payload as { threadId?: string } | null)?.threadId === threadId);
}

async function collabRowCounts(companyId: string) {
  const rows = await Promise.all([
    db.select().from(collabChannels).where(eq(collabChannels.companyId, companyId)),
    db.select().from(collabThreads).where(eq(collabThreads.companyId, companyId)),
    db.select().from(collabMessages).where(eq(collabMessages.companyId, companyId)),
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
  ]);
  return rows.map((tableRows) => tableRows.length);
}

async function messageCount(threadId: string) {
  return (await db.select().from(collabMessages).where(eq(collabMessages.threadId, threadId))).length;
}

describe("structured exception huddle lifecycle e2e", () => {
  it("runs first QA failure through two rounds, owner tool decision, and retry execution planning", async () => {
    const world = await seedWorld();
    const { input, result } = await invokeQaHook(world);
    expect(result).toMatchObject({ action: "huddle_convened", skipUnblockIssue: true });
    if (result.action !== "huddle_convened") throw new Error("expected huddle_convened");
    expect(result.huddle.participants).toEqual({
      ownerAgentId: world.owner.id,
      producerAgentId: world.producer.id,
      validatorAgentId: world.validator.id,
    });
    expect(new Set(Object.values(result.huddle.participants)).size).toBe(3);
    expect(await wakeupsForThread(result.threadId)).toHaveLength(3);

    const evidence = await postTurn(world, result.threadId, world.producer.id, "Evidence: every rejected claim is mapped to its source quote.", 10_000);
    expect(evidence.huddle).toMatchObject({ currentRound: 1, status: "open", decision: null });
    expect(evidence.huddle.roundTurns[1]).toEqual(["producer"]);
    const rebuttal = await postTurn(world, result.threadId, world.validator.id, "Rebuttal: two claims still lack exact source citations.", 20_000);
    expect(rebuttal.huddle).toMatchObject({ currentRound: 2, status: "open", decision: null });
    expect(rebuttal.huddle.roundTurns).toEqual({ 1: ["producer", "validator"], 2: [] });

    const revision = await postTurn(world, result.threadId, world.producer.id, "Revision plan: cite the exact source for both claims and rerun QA.", 30_000);
    expect(revision.huddle.roundTurns[2]).toEqual(["producer"]);
    const roundTwoClose = await postTurn(world, result.threadId, world.validator.id, "Validator close-out: the revision plan addresses the rejection evidence.", 40_000);
    expect(roundTwoClose.huddle.roundTurns[2]).toEqual(["producer", "validator"]);

    const beforeCapMessages = await messageCount(result.threadId);
    await expect(postTurn(world, result.threadId, world.owner.id, "extra chatter after the cap", 50_000))
      .rejects.toMatchObject({ status: 409, message: "huddle_round_cap_reached_chair_decision_required" });
    expect(await messageCount(result.threadId)).toBe(beforeCapMessages);

    const retryDecision = {
      kind: "retry_with_guidance",
      rationale: "The rejection evidence is specific enough to correct and retry the same step.",
      guidance: "Cite the exact source for each rejected claim and rerun QA.",
    } as const;
    await expect(decideExceptionHuddle(db, {
      companyId: world.company.id,
      threadId: result.threadId,
      actorAgentId: world.producer.id,
      decision: { ...retryDecision, forcedByChair: false },
      now: at(60_000),
    })).rejects.toMatchObject({ status: 403, message: "huddle_chair_only_decision" });

    const decided = await decideWithOwnerTool(world, result.threadId, retryDecision, at(70_000));
    expect(decided.parsed.decision.forcedByChair).toBe(false);
    expect(decided.evaluation.state.decision?.forcedByChair).toBe(true);
    expect(decided.persisted.nextAction).toBe("retry_with_guidance");
    expect(decided.persisted.huddle).toMatchObject({
      status: "decided",
      decidedByAgentId: world.owner.id,
      decidedAt: at(70_000).toISOString(),
      decision: { kind: "retry_with_guidance", guidance: retryDecision.guidance, forcedByChair: true },
    });

    expect(planExceptionHuddleExecution(decided.persisted.huddle)).toEqual({
      ok: true,
      command: {
        kind: "retry_existing_step",
        createUnblockIssue: false,
        workflowRunId: input.workflowRunId,
        sourceStepId: input.sourceStepId,
        sourceIssueId: input.sourceIssueId,
        guidance: retryDecision.guidance,
        rationale: retryDecision.rationale,
        forcedByChair: true,
        idempotencyKey: `huddle-exec:${input.workflowRunId}:qa-review:retry_with_guidance`,
      },
    });
    const persisted = await getExceptionHuddle(db, world.company.id, result.threadId);
    expect(persisted?.thread.status).toBe("resolved");
    expect(persisted?.huddle.status).toBe("decided");
    expect(persisted?.messages.some((message) => message.actionKind === "channel_result")).toBe(true);
  });

  it("blocks chatter after five minutes and lets only the Owner Chair force accept_with_waiver", async () => {
    const world = await seedWorld();
    const { input, result } = await invokeQaHook(world);
    if (result.action !== "huddle_convened") throw new Error("expected huddle_convened");
    const afterTimeout = new Date(Date.parse(result.huddle.timeoutAt) + 1);
    await expect(postExceptionHuddleTurn(db, {
      companyId: world.company.id,
      threadId: result.threadId,
      actorAgentId: world.producer.id,
      body: "late evidence",
      now: afterTimeout,
    })).rejects.toMatchObject({ status: 409, message: "huddle_timed_out_chair_decision_required" });

    const waiverDecision = {
      kind: "accept_with_waiver",
      rationale: "Only a bounded cosmetic warning remains after the evidence review.",
      waiverCondition: "Waiver is limited to the decorative-image alt-text warning in this draft.",
    } as const;
    await expect(decideExceptionHuddle(db, {
      companyId: world.company.id,
      threadId: result.threadId,
      actorAgentId: world.validator.id,
      decision: { ...waiverDecision, forcedByChair: false },
      now: afterTimeout,
    })).rejects.toMatchObject({ status: 403, message: "huddle_chair_only_decision" });

    const decided = await decideWithOwnerTool(world, result.threadId, waiverDecision, afterTimeout);
    expect(decided.evaluation.state.decision?.forcedByChair).toBe(true);
    expect(decided.persisted.huddle.decision).toMatchObject({ kind: "accept_with_waiver", forcedByChair: true });
    expect(planExceptionHuddleExecution(decided.persisted.huddle)).toEqual({
      ok: true,
      command: {
        kind: "record_waiver_pass",
        workflowRunId: input.workflowRunId,
        sourceStepId: input.sourceStepId,
        sourceIssueId: input.sourceIssueId,
        waiverCondition: waiverDecision.waiverCondition,
        rationale: waiverDecision.rationale,
        forcedByChair: true,
        idempotencyKey: `huddle-exec:${input.workflowRunId}:qa-review:accept_with_waiver`,
      },
    });
  });

  it("falls back without creating huddle rows for runtime, infra, and second QA failures", async () => {
    const cases: Partial<QaFailureHuddleInput>[] = [
      { errorCode: "workproduct_selector_stale_producer" },
      { errorCode: "429" },
      { qaFailureCount: 2 },
    ];
    for (const overrides of cases) {
      const world = await seedWorld();
      const before = await collabRowCounts(world.company.id);
      expect(before).toEqual([0, 0, 0, 0]);
      const { result } = await invokeQaHook(world, overrides);
      expect(result).toMatchObject({ action: "fallback_standard_flow", skipUnblockIssue: false });
      expect(await collabRowCounts(world.company.id)).toEqual(before);
    }
  });

  it.each([
    ["producer", "DECISION: retry_with_guidance"],
    ["owner", "APPROVED"],
  ] as const)("never treats %s prose %s as a huddle decision", async (role, body) => {
    const world = await seedWorld();
    const { result } = await invokeQaHook(world);
    if (result.action !== "huddle_convened") throw new Error("expected huddle_convened");
    const actorAgentId = role === "owner" ? world.owner.id : world.producer.id;
    const posted = await postTurn(world, result.threadId, actorAgentId, body, 1_000);
    expect(posted.message.body).toBe(body);
    expect(posted.huddle).toMatchObject({ status: "open", decision: null, decidedByAgentId: null, decidedAt: null });

    const current = await getExceptionHuddle(db, world.company.id, result.threadId);
    if (!current) throw new Error("expected persisted huddle");
    expect(current.thread.status).toBe("open");
    expect(current.huddle).toMatchObject({ status: "open", decision: null, decidedByAgentId: null, decidedAt: null });
    expect(current.messages.filter((message) => message.actionKind === "channel_result")).toHaveLength(0);
  });
});
