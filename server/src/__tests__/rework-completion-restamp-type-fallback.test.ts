import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, issueWorkProducts, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { genericProducerFixture } from "./helpers/generic-producer-rebind-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { restampReworkProductsOnCompletion } from "../services/workflow/rework-completion-restamp.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>, dir: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("restamp-type-fallback-");
  db = createDb(temp.connectionString);
  dir = await mkdtemp(path.join(os.tmpdir(), "restamp-type-fallback-"));
}, 60000);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 }); await temp?.cleanup();
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function fixture(type: "document" | "artifact" = "document") {
  const f = await genericProducerFixture(db, dir, { sealed: true });
  await f.patchProduct({ type: type === "document" ? "artifact" : "document" });
  await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, f.stepRunId));
  await f.patchHeartbeat({ contextSnapshot: {
    paperclipWorkflowReworkContract: { kind: "workflow_qa_rework", producerStepId: f.stepId },
  } });
  if (type === "artifact") {
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
    const steps = definition.stepsJson.map(step => step.id === "consume"
      ? { ...step, workProductSelectors: { [f.stepId]: { type, title: "data.json" } } } : step);
    await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, definition.id));
  }
  const restamp = () => restampReworkProductsOnCompletion({ db, companyId: f.companyId,
    issueId: f.issueId, heartbeatRunId: f.heartbeatId });
  return { ...f, restamp };
}

it.each(["document", "artifact"] as const)("restamps the unique alternate for a %s selector", async type => {
  const f = await fixture(type);
  expect(await f.restamp()).toBe(1);
  expect((await f.read()).metadata).toMatchObject({ registeredVia: "workflow_completion",
    registeredByRunId: f.heartbeatId, workflowProducer: f.originalProducer });
});

it.each(["missing", "duplicate", "wrong-title", "archived"])("rejects %s fallback before restamping", async fault => {
  const f = await fixture();
  if (fault === "missing") await f.patchProduct({ type: "file" });
  if (fault === "wrong-title") await f.patchProduct({ title: "other.json" });
  if (fault === "archived") await f.patchProduct({ status: "archived" });
  if (fault === "duplicate") await db.insert(issueWorkProducts).values({ ...await f.read(), id: randomUUID(), isPrimary: false });
  const before = await f.read();
  await expect(f.restamp()).rejects.toThrow("rework_completion_product_selection_unproven");
  expect(await f.read()).toEqual(before);
});

it("restamps only the exact match when an alternate also exists", async () => {
  const f = await fixture(), before = await f.read();
  const exactId = randomUUID();
  await db.insert(issueWorkProducts).values({ ...before, id: exactId, type: "document", isPrimary: false });
  expect(await f.restamp()).toBe(1);
  expect(await f.read()).toEqual(before);
  const [exact] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, exactId));
  expect(exact.metadata?.registeredVia).toBe("workflow_completion");
});

it("does not use a unique alternate to resolve ambiguous exact matches", async () => {
  const f = await fixture(), row = await f.read();
  await db.insert(issueWorkProducts).values([1, 2].map(() => ({ ...row, id: randomUUID(), type: "document", isPrimary: false })));
  await expect(f.restamp()).rejects.toThrow("rework_completion_product_selection_unproven");
});

it("preserves current heartbeat generation checks", async () => {
  const f = await fixture();
  await db.update(workflowStepRuns).set({ executionGeneration: 2 }).where(eq(workflowStepRuns.id, f.stepRunId));
  const before = await f.read();
  await expect(f.restamp()).rejects.toThrow("rework_completion_producer_stale");
  expect(await f.read()).toEqual(before);
});
