import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { genericProducerFixture } from "./helpers/generic-producer-rebind-fixture.js";
import { ProducerRebindIssuanceFailed } from "../services/workflow/automatic-producer-rebind.js";
import { isAdoptProducerEditsEligible } from "../services/missions/mission-owner-adopt-producer-edits.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let dir: string;

beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("stale-producer-diag-");
  db = createDb(temp.connectionString);
  dir = await mkdtemp(path.join(os.tmpdir(), "stale-producer-diag-"));
}, 60_000);

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await temp?.cleanup();
  if (dir) await rm(dir, { recursive: true, force: true });
});

type Fixture = Awaited<ReturnType<typeof genericProducerFixture>>;

async function seedIterationMismatch() {
  const f = await genericProducerFixture(db, dir, { sealed: true });
  await db.update(workflowStepRuns).set({ iterationIndex: 1 })
    .where(eq(workflowStepRuns.id, f.stepRunId));
  return f;
}

async function expectDiagnostic(f: Fixture, conflictReason: string) {
  const before = await f.read();
  const failure = await f.select().then(() => null, error => error);
  if (!(failure instanceof ProducerRebindIssuanceFailed)) {
    throw new Error(`expected ProducerRebindIssuanceFailed, received ${String(failure)}`);
  }
  expect(failure.message).toBe("workproduct_selector_stale_producer");
  expect(failure.diagnostic).toEqual({
    schemaVersion: "workflow.producer-rebind-diagnostic.v1",
    outcome: "issuance-failed",
    conflictReason,
    scope: {
      companyId: f.companyId,
      workflowRunId: f.runId,
      producerStepId: f.stepId,
      productId: f.product.id,
    },
  });
  expect(await f.read()).toEqual(before);
  expect(await f.events()).toEqual([]);
}

describe("stale producer rebind diagnostic P0", () => {
  it("attaches producer_rebind_iteration_mismatch when only the rework iteration is stale", async () => {
    const f = await seedIterationMismatch();
    await expectDiagnostic(f, "producer_rebind_iteration_mismatch");
  });

  it("attaches producer_rebind_bytes_changed when the sealed disk bytes also changed", async () => {
    const f = await seedIterationMismatch();
    await writeFile(f.file, "changed bytes");
    await expectDiagnostic(f, "producer_rebind_bytes_changed");
  });

  it.each(["producer_rebind_bytes_changed", "producer_rebind_iteration_mismatch"])(
    "marks stale-producer diagnostic %s as adopt-producer-edits eligible", conflictReason => {
      expect(isAdoptProducerEditsEligible({
        dispatchError: "workproduct_selector_stale_producer",
        producerRebindDiagnostic: { conflictReason },
      })).toBe(true);
    });

  it("keeps direct byte mismatch eligible and rejects unrelated or absent diagnostics", () => {
    expect(isAdoptProducerEditsEligible({ dispatchError: "workproduct_selector_rebind_bytes_mismatch" })).toBe(true);
    expect(isAdoptProducerEditsEligible({
      dispatchError: "workproduct_selector_stale_producer",
      producerRebindDiagnostic: { conflictReason: "producer_rebind_not_generation_only" },
    })).toBe(false);
    expect(isAdoptProducerEditsEligible({
      dispatchError: "workproduct_selector_stale_producer",
    })).toBe(false);
    expect(isAdoptProducerEditsEligible(null)).toBe(false);
  });
});
