// [purpose] Stage34-W3 — 두 워크플로 엔진 결함의 회귀 테스트.
//   bug#2: workflow_run 이 failed/cancelled 로 종결될 때 남은 running/queued step_run 이
//          같은 트랜잭션에서 failed 로 정산되지 않아 run=failed + step=running 불일치가
//          영속하던 문제(관측 run 96672582).
//   bug#8: 하류 step 이 선행 producer 에 붙은 QA/validator step 이 아직 비종말인데도
//          dispatch 가능했던 문제(관측 run f05dde93 — RES-12910 조기 발화). fail-closed
//          readiness: 선행에 첨부된 QA 가 pending/queued/running 이면 하류는 대기해야 한다.
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  cleanupTerminalBoundaryTables,
  seedBoundaryWorld,
  type BoundaryWorld,
} from "./helpers/run-terminal-boundary-fixture.js";
import { finalizeRunTerminal, type FinalizeRunTerminalInput } from "../services/workflow/run-terminal-boundary.js";
import { settleDeadlockFailureCascade } from "../services/workflow/failure-cascade-finalization.js";
import { findRunnableSteps } from "../services/workflow/dag-readiness-facts.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping embedded-postgres cases: ${support.reason ?? "unsupported host"}`);
}

// ── bug#8 사양 표본: producer → QA(producer 첨부) → consumer(producer 만 의존) ──
function dagSteps(): WorkflowStep[] {
  return [
    { id: "producer", name: "producer", agentId: "a", dependencies: [], type: "action" },
    { id: "qa", name: "qa", agentId: "a", dependencies: ["producer"], qaType: "delivery-verification" },
    { id: "consumer", name: "consumer", agentId: "a", dependencies: ["producer"], type: "action" },
  ] as unknown as WorkflowStep[];
}

function stepRunMapOf(steps: WorkflowStep[], runs: Array<{ stepId: string; status: string }>) {
  void steps;
  const now = new Date();
  return new Map(runs.map((run, index) => [run.stepId, {
    id: `run-${index}`, workflowRunId: "wf-run", stepId: run.stepId, issueId: null,
    status: run.status, metadata: {}, startedAt: run.status === "running" ? now : null,
    completedAt: ["completed", "failed", "skipped"].includes(run.status) ? now : null,
  }]));
}

function runnableStepIds(steps: WorkflowStep[], runs: Array<{ stepId: string; status: string }>) {
  return findRunnableSteps(steps, stepRunMapOf(steps, runs) as Parameters<typeof findRunnableSteps>[1])
    .map((step) => step.id);
}

describe("bug#8 upstream QA closure readiness (pure)", () => {
  const steps = dagSteps();

  it("consumer waits (not launched) while the producer's attached QA step is running", () => {
    const runnable = runnableStepIds(steps, [
      { stepId: "producer", status: "completed" },
      { stepId: "qa", status: "running" },
      { stepId: "consumer", status: "pending" },
    ]);
    expect(runnable).not.toContain("consumer");
    // qa 는 이미 running(발화됨) — findRunnableSteps 은 pending 발화 후보만 반환하므로 여기서도 제외된다.
    expect(runnable).toEqual([]);
  });

  it("consumer dispatches once the attached QA step reaches a terminal status", () => {
    for (const qaStatus of ["completed", "failed", "skipped", "cancelled"]) {
      expect(runnableStepIds(steps, [
        { stepId: "producer", status: "completed" },
        { stepId: "qa", status: qaStatus },
        { stepId: "consumer", status: "pending" },
      ])).toContain("consumer");
    }
  });

  it("a not-yet-materialized QA step run does not block (dynamic launch scope)", () => {
    expect(runnableStepIds(steps, [
      { stepId: "producer", status: "completed" },
      { stepId: "consumer", status: "pending" },
    ])).toContain("consumer");
  });

  it("the attached QA step itself stays gated only by its own edges (no sibling/self deadlock)", () => {
    const qaSiblings: WorkflowStep[] = [
      { id: "producer", name: "producer", agentId: "a", dependencies: [], type: "action" },
      { id: "qa1", name: "qa1", agentId: "a", dependencies: ["producer"], qaType: "delivery-verification" },
      { id: "qa2", name: "qa2", agentId: "a", dependencies: ["producer"], qaType: "delivery-verification" },
    ] as unknown as WorkflowStep[];
    const runs = [
      { stepId: "producer", status: "completed" },
      { stepId: "qa1", status: "pending" },
      { stepId: "qa2", status: "pending" },
    ];
    expect(runnableStepIds(qaSiblings, runs)).toEqual(expect.arrayContaining(["qa1", "qa2"]));
  });
});

