import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { issueWorkProducts, workflowStepOutputBindings } from "@paperclipai/db";
import { createCommitSourceHarness, issueC02 } from "./helpers/c02-fixture.js";
import { readSelectedQaCorrections } from "../services/workflow/control-flow/qa-correction-selection.js";
import { selectSameRunWorkProduct } from "../services/workflow/workproduct-same-run.js";

let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
beforeAll(async () => { owned = await createCommitSourceHarness(); }, 60000);
afterAll(async () => { await owned?.close(); });
async function fixture(type: "document" | "artifact" = "document") {
  const c = await issueC02(owned, { mode: "content-only" });
  const revision = c.applied.revisions[0]!;
  await c.peer.update(issueWorkProducts).set({ type: type === "document" ? "artifact" : "document" })
    .where(eq(issueWorkProducts.id, revision.workProductId));
  const scope = { companyId: c.s.p.companyId, workflowRunId: c.s.p.workflowRunId,
    consumerStepRunId: c.s.f.qa.id, selectors: { produce: { type, title: "report" } } };
  const select = () => readSelectedQaCorrections(c.peer, scope);
  const read = async () => (await c.peer.select().from(issueWorkProducts)
    .where(eq(issueWorkProducts.id, revision.workProductId)))[0]!;
  return { ...c, revision, scope, select, read };
}

it.each(["document", "artifact"] as const)("classifies a unique corrected alternate for a %s selector", async type => {
  const c = await fixture(type), before = await c.read();
  const selections = await c.select();
  expect(selections).toHaveLength(1);
  expect(selections[0]).toMatchObject({ stepId: "produce", selected: {
    product: { id: c.revision.workProductId }, producer: c.s.producer,
    correction: { revision: c.revision },
  }, consumer: { binding: { row: { id: c.s.f.bindingId } } } });
  expect(await c.read()).toEqual(before);
  expect(await selectSameRunWorkProduct(c.peer, { companyId: c.scope.companyId,
    workflowRunId: c.scope.workflowRunId, stepId: "produce", selector: c.scope.selectors.produce }))
    .toMatchObject({ product: { id: c.revision.workProductId }, producer: c.s.producer });
}, 20000);

it("rejects ambiguous corrected fallback rows", async () => {
  const c = await fixture();
  await c.peer.insert(issueWorkProducts).values({ ...await c.read(), id: randomUUID(), isPrimary: false });
  await expect(c.select()).rejects.toThrow("workproduct_selector_correction_not_exactly_one");
}, 20000);

it.each(["wrong-title", "archived", "other-type"])("does not classify a %s alternate", async fault => {
  const c = await fixture();
  await c.peer.update(issueWorkProducts).set(fault === "wrong-title" ? { title: "other" }
    : fault === "archived" ? { status: "archived" } : { type: "file" })
    .where(eq(issueWorkProducts.id, c.revision.workProductId));
  expect(await c.select()).toEqual([]);
}, 20000);

it("does not consult corrected alternates while an ordinary exact match exists", async () => {
  const c = await fixture();
  await c.peer.insert(issueWorkProducts).values({ ...await c.read(), id: randomUUID(), type: "document",
    metadata: {}, isPrimary: false });
  expect(await c.select()).toEqual([]);
}, 20000);

it("does not fall back from ambiguous exact correction rows", async () => {
  const c = await fixture(), row = await c.read();
  await c.peer.insert(issueWorkProducts).values([1, 2].map(() => ({ ...row, id: randomUUID(), type: "document", isPrimary: false })));
  await expect(c.select()).rejects.toThrow("workproduct_selector_correction_not_exactly_one");
}, 20000);

it.each(["pointer", "binding"])("retains the structured %s proof for a corrected alternate", async fault => {
  const c = await fixture();
  if (fault === "pointer") await c.peer.update(issueWorkProducts).set({ metadata: { qaCorrection: null } })
    .where(eq(issueWorkProducts.id, c.revision.workProductId));
  else await c.peer.update(workflowStepOutputBindings).set({ workProductId: c.s.productId })
    .where(eq(workflowStepOutputBindings.id, c.s.f.bindingId));
  await expect(c.select()).rejects.toThrow();
}, 20000);
