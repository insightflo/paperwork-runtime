import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { PgSelectBase } from "drizzle-orm/pg-core";
import { createDb, issueWorkProducts } from "@paperclipai/db";
import { genericProducerFixture } from "./helpers/generic-producer-rebind-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueProducerRebind } from "../services/workflow/producer-rebind-issuance.js";
import { selectSameRunWorkProduct } from "../services/workflow/workproduct-same-run.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>, dir: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("rebind-type-fallback-");
  db = createDb(temp.connectionString);
  dir = await mkdtemp(path.join(os.tmpdir(), "rebind-type-fallback-"));
}, 60000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db?.$client.end({ timeout: 5 }); await temp?.cleanup();
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function fixture(type: "document" | "artifact" = "document") {
  const f = await genericProducerFixture(db, dir, { sealed: true });
  await f.patchProduct({ type: type === "document" ? "artifact" : "document", title: "content.json" });
  const scope = { ...f.scope, selector: { type, title: "content.json" } };
  const issue = (pinnedId?: string) => issueProducerRebind(db, {
    companyId: f.companyId, workflowRunId: f.runId, producerStepId: f.stepId, productId: f.product.id,
    actor: { actorType: "system", actorId: "workproduct-selector" },
  }, { selector: scope.selector, pinnedId });
  return { ...f, scope, issue };
}

it.each(["document", "artifact"] as const)("automatically rebinds a %s selector after generation advancement", async type => {
  const f = await fixture(type);
  const locks = vi.spyOn(PgSelectBase.prototype, "for");
  const selected = await selectSameRunWorkProduct(db, f.scope);
  expect(selected).toMatchObject({ product: { id: f.product.id }, file: f.file,
    producer: { executionGeneration: 1 } });
  expect((await f.read()).metadata?.workflowProducerRebind).toMatchObject({ fromGeneration: 1,
    reboundAtGeneration: 3, reason: "automatic_producer_provenance_rebind" });
  expect((await f.read()).sourceExecutionGeneration).toBe(1);
  expect(await f.events()).toHaveLength(1);
  const queries = locks.mock.contexts.map(q => (q as unknown as { toSQL(): { sql: string; params: unknown[] } }).toSQL())
    .filter(q => q.sql.includes('"issue_work_products"."title" ='));
  expect(queries).toHaveLength(2);
  expect(queries.every(q => q.sql.endsWith("for update"))).toBe(true);
  expect(queries.map(q => q.params[2])).toEqual([type, type === "document" ? "artifact" : "document"]);
});

it.each(["missing", "duplicate", "wrong-title", "archived"])("rejects %s fallback selection without issuing authority", async fault => {
  const f = await fixture();
  if (fault === "missing") await f.patchProduct({ type: "file" });
  if (fault === "wrong-title") await f.patchProduct({ title: "other.json" });
  if (fault === "archived") await f.patchProduct({ status: "archived" });
  if (fault === "duplicate") await db.insert(issueWorkProducts).values({ ...await f.read(), id: randomUUID(), isPrimary: false });
  await expect(f.issue()).rejects.toThrow("producer_rebind_selection_changed");
  expect((await f.read()).metadata?.workflowProducerRebind).toBeUndefined();
  expect(await f.events()).toEqual([]);
});

it("does not fall back when exact matches are ambiguous", async () => {
  const f = await fixture(), row = await f.read();
  await db.insert(issueWorkProducts).values([1, 2].map(() => ({ ...row, id: randomUUID(), type: "document", isPrimary: false })));
  await expect(f.issue()).rejects.toThrow("producer_rebind_selection_changed");
  expect(await f.events()).toEqual([]);
});

it("keeps exact-type priority and pinned identity", async () => {
  const f = await fixture(), row = await f.read();
  await db.insert(issueWorkProducts).values({ ...row, id: randomUUID(), type: "document", isPrimary: false });
  await expect(f.issue()).rejects.toThrow("producer_rebind_selection_changed");
  await expect(f.issue(randomUUID())).rejects.toThrow("producer_rebind_selection_changed");
  await expect(f.issue(f.product.id)).resolves.toMatchObject({ status: "rebound", productId: f.product.id });
});

it.each(["bytes", "attempt"])("preserves %s proof on a fallback product", async fault => {
  const f = await fixture();
  if (fault === "bytes") await writeFile(f.file, "changed");
  else await f.patchProducer({ retryCount: 9 });
  await expect(f.issue()).rejects.toThrow(fault === "bytes" ? "producer_rebind_bytes_changed" : "producer_rebind_not_generation_only");
  expect(await f.events()).toEqual([]);
});