// ── bug#2 임베디드 PG 사양 ──
function failedInput(world: BoundaryWorld, overrides?: Partial<FinalizeRunTerminalInput>): FinalizeRunTerminalInput {
  return {
    runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
    decision: "failed",
    cause: { policy: "recovery_deadline_hard", discovery: "stuck_diagnostic", origin: "reconciler", reason: "stale running step" },
    gatePolicy: "defer_on_open_recovery", now: new Date(), stepRuns: [], ...overrides,
  };
}

function cancelledInput(world: BoundaryWorld, overrides?: Partial<FinalizeRunTerminalInput>): FinalizeRunTerminalInput {
  return {
    runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
    decision: "cancelled",
    cause: { policy: "operator_cancel", discovery: "engine_failure", origin: "reconciler" },
    gatePolicy: "immediate", now: new Date(), stepRuns: [], ...overrides,
  };
}

async function stepRunRows(db: ReturnType<typeof createDb>, runId: string) {
  return await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
}

describeEP("bug#2 terminal run settles running step runs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("w3-failed-run-qa-readiness-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupTerminalBoundaryTables(db);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("finalizeRunTerminal(failed) settles a running step run to failed with completion stamp and reason", async () => {
    const world = await seedBoundaryWorld(db, { runStatus: "running" });
    const result = await finalizeRunTerminal(db, failedInput(world));
    expect(result.kind).toBe("finalized");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, world.runId));
    expect(run?.status).toBe("failed");
    const rows = await stepRunRows(db, world.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.completedAt).not.toBeNull();
    const settlement = (rows[0]?.metadata as Record<string, unknown>).terminalRunSettlement as Record<string, unknown> | undefined;
    expect(settlement?.decision).toBe("failed");
    expect(typeof settlement?.settledAt).toBe("string");
  });

  it("finalizeRunTerminal(cancelled) settles a running step run to failed", async () => {
    const world = await seedBoundaryWorld(db, { runStatus: "running" });
    const result = await finalizeRunTerminal(db, cancelledInput(world));
    expect(result.kind).toBe("finalized");
    const rows = await stepRunRows(db, world.runId);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.completedAt).not.toBeNull();
  });

  it("finalizeRunTerminal(completed) leaves non-launch step runs untouched", async () => {
    const world = await seedBoundaryWorld(db, { runStatus: "running" });
    const result = await finalizeRunTerminal(db, {
      ...failedInput(world),
      decision: "completed",
      cause: { policy: "outcome_convergence", discovery: "engine_recompute", origin: "dag_engine" },
      gatePolicy: "immediate",
    });
    expect(result.kind).toBe("finalized");
    const rows = await stepRunRows(db, world.runId);
    expect(rows[0]?.status).toBe("running");
  });

  it("legacy deadlock cascade (boundary off) settles the stale running step when the run is marked failed", async () => {
    const world = await seedBoundaryWorld(db, { runStatus: "running" });
    // pending skip 대상 step 추가(issue 없음 — deadlock 이슈 블록 우회).
    await db.insert(workflowStepRuns).values({
      workflowRunId: world.runId, stepId: "step-b", status: "pending", issueId: null, metadata: {},
    });
    const rows = await stepRunRows(db, world.runId);
    const toStep = (row: typeof rows[number]) => ({
      id: row.id, stepId: row.stepId, issueId: row.issueId, status: row.status,
      metadata: row.metadata, statusTransitionVersion: row.statusTransitionVersion,
      dispatchReadyAt: row.dispatchReadyAt,
    });
    const running = rows.find((row) => row.status === "running")!;
    const pending = rows.find((row) => row.status === "pending")!;
    const result = await settleDeadlockFailureCascade(db, {
      run: { id: world.runId, companyId: world.companyId, missionId: world.missionId,
        status: "running", dispatchAuthorityVersion: 0 },
      stepsToSkip: [toStep(pending)],
      runSteps: rows.map(toStep),
      boundaryEnabled: false,
      now: new Date(),
      mayFinalize: true,
    });
    expect(result?.action).toBe("recovered");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, world.runId));
    expect(run?.status).toBe("failed");
    const after = await stepRunRows(db, world.runId);
    expect(after.find((row) => row.id === running.id)?.status).toBe("failed");
    expect(after.find((row) => row.id === pending.id)?.status).toBe("skipped");
    const settled = after.find((row) => row.id === running.id)!;
    expect(settled.completedAt).not.toBeNull();
  });
});
