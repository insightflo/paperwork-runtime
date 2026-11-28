import path from "node:path";
import { preparePublicationVerifyConsumer } from './publication-verify-consumer.js';
import { loadArtifactAttempt, type FrozenArtifactAttempt } from "./artifact-contract-runtime.js";
import type { PublicationScope } from "./publication-result.js";
import { encodeQaInput } from "./qa-byte-transport.js";
import { randomUUID } from "node:crypto";
import { createArtifactDirectory } from "./artifact-writer.js";
import { captureQaDispatch, type QaDispatchScope } from "./qa-dispatch-guard.js";
import { and, eq, sql } from "drizzle-orm";
import { conflict } from "../../errors.js";
import { workflowRuns, workflowStepRuns, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { toolArtifactReceiptSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { captureArtifactRoot, digest, readArtifactBytes } from "./artifact-files.js";
import { readQaReceiptBytes } from "./qa-artifact-receipt.js";
import { readObject } from "./core-tool-context.js";
import { selectOfficialWorkProduct } from "./workproduct-selector.js";
import type { QaRequest } from "./qa-artifact-request.js";

/** Native template path comes only from a current validated durable receipt. */
export async function resolveQaReceiptPath(db: Db, scope: { companyId: string; workflowRunId: string; stepId: string }) {
  const { receipt } = await readQaReceiptBytes(db, scope);
  return path.join(receipt.outputRoot, receipt.relativePath);
}

/** External CLI consumes the verified byte bundle, never a copied absolute path. */
export async function prepareQaConsumer(input: QaDispatchScope & { parameters: unknown; artifactExecution?: FrozenArtifactAttempt | null;
  dispatch?: Awaited<ReturnType<typeof captureQaDispatch>> }) {
  const args = readObject(input.parameters);
  const frozen = input.artifactExecution === undefined ? await loadArtifactAttempt(input) : input.artifactExecution;
  if (!frozen || frozen.contract.role === "qa") return { parameters: input.parameters, inputBytes: undefined, resultRoot: undefined };
  if (frozen.contract.role === 'publication-verify') return preparePublicationVerifyConsumer({ ...input, artifactExecution: frozen });
  const contract = frozen.contract, names = contract.consumerParams;
  if (!names || typeof args[names.receipt] !== "string") throw conflict("qa_artifact_consumer_receipt_required");
  if (!input.workflowRunId) throw new Error("qa_artifact_request_stale");
  const dispatch = input.dispatch ?? await captureQaDispatch(input);
  const rows = await input.db.select({ step: workflowStepRuns, run: workflowRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(
      eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId)));
  let matches = rows.filter(({ step }) => {
    const r = toolArtifactReceiptSchema.safeParse(step.metadata.toolArtifactReceipt);
    return r.success && path.join(r.data.outputRoot, r.data.relativePath) === args[names.receipt];
  });
  const reused = matches.length === 0;
  if (reused) {
    const receiptPath = args[names.receipt] as string;
    if (!path.isAbsolute(receiptPath)) throw conflict("qa_artifact_consumer_receipt_required");
    matches = await input.db.select({ step: workflowStepRuns, run: workflowRuns }).from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(
        eq(workflowRuns.companyId, input.companyId),
        sql`(${workflowStepRuns.metadata}->'toolArtifactReceipt'->>'outputRoot') || '/' ||
          (${workflowStepRuns.metadata}->'toolArtifactReceipt'->>'relativePath') = ${receiptPath}`));
  }
  if (matches.length !== 1) throw conflict("qa_artifact_consumer_receipt_required");
  const { step, run } = matches[0];
  const verified = await (async () => {
    const result = await readQaReceiptBytes(input.db, { companyId: input.companyId, workflowRunId: run.id, stepId: step.stepId });
    const { receipt } = result;
    if (receipt.missionId !== run.missionId) throw new Error("qa_artifact_consumer_mission_mismatch");
    const bindings = await input.db.select().from(workflowStepOutputBindings).where(and(
      eq(workflowStepOutputBindings.companyId, input.companyId), eq(workflowStepOutputBindings.workflowRunId, run.id),
      eq(workflowStepOutputBindings.consumerStepRunId, step.id),
      eq(workflowStepOutputBindings.workProductId, receipt.input.workProductId)));
    if (bindings.length !== 1) throw new Error("qa_artifact_consumer_binding_required");
    const producer = await selectOfficialWorkProduct(input.db, { companyId: input.companyId, workflowRunId: run.id,
      stepId: bindings[0].referencedStepId, selector: { type: "document", title: path.basename(receipt.input.path) }, pinnedId: receipt.input.workProductId });
    if (producer.file !== receipt.input.path) throw new Error("qa_artifact_consumer_producer_changed");
    if (reused) {
      // A path from another run is not authority. The current consumer must pin the
      // exact product through the existing approval/seed reader, which rechecks bytes.
      const pins = await input.db.select().from(workflowStepOutputBindings).where(and(
        eq(workflowStepOutputBindings.companyId, input.companyId),
        eq(workflowStepOutputBindings.workflowRunId, input.workflowRunId!),
        eq(workflowStepOutputBindings.consumerStepRunId, input.stepRunId!),
        eq(workflowStepOutputBindings.workProductId, result.receipt.input.workProductId)));
      if (pins.length !== 1) throw conflict("qa_artifact_consumer_receipt_required");
      const selected = await selectOfficialWorkProduct(input.db, { companyId: input.companyId,
        workflowRunId: input.workflowRunId!, stepId: pins[0].referencedStepId,
        selector: { type: "document", title: path.basename(result.receipt.input.path) },
        pinnedId: result.receipt.input.workProductId });
      if (selected.file !== result.receipt.input.path || selected.product.metadata?.sha256 !== result.receipt.input.sha256)
        throw conflict("qa_artifact_consumer_receipt_required");
    }
    return result;
  })().catch(error => { if (reused) throw conflict("qa_artifact_consumer_receipt_required"); throw error; });
  const { receipt, bytes: qaBytes } = verified;
  const sourceKey = receipt.input.mode === "html" ? names.html : names.content;
  if (!sourceKey || args[sourceKey] !== receipt.input.path
    || (names.content && names.html && typeof args[names.content] === "string" && typeof args[names.html] === "string")) {
    throw reused ? conflict("qa_artifact_consumer_receipt_required") : new Error("qa_artifact_consumer_input_mismatch");
  }
  const request = step.metadata.toolArtifactRequest as NonNullable<QaRequest>["snapshot"];
  const root = await captureArtifactRoot(request.root.path);
  if (root.dev !== request.root.dev || root.ino !== request.root.ino) throw new Error("qa_artifact_root_replaced");
  const source = await readArtifactBytes(root, `input/${path.basename(receipt.input.path)}`, 8 * 1024 * 1024);
  if (digest(source) !== receipt.input.sha256 || source.length !== receipt.input.byteSize) throw new Error("qa_artifact_input_changed");
  const assets = [];
  for (const a of receipt.input.assetManifest) {
    const bytes = await readArtifactBytes(root, `input/assets/${a.fileName}`, 16 * 1024 * 1024);
    if (digest(bytes) !== a.sha256 || bytes.length !== a.byteSize) throw new Error("qa_artifact_asset_changed");
    assets.push({ ...a, bytes });
  }
  const ancillary = [];
  for (const a of receipt.input.ancillaryManifest ?? []) {
    const bytes = await readArtifactBytes(root, `input/ancillary/${a.fileName}`, 1024 * 1024);
    if (digest(bytes) !== a.sha256 || bytes.length !== a.byteSize) throw new Error("qa_artifact_ancillary_changed");
    ancillary.push({ ...a, bytes });
  }
  // All validation precedes creation and tool dispatch; no external writes on rejection.
  const current = rows.find(({ step: s }) => s.id === input.stepRunId), consumer = current?.step;
  if (!consumer || !input.stepId || !input.requestId || !current.run.missionId) throw new Error("qa_artifact_request_stale");
  await dispatch.assertCurrent();
  const resultRoot = await createArtifactDirectory(root, `publication-${randomUUID()}`, [], []);
  const publicationScope: PublicationScope = { companyId: input.companyId, missionId: current.run.missionId,
    workflowRunId: current.run.id, stepRunId: consumer.id, stepId: input.stepId, requestId: input.requestId,
    executionGeneration: consumer.executionGeneration, retryCount: consumer.retryCount, iterationIndex: consumer.iterationIndex };
  return { parameters: args, inputBytes: encodeQaInput(source, assets, qaBytes,
    receipt.input.mode === "html" ? { ancillary } : undefined, contract.inputEnvelopeVersion), resultRoot, publicationScope, contract, dispatch };
}
