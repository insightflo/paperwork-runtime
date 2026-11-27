// Stage 26 Wave 3b: human_wait control-flow gate tests.
// Pure classifier tests cover every structured decision state without natural-language
// parsing; embedded-PG tests cover card-once creation and pause→resume / pause→fail.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, operatorDecisions } from "@paperclipai/db";
import type { OperatorDecisionResultJson } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildHumanWaitDecisionInput } from "../services/workflow/human-wait-card.js";
import {
  HUMAN_WAIT_APPROVE_OPTION_ID,
  HUMAN_WAIT_REJECT_OPTION_ID,
  classifyHumanWaitDecisionRow,
  evaluateHumanWaitGate,
  type HumanWaitDecisionRowShape,
  type HumanWaitGateInput,
} from "../services/workflow/control-flow/human-wait-gate.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

function gateInput(overrides: Partial<HumanWaitGateInput> = {}): HumanWaitGateInput {
  return {
    companyId: randomUUID(),
    missionId: null,
    issueId: null,
    workflowRunId: randomUUID(),
    stepKey: "approve-draft",
    stepName: "Draft review",
    generation: 3,
    decisionTemplate: null,
    ...overrides,
  };
}

function row(status: string, result: OperatorDecisionResultJson | null = null): HumanWaitDecisionRowShape {
  return { status, result };
}

describe("classifyHumanWaitDecisionRow", () => {
  it("pauses on pending rows", () => {
    expect(classifyHumanWaitDecisionRow(row("pending"))).toEqual({
      action: "pause",
      reason: "awaiting_human_decision",
    });
  });

  it("resumes on approve outcome and on approve selection", () => {
    expect(classifyHumanWaitDecisionRow(row("resolved", {
      actionId: "approve",
      outcome: "approve",
      selectedOptionIds: [],
      comment: null,
    }))).toEqual({ action: "resume", resolution: "approved" });
    expect(classifyHumanWaitDecisionRow(row("resolved", {
      actionId: "submit",
      outcome: "submit",
      selectedOptionIds: [HUMAN_WAIT_APPROVE_OPTION_ID],
      comment: null,
    }))).toEqual({ action: "resume", resolution: "approved" });
  });

  it("fails rejected on reject outcome and on reject selection", () => {
    expect(classifyHumanWaitDecisionRow(row("resolved", {
      actionId: "reject",
      outcome: "reject",
      selectedOptionIds: [],
      comment: null,
    }))).toEqual({ action: "fail", resolution: "rejected" });
    expect(classifyHumanWaitDecisionRow(row("resolved", {
      actionId: "submit",
      outcome: "submit",
      selectedOptionIds: [HUMAN_WAIT_REJECT_OPTION_ID],
      comment: null,
    }))).toEqual({ action: "fail", resolution: "rejected" });
  });

  it("fails closed on resolved rows without structured approval authority", () => {
    expect(classifyHumanWaitDecisionRow(row("resolved", {
      actionId: "submit",
      outcome: "submit",
      selectedOptionIds: [],
      comment: null,
    }))).toEqual({ action: "fail", resolution: "rejected" });
    expect(classifyHumanWaitDecisionRow(row("resolved", {
      actionId: "hold",
      outcome: "hold",
      selectedOptionIds: [],
      comment: null,
    }))).toEqual({ action: "fail", resolution: "rejected" });
    expect(classifyHumanWaitDecisionRow(row("resolved", null))).toEqual({ action: "fail", resolution: "rejected" });
  });

  it("fails cancelled as rejected and expired as expired", () => {
    expect(classifyHumanWaitDecisionRow(row("cancelled"))).toEqual({
      action: "fail",
      resolution: "rejected",
    });
    expect(classifyHumanWaitDecisionRow(row("expired"))).toEqual({
      action: "fail",
      resolution: "expired",
    });
  });

  it("fails closed on unrecognized statuses", () => {
    expect(classifyHumanWaitDecisionRow(row("attention"))).toEqual({ action: "fail", resolution: "rejected" });
    expect(classifyHumanWaitDecisionRow(row(""))).toEqual({ action: "fail", resolution: "rejected" });
  });
});

describe("human-wait gate card contract", () => {
  it("keeps gate option ids aligned with the built card definition", () => {
    const input = buildHumanWaitDecisionInput(gateInput());
    expect(input.definition.options.map((option) => option.id)).toEqual([
      HUMAN_WAIT_APPROVE_OPTION_ID,
      HUMAN_WAIT_REJECT_OPTION_ID,
    ]);
    const noReject = buildHumanWaitDecisionInput(gateInput({ decisionTemplate: { allowReject: false } }));
    expect(noReject.definition.options.map((option) => option.id)).toEqual([HUMAN_WAIT_APPROVE_OPTION_ID]);
  });
});

describeDb("evaluateHumanWaitGate", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("human-wait-gate-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb.cleanup();
  });

  afterEach(async () => {
    await db.delete(operatorDecisions);
    await db.delete(companies);
  });

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "HWG", issuePrefix: `G${id.slice(0, 4)}` });
    return id;
  }

  async function resolveCard(decisionId: string, result: OperatorDecisionResultJson): Promise<void> {
    const now = new Date();
    await db.update(operatorDecisions).set({
      status: "resolved",
      result,
      resolvedByUserId: "test-operator",
      resolvedAt: now,
      updatedAt: now,
    }).where(and(eq(operatorDecisions.id, decisionId), eq(operatorDecisions.status, "pending")));
  }

  it("creates the card once, pauses, then resumes after approval without a duplicate card", async () => {
    const companyId = await seedCompany();
    const params = gateInput({ companyId });
    const paused = await evaluateHumanWaitGate(db, params);
    if (paused.action !== "pause") throw new Error(`expected pause, got ${paused.action}`);
    expect(paused.reason).toBe("awaiting_human_decision");
    expect(paused.requestKey.startsWith("human-wait:")).toBe(true);

    const [card] = await db.select().from(operatorDecisions);
    expect(card.id).toBe(paused.decisionId);
    expect(card.status).toBe("pending");

    await resolveCard(paused.decisionId, {
      actionId: "submit",
      outcome: "submit",
      selectedOptionIds: [HUMAN_WAIT_APPROVE_OPTION_ID],
      comment: null,
    });

    const resumed = await evaluateHumanWaitGate(db, params);
    if (resumed.action !== "resume") throw new Error(`expected resume, got ${resumed.action}`);
    expect(resumed.resolution).toBe("approved");
    expect(resumed.decisionId).toBe(paused.decisionId);
    expect(resumed.requestKey).toBe(paused.requestKey);

    const rows = await db.select().from(operatorDecisions);
    expect(rows).toHaveLength(1);
  });

  it("fails after rejection", async () => {
    const companyId = await seedCompany();
    const params = gateInput({ companyId, stepKey: "gate-reject" });
    const paused = await evaluateHumanWaitGate(db, params);
    if (paused.action !== "pause") throw new Error(`expected pause, got ${paused.action}`);

    await resolveCard(paused.decisionId, {
      actionId: "submit",
      outcome: "submit",
      selectedOptionIds: [HUMAN_WAIT_REJECT_OPTION_ID],
      comment: null,
    });

    const failed = await evaluateHumanWaitGate(db, params);
    expect(failed).toEqual({
      action: "fail",
      decisionId: paused.decisionId,
      requestKey: paused.requestKey,
      resolution: "rejected",
    });
    const rows = await db.select().from(operatorDecisions);
    expect(rows).toHaveLength(1);
  });
});
