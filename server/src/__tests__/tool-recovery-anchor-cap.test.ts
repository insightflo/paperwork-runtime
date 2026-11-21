import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { issueService } from "../services/issues.js";
import { ensureToolRecoveryCard, MAX_TOOL_RECOVERY_ANCHORS_PER_STEP_RUN }
  from "../services/missions/tool-recovery-card.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

// Reproduces the 2026-11-22 A1 runaway: one failed (run.id, stepRun.id) kept minting a new
// [Owner Action] issue every supervision tick because anchors had no upper bound.
describe("tool recovery anchor runaway cap", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("tool-anchor-cap-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await temp?.cleanup();
    roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  const closeIssue = (id: string) => issueService(db).update(id, { status: "done" });

  async function seed() {
    const s = await seedToolRecoveryScenario({ db, artifactExists: false });
    roots.push(s.tempRoot);
    const [mission] = await db.select().from(missions).where(eq(missions.id, s.missionId));
    const [oversightIssue] = await db.select().from(issues).where(eq(issues.id, s.oversightIssueId));
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    const [definition] = await db.select().from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, run.workflowId));
    const step = (definition.stepsJson as WorkflowStep[]).find((value) => value.id === stepRun.stepId)!;
    const produce = () => ensureToolRecoveryCard(db, {}, {
      mission, oversightIssue, run, stepRun, step, workflowName: definition.name,
    }, async (tx, companyId, data) =>
      (await tx.insert(issues).values({ ...data, companyId }).returning())[0]);
    const anchors = () => db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, s.companyId),
        eq(workflowTransitionEvents.eventType, "owner_tool_recovery_target_v1"),
      )).then((rows) => rows.length);
    return { produce, anchors };
  }

  it("mints a new recovery issue while anchors are below the cap", async () => {
    const { produce, anchors } = await seed();
    const first = await produce();
    expect(first.created).toBe(true);
    expect(first.issue).not.toBeNull();
    expect(first.issue!.status).toBe("todo");
    expect(await anchors()).toBe(1);
    await closeIssue(first.issue!.id);
    const second = await produce();
    expect(second.created).toBe(true);
    expect(second.issue!.id).not.toBe(first.issue!.id);
    expect(await anchors()).toBe(2);
  });

  it("fails closed at the cap when every anchor is closed", async () => {
    const { produce, anchors } = await seed();
    for (let index = 0; index < MAX_TOOL_RECOVERY_ANCHORS_PER_STEP_RUN; index++) {
      const minted = await produce();
      expect(minted.created).toBe(true);
      await closeIssue(minted.issue!.id);
    }
    expect(await anchors()).toBe(MAX_TOOL_RECOVERY_ANCHORS_PER_STEP_RUN);
    const capped = await produce();
    expect(capped).toMatchObject({ issue: null, created: false });
    expect(await anchors()).toBe(MAX_TOOL_RECOVERY_ANCHORS_PER_STEP_RUN);
    const again = await produce();
    expect(again).toMatchObject({ issue: null, created: false });
    expect(await anchors()).toBe(MAX_TOOL_RECOVERY_ANCHORS_PER_STEP_RUN);
  });

  it("still reuses an open anchor at the cap instead of minting", async () => {
    const { produce, anchors } = await seed();
    for (let index = 0; index < MAX_TOOL_RECOVERY_ANCHORS_PER_STEP_RUN - 1; index++) {
      const minted = await produce();
      expect(minted.created).toBe(true);
      await closeIssue(minted.issue!.id);
    }
    const open = await produce();
    expect(open.created).toBe(true);
    expect(await anchors()).toBe(MAX_TOOL_RECOVERY_ANCHORS_PER_STEP_RUN);
    const reused = await produce();
    expect(reused).toMatchObject({ created: false });
    expect(reused.issue!.id).toBe(open.issue!.id);
    expect(await anchors()).toBe(MAX_TOOL_RECOVERY_ANCHORS_PER_STEP_RUN);
  });
});
