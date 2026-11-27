// server/src/__tests__/human-wait-dag-e2e.integration.test.ts
//
// [stage26 s26-w3] explicit human_wait DAG node wired into the launch loop (embedded PG).
// Proves the structured gate contract end to end through the public execution entries:
//  1) a pending human_wait step creates exactly one operator_decisions card and pauses;
//  2) approving the structured card completes the step (complete_and_continue) and
//     finalizes the run without duplicate cards;
//  3) rejecting the card fails the step (fail_step).
// Only structured operator_decisions rows are consumed — no natural-language parsing (rule 8).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  operatorDecisions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { useControlNodeFixture } from "./helpers/workflow-control-node-fixture.js";
import { executeWorkflowRun, syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import { HUMAN_WAIT_SOURCE_TYPE } from "../services/workflow/human-wait-card.js";
import {
  HUMAN_WAIT_APPROVE_OPTION_ID,
  HUMAN_WAIT_REJECT_OPTION_ID,
} from "../services/workflow/control-flow/human-wait-gate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type DecisionRow = typeof operatorDecisions.$inferSelect;
type StepRunRow = typeof workflowStepRuns.$inferSelect;

describeEmbeddedPostgres("human_wait DAG node launch-loop gate (human-wait-dag-e2e)", () => {
  let db!: ReturnType<typeof createDb>;
  const fixture = useControlNodeFixture();
  beforeAll(() => {
    db = fixture.db;
  });
  // The fixture cleanup does not cover operator_decisions; delete ours first (vitest runs
  // later-registered afterEach hooks before the fixture's teardown that drops companies).
  afterEach(async () => {
    await db.delete(operatorDecisions);
  });

  async function seedRun(): Promise<{ runId: string }> {
    const companyId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Human Wait DAG E2E",
      issuePrefix: `HW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Human wait dag e2e",
      steps: [
        {
          id: "human-approval",
          name: "Human approval",
          type: "human_wait",
          dependencies: [],
          decisionTemplate: { title: "Approve shipment", prompt: "Approve to continue the run." },
        },
      ] as never,
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId: definition.id,
      companyId,
      triggeredBy: "board",
      status: "pending",
      runDate: "2026-12-01",
    });
    return { runId };
  }

  async function humanWaitCards(runId: string): Promise<DecisionRow[]> {
    const rows = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.sourceType, HUMAN_WAIT_SOURCE_TYPE));
    return rows.filter((row) =>
      (row.sourceContext as Record<string, unknown> | null)?.workflowRunId === runId);
  }

  // Mirrors the structured resolution writer contract exactly: one submit action carrying a
  // single approve/reject selection. Test-only CAS update over the durable card row.
  async function resolveCard(decisionId: string, selectedOptionId: string): Promise<void> {
    const now = new Date();
    await db.update(operatorDecisions).set({
      status: "resolved",
      result: { actionId: "submit", outcome: "submit", selectedOptionIds: [selectedOptionId], comment: null },
      resolvedByUserId: "test-operator",
      resolvedAt: now,
      updatedAt: now,
    }).where(and(eq(operatorDecisions.id, decisionId), eq(operatorDecisions.status, "pending")));
  }

  async function readStepRun(runId: string): Promise<StepRunRow> {
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    if (!stepRun) throw new Error(`step run missing for run ${runId}`);
    return stepRun;
  }

  function humanWaitDecision(stepRun: StepRunRow): Record<string, unknown> | null {
    const metadata = (stepRun.metadata && typeof stepRun.metadata === "object"
      ? stepRun.metadata : {}) as Record<string, unknown>;
    const raw = metadata.humanWaitDecision;
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  }

  it("creates exactly one decision card and pauses the run", async () => {
    const { runId } = await seedRun();
    const first = await executeWorkflowRun(db, runId);
    expect(first.status).toBe("running");

    const cards = await humanWaitCards(runId);
    expect(cards).toHaveLength(1);
    expect(cards[0].status).toBe("pending");

    const stepRun = await readStepRun(runId);
    expect(stepRun.status).toBe("pending");
    expect(stepRun.issueId).toBeNull();

    // Re-sync is idempotent: no duplicate card, step stays paused.
    await syncWorkflowRunState(db, runId, "workflow_sync");
    expect(await humanWaitCards(runId)).toHaveLength(1);
    expect((await readStepRun(runId)).status).toBe("pending");
  });

  it("completes the step after structured approval without duplicate cards", async () => {
    const { runId } = await seedRun();
    await executeWorkflowRun(db, runId);
    const [card] = await humanWaitCards(runId);

    await resolveCard(card.id, HUMAN_WAIT_APPROVE_OPTION_ID);
    const result = await syncWorkflowRunState(db, runId, "workflow_sync");
    expect(result.status).toBe("completed");

    const stepRun = await readStepRun(runId);
    expect(stepRun.status).toBe("completed");
    expect(stepRun.issueId).toBeNull();
    expect(humanWaitDecision(stepRun)).toMatchObject({
      reasonCode: "human_decision_approved",
      decisionId: card.id,
    });
    expect(await humanWaitCards(runId)).toHaveLength(1);
  });

  it("fails the step after structured rejection", async () => {
    const { runId } = await seedRun();
    await executeWorkflowRun(db, runId);
    const [card] = await humanWaitCards(runId);

    await resolveCard(card.id, HUMAN_WAIT_REJECT_OPTION_ID);
    const result = await syncWorkflowRunState(db, runId, "workflow_sync");
    expect(result.status).toBe("failed");

    const stepRun = await readStepRun(runId);
    expect(stepRun.status).toBe("failed");
    expect(stepRun.issueId).toBeNull();
    expect(humanWaitDecision(stepRun)).toMatchObject({
      reasonCode: "human_decision_rejected",
      decisionId: card.id,
    });
    expect(await humanWaitCards(runId)).toHaveLength(1);
  });
});
