import { randomUUID } from "node:crypto";
import { agents, companies, heartbeatRuns, issues, missions, workflowDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import { and, asc, eq } from "drizzle-orm";

export async function unblockWorld(db: Db, sourceInput: Partial<typeof issues.$inferInsert> = {}) {
  const companyId = randomUUID(), missionId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Unblock guards", issuePrefix: randomUUID(),
    requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "active" });
  const [mission] = await db.insert(missions).values({ id: missionId, companyId,
    ownerAgentId: agentId, title: "Unblock regression", status: "active" }).returning();
  const [source] = await db.insert(issues).values({ companyId, missionId, title: "QA review source",
    status: "blocked", originKind: "manual", assigneeAgentId: agentId, ...sourceInput }).returning();
  const [heartbeat] = await db.insert(heartbeatRuns).values({ companyId, agentId,
    issueId: source!.id, status: "succeeded" }).returning();
  const [definition] = await db.insert(workflowDefinitions).values({ companyId,
    name: "Guard workflow", stepsJson: [] }).returning();
  return { companyId, missionId, agentId, mission: mission!, source: source!, heartbeat: heartbeat!, definition: definition! };
}

export type UnblockWorld = Awaited<ReturnType<typeof unblockWorld>>;
export async function sourceRun(db: Db, w: UnblockWorld, status: string) {
  const [run] = await db.insert(workflowRuns).values({ companyId: w.companyId, missionId: w.missionId,
    workflowId: w.definition.id, status, triggeredBy: "test", createdAt: new Date("2026-11-01T00:00:00Z") }).returning();
  await db.update(issues).set({ originRunId: run!.id }).where(eq(issues.id, w.source.id));
  w.source.originRunId = run!.id;
  return run!;
}

export function anchors(db: Db, w: UnblockWorld) {
  return db.select().from(issues).where(and(eq(issues.companyId, w.companyId), eq(issues.missionId, w.missionId),
    eq(issues.originKind, "mission_main_executor_unblock"), eq(issues.originId, w.source.id)))
    .orderBy(asc(issues.createdAt), asc(issues.id));
}

export async function seedAnchors(db: Db, w: UnblockWorld, count: number) {
  return db.insert(issues).values(Array.from({ length: count }, (_, i) => ({ companyId: w.companyId,
    missionId: w.missionId, originKind: "mission_main_executor_unblock", originId: w.source.id,
    title: `[Unblock] QA ${i}`, assigneeAgentId: w.agentId, status: i % 2 ? "cancelled" : "done",
    createdAt: new Date(Date.UTC(2026, 10, 2, 0, 0, i)),
  }))).returning();
}
