import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  getDbConnectionUrl,
  heartbeatRunFinalizations,
  heartbeatRunFinalizationSteps,
  heartbeatRuns,
  instanceSettings,
  issues,
  missionAgentRuntimes,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  workspaceOperations,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { ensureFinalization, recordStage } from "../services/heartbeat-finalization/finalization-state.js";
import { recoverTerminalUnsettledRuns } from "../services/heartbeat-finalization/recovery.js";
import { C_STAGE, Q_STAGE, STAGE_CLASS } from "../services/heartbeat-finalization/stage-classifier.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/settler/target/release/paperclip-settler");
const origSettlerBin = process.env.PAPERCLIP_SETTLER_BIN;
const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

function restoreEnv(): void {
  if (origSettlerBin === undefined) delete process.env.PAPERCLIP_SETTLER_BIN;
  else process.env.PAPERCLIP_SETTLER_BIN = origSettlerBin;
}

describeEP("paperclip-settler Rust parity and safety invariants", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  const oldFinished = new Date("2026-03-19T00:00:00.000Z");
  const recoveryNow = new Date("2026-03-19T00:10:00.000Z");

  beforeAll(async () => {
    const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
    const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
    execFileSync(cargoBin, ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/settler/Cargo.toml")], {
      encoding: "utf8",
    });
    tempDb = await startEmbeddedPostgresTestDatabase("rust-settler-parity-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "SettlerCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Settler Agent", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(instanceSettings).values({
      singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: false },
    } as never);
  }, 240_000);

  afterEach(restoreEnv);
  afterAll(() => { restoreEnv(); tempDb = null; });

  async function seedRun(overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    const issueId = (overrides.issueId as string | undefined) ?? randomUUID();
    if (!overrides.skipIssueInsert) {
      await db.insert(issues).values({ id: issueId, companyId, title: `Settler issue ${id}` });
    }
    const { skipIssueInsert: _skip, ...cols } = overrides;
    await db.insert(heartbeatRuns).values({
      id, companyId, agentId, invocationSource: "on_demand", status: "failed",
      executionScopeKind: "issue_nonworkflow", finalizationVersion: 1, executionEpoch: 0,
      executionToken: randomUUID(), executorOwnerId: "default", executorOwnerLeaseEpoch: 1,
      executorOwnerLeaseToken: randomUUID(), executorOwnerReleasedAt: oldFinished,
      terminalOutcome: "failed", terminalDecisionSource: "heartbeat_status:failed",
      processPid: null, issueId, finishedAt: oldFinished, updatedAt: oldFinished, ...cols,
    } as never);
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  }

  it("respects feature flag OFF, then blocks Q quiescence gaps (release, live pid, workspace op, mission runtime)", async () => {
    const unreleased = await seedRun({ executorOwnerReleasedAt: null });
    process.env.PAPERCLIP_SETTLER_BIN = rustBin;
    expect(await recoverTerminalUnsettledRuns(db, recoveryNow, 5 * 60_000)).toBe(0);

    await db.update(instanceSettings).set({ experimental: { enableHeartbeatFinalizationV1: true } });
    const livePidRun = await seedRun({ processPid: process.pid });
    const runningOpRun = await seedRun();
    await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: runningOpRun.id, phase: "teardown", status: "running" });
    const runningSvcRun = await seedRun();
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(), companyId, scopeType: "project_workspace", serviceName: "svc",
      status: "running", lifecycle: "ephemeral", provider: "local", startedByRunId: runningSvcRun.id,
    });
    const missionId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "BusyM", status: "active" });
    const busyMissionRun = await seedRun({ executionScopeKind: "mission_nonworkflow" });
    await db.insert(missionAgentRuntimes).values({
      companyId, missionId, agentId, adapterType: "codex_local",
      runtimeKey: `k:${missionId}`, status: "busy", lastRunId: busyMissionRun.id, stoppedAt: null,
    });

    const processed = await recoverTerminalUnsettledRuns(db, recoveryNow, 5 * 60_000);
    expect(processed).toBeGreaterThanOrEqual(5);
    for (const r of [unreleased, livePidRun, runningOpRun, runningSvcRun, busyMissionRun]) {
      const [row] = await db.select({ settledAt: heartbeatRuns.settledAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, r.id));
      expect(row?.settledAt).toBeNull();
    }
  });

  it("blocks dead_letter Q permanently, accepts pre-recorded equivalent_failed C, and matches TS workflow + agent release", async () => {
    await db.update(instanceSettings).set({ experimental: { enableHeartbeatFinalizationV1: true } });
    const deadQRun = await seedRun();
    const fin = await ensureFinalization(db, deadQRun, oldFinished);
    await recordStage(db, {
      companyId, runId: deadQRun.id, finalizationId: fin.id,
      stageClass: STAGE_CLASS.quiescence, stageKind: Q_STAGE.executorQuiescence, idempotencyKey: "q:dead", state: "dead_letter",
    });

    const equivRun = await seedRun();
    const eqFin = await ensureFinalization(db, equivRun, oldFinished);
    await recordStage(db, {
      companyId, runId: equivRun.id, finalizationId: eqFin.id,
      stageClass: STAGE_CLASS.compensable, stageKind: C_STAGE.issuePromotion,
      idempotencyKey: `settle-c:${C_STAGE.issuePromotion}:${equivRun.id}`, state: "equivalent_failed",
    });

    const wfId = randomUUID();
    const wfRunId = randomUUID();
    const stepId = randomUUID();
    const staleStepId = randomUUID();
    const missionId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "WfM", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "SettlerWF",
      stepsJson: [{ id: "s1", name: "S1", orderIndex: 0 }, { id: "s2", name: "S2", orderIndex: 1 }],
    });
    await db.insert(workflowRuns).values({
      id: wfRunId, companyId, workflowId: wfId, missionId, status: "running", triggeredBy: "test",
    });
    await db.insert(workflowStepRuns).values([
      { id: stepId, workflowRunId: wfRunId, stepId: "s1", status: "completed", executionGeneration: 1, metadata: {} },
      { id: staleStepId, workflowRunId: wfRunId, stepId: "s2", status: "running", executionGeneration: 2, metadata: {} },
    ]);

    const wfAgentId = randomUUID();
    await db.insert(agents).values({
      id: wfAgentId, companyId, name: "WF Agent", status: "running",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const wfSettleRun = await seedRun({
      agentId: wfAgentId, status: "succeeded", terminalOutcome: "succeeded",
      executionScopeKind: "workflow_step", workflowStepRunId: stepId, workflowExecutionGeneration: 1,
    });
    const staleGenRun = await seedRun({
      executionScopeKind: "workflow_step", workflowStepRunId: staleStepId, workflowExecutionGeneration: 1,
    });

    const events: string[] = [];
    const unsub = subscribeCompanyLiveEvents(companyId, (ev) => {
      if (ev.type === "agent.status") events.push(`${ev.payload.agentId}:${ev.payload.status}`);
    });
    process.env.PAPERCLIP_SETTLER_BIN = rustBin;
    try {
      await recoverTerminalUnsettledRuns(db, recoveryNow, 5 * 60_000);
    } finally {
      unsub();
    }

    const [deadRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, deadQRun.id));
    const [deadFin] = await db.select().from(heartbeatRunFinalizations).where(eq(heartbeatRunFinalizations.heartbeatRunId, deadQRun.id));
    expect(deadRow?.settledAt).toBeNull();
    expect(deadFin?.state).toBe("blocked_noncompensable");

    const [eqRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, equivRun.id));
    const eqSteps = await db.select().from(heartbeatRunFinalizationSteps).where(eq(heartbeatRunFinalizationSteps.heartbeatRunId, equivRun.id));
    expect(eqRow?.settledAt).not.toBeNull();
    expect(eqSteps.some((s) => s.stageKind === C_STAGE.issuePromotion && s.state === "equivalent_failed")).toBe(true);

    const [s1Row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepId));
    const [s2Row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, staleStepId));
    const [staleRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, staleGenRun.id));
    const [txEv] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.heartbeatRunId, wfSettleRun.id));
    const [agentAfter] = await db.select().from(agents).where(eq(agents.id, wfAgentId));
    expect(s1Row?.dispatchReadyAt).not.toBeNull();
    expect(s2Row?.dispatchReadyAt).toBeNull();
    expect(staleRow?.settledAt).not.toBeNull();
    expect(txEv?.idempotencyKey).toBe(`heartbeat-settled:${wfSettleRun.id}`);
    expect(agentAfter?.status).toBe("idle");
    expect(events).toContain(`${wfAgentId}:idle`);
  });

  it("falls back cleanly to TypeScript inside transactions and on missing binary", async () => {
    await db.update(instanceSettings).set({ experimental: { enableHeartbeatFinalizationV1: true } });
    const run = await seedRun();
    process.env.PAPERCLIP_SETTLER_BIN = rustBin;
    await db.transaction(async (tx) => {
      expect(getDbConnectionUrl(tx)).toBeNull();
      const n = await recoverTerminalUnsettledRuns(tx as unknown as typeof db, recoveryNow, 5 * 60_000);
      expect(n).toBeGreaterThanOrEqual(1);
    });
    const run2 = await seedRun();
    process.env.PAPERCLIP_SETTLER_BIN = "/nonexistent/paperclip-settler-missing";
    expect(await recoverTerminalUnsettledRuns(db, recoveryNow, 5 * 60_000)).toBeGreaterThanOrEqual(1);
    const [row1] = await db.select({ settledAt: heartbeatRuns.settledAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [row2] = await db.select({ settledAt: heartbeatRuns.settledAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run2.id));
    expect(row1?.settledAt).not.toBeNull();
    expect(row2?.settledAt).not.toBeNull();
  });
});
