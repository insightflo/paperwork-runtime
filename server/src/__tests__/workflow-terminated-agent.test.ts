import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { adapter, database, fixture } from "./helpers/heartbeat-producer-fixture.js";
import { enqueueAdapterFallbackRun, enqueueProcessLossRetry } from "../services/heartbeat-retry-enqueue.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";
import { resolveWorkflowStepAssigneeAgentId, wakeExistingWorkflowStepIssue } from "../services/workflow/workflow-step-wake.js";

const wakeValues = (f: Awaited<ReturnType<typeof fixture>>, agentId: string, options: {
  status?: string; typed?: boolean;
}) => ({
  companyId: f.companyId, agentId, source: "automation" as const, triggerDetail: "system" as const,
  reason: "workflow_step_runnable", payload: { issueId: f.issueId }, status: options.status ?? "queued",
  requestedByActorType: "system", requestedByActorId: null, requestKind: "workflow_resume",
  issueId: f.issueId, missionId: null, workflowRunId: options.typed === false ? null : f.workflowRunId,
  workflowStepRunId: options.typed === false ? null : f.stepRunId,
  workflowExecutionGeneration: options.typed === false ? null : 7, updatedAt: new Date(),
});

it("selects only same-company runnable name candidates and never falls back from an invalid explicit ID", async () => {
  const f = await fixture(), db = database(), ids = [randomUUID(), randomUUID(), randomUUID()];
  const times = [1, 2, 3].map(n => new Date(1_700_000_000_000 + n));
  await db.insert(agents).values(ids.map((id, i) => ({ id, companyId: f.companyId, name: "Role", adapterType: "codex_local",
    status: ["terminated", "archived", "active"][i]!, createdAt: times[i]! })));
  expect(await resolveWorkflowStepAssigneeAgentId(db, f.companyId, { id: "named", type: "agent", agentName: "Role" } as never)).toBe(ids[2]);
  expect(await resolveWorkflowStepAssigneeAgentId(db, f.companyId, { id: "valid", agentId: f.agentId } as never)).toBe(f.agentId);
  const foreignCompanyId = randomUUID();
  await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign", issuePrefix: `F${foreignCompanyId.replaceAll("-", "")}` });
  const [foreign] = await db.insert(agents).values({ companyId: foreignCompanyId, name: "Role", status: "active", adapterType: "codex_local" }).returning();
  for (const agentId of [...ids.slice(0, 2), randomUUID(), foreign!.id]) {
    expect(await resolveWorkflowStepAssigneeAgentId(db, f.companyId, { id: "invalid", agentId, agentName: "Role" } as never)).toBeUndefined();
  }
  const [pending] = await db.insert(agents).values({ companyId: f.companyId, name: "Pending", status: "pending_approval", adapterType: "codex_local" }).returning();
  expect(await resolveWorkflowStepAssigneeAgentId(db, f.companyId, { id: "pending", agentId: pending!.id } as never)).toBeUndefined();
});

it("refuses an already assigned rework issue before reusing its accepted wake", async () => {
  const f = await fixture(), db = database();
  await insertWorkflowWakeRequest(db, wakeValues(f, f.agentId, {}));
  await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.agentId));
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.workflowRunId));
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
  const result = await wakeExistingWorkflowStepIssue({ db, run: run!, definition: definition!,
    step: { id: "write", name: "Write", type: "agent", agentId: f.agentId, dependencies: [] } as never,
    stepRunId: f.stepRunId, issueId: f.issueId, stepRunMetadata: { workflowReworkContract: { schemaVersion: 1 } } });
  expect(result).toBe(false);
  expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.issueId, f.issueId), eq(agentWakeupRequests.workflowRunId, f.workflowRunId)))).toHaveLength(1);
});

