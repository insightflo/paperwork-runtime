import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, issueWorkProducts, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { genericProducerFixture } from "./helpers/generic-producer-rebind-fixture.js";
import { selectSameRunWorkProduct } from "../services/workflow/workproduct-same-run.js";

describe("workproduct selector document/artifact fallback (Stage 35)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let dir: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("wp-type-fallback-");
    db = createDb(temp.connectionString);
    dir = await mkdtemp(path.join(os.tmpdir(), "wp-type-fallback-"));
  }, 60000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await temp?.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("selects a unique local-file artifact when selector asks for document with the same title", async () => {
    const f = await genericProducerFixture(db, dir);
    await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, f.stepRunId));
    await f.patchProduct({ type: "artifact" });

    // Sibling assets with different titles must not interfere
    const row = await f.read();
    await db.insert(issueWorkProducts).values({
      ...row,
      id: randomUUID(),
      title: "infographic.png",
      type: "artifact",
      isPrimary: false,
    });

    const selected = await selectSameRunWorkProduct(db, f.scope);
    expect(selected.product.id).toBe(f.product.id);
    expect(selected.file).toBe(f.file);
  });

  it("still rejects duplicate artifact rows with the same title", async () => {
    const f = await genericProducerFixture(db, dir);
    await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, f.stepRunId));
    await f.patchProduct({ type: "artifact" });
    const row = await f.read();
    await db.insert(issueWorkProducts).values({ ...row, id: randomUUID(), isPrimary: false });

    await expect(selectSameRunWorkProduct(db, f.scope)).rejects.toThrow("workproduct_selector_not_exactly_one");
  });

  it("prefers exact document match when both document and artifact exist", async () => {
    const f = await genericProducerFixture(db, dir);
    await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, f.stepRunId));
    const row = await f.read();
    await db.insert(issueWorkProducts).values({
      ...row,
      id: randomUUID(),
      type: "artifact",
      isPrimary: false,
    });

    const selected = await selectSameRunWorkProduct(db, f.scope);
    expect(selected.product.id).toBe(f.product.id);
  });
});