it("validates legacy and deferred enqueue against current agent state while preserving audit rows", async () => {
  const f = await fixture(), db = database();
  expect(await insertWorkflowWakeRequest(db, wakeValues(f, f.agentId, { typed: false }))).toHaveLength(1);
  expect(await insertWorkflowWakeRequest(db, wakeValues(f, f.agentId, {}))).toHaveLength(1);
  await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.agentId));
  for (const values of [wakeValues(f, f.agentId, { typed: false }), wakeValues(f, f.agentId, { status: "deferred_issue_execution" })]) {
    await expect(insertWorkflowWakeRequest(db, values)).rejects.toMatchObject({ code: "heartbeat_agent_not_invokable" });
  }
  expect(await insertWorkflowWakeRequest(db, wakeValues(f, f.agentId, { status: "skipped" }))).toHaveLength(1);
  const missing = wakeValues(f, randomUUID(), { typed: false });
  await expect(insertWorkflowWakeRequest(db, missing)).rejects.toMatchObject({ code: "heartbeat_agent_not_invokable" });
  const foreignCompanyId = randomUUID();
  await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign", issuePrefix: `F${foreignCompanyId.replaceAll("-", "")}` });
  const [foreign] = await db.insert(agents).values({ companyId: foreignCompanyId, name: "Foreign", status: "active", adapterType: "codex_local" }).returning();
  await expect(insertWorkflowWakeRequest(db, wakeValues(f, foreign!.id, { typed: false }))).rejects.toMatchObject({ code: "heartbeat_agent_not_invokable" });
  await db.update(agents).set({ status: "archived" }).where(eq(agents.id, f.agentId));
  await expect(insertWorkflowWakeRequest(db, wakeValues(f, f.agentId, { typed: false }))).rejects.toMatchObject({ code: "heartbeat_agent_not_invokable" });
});

it.each(["process", "fallback"] as const)("blocks stale %s retry without child rows, events, or issue lock changes", async kind => {
  const f = await fixture(), db = database(), { run } = await f.queued(), lockedAt = new Date();
  adapter.mockReset();
  await db.update(issues).set({ executionRunId: run.id, executionLockedAt: lockedAt }).where(eq(issues.id, f.issueId));
  const beforeWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
  const appendRunEvent = vi.fn(async () => {});
  const deps = { db, resolveSessionBeforeForWakeup: async () => null, appendRunEvent };
  await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.agentId));
  await expect(kind === "process"
    ? enqueueProcessLossRetry(deps, run, f.agent, new Date())
    : enqueueAdapterFallbackRun(deps, run, f.agent, new Date(), { fallbackReason: "test" }))
    .rejects.toMatchObject({ code: "heartbeat_agent_not_invokable" });
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id))).toEqual([]);
  expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toHaveLength(beforeWakes.length);
  expect(appendRunEvent).not.toHaveBeenCalled();
  const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
  expect(issue).toMatchObject({ executionRunId: run.id, executionLockedAt: lockedAt });
});

it("holds the agent row lock through workflow wake insertion against a concurrent status update", async () => {
  const f = await fixture(), db = database(); let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), inserted = new Promise<void>(resolve => { entered = resolve; });
  let holderPid = 0;
  const transaction = db.transaction(async tx => {
    const [row] = await tx.execute(sql`select pg_backend_pid() as pid`); holderPid = Number(row!.pid);
    await insertWorkflowWakeRequest(tx as never, wakeValues(f, f.agentId, {})); entered(); await hold;
  });
  await inserted;
  // Drizzle queries are lazy: start the contender before polling its lock wait.
  const update = db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.agentId)).then(() => {});
  let blocked = false; const deadline = Date.now() + 3000;
  try {
    while (Date.now() < deadline && !blocked) {
      const rows = await db.$client`select pg_blocking_pids(pid) as blockers, query from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`;
      blocked = rows.some(row => (row.blockers as number[]).includes(holderPid)
        && /^update "agents" set "status" = \$1/i.test(String(row.query)));
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(blocked).toBe(true);
  } finally { release(); await transaction; await update; }
  const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
  expect(agent!.status).toBe("terminated");
});
