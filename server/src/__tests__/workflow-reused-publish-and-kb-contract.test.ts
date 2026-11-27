import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { issueWorkProducts, missions, toolDefinitions, workflowRuns, workflowRunSeeds,
  workflowStepOutputBindings, workflowStepRuns } from "@paperclipai/db";
import { fixture, database } from "./helpers/qa-receipt-fixture.js";
import { legacyHtmlManualPublicationContract } from "./helpers/legacy-html-manual.js";
import { HttpError } from "../errors.js";
import { prepareQaConsumer } from "../services/workflow/qa-artifact-consumer.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { captureExecutionDefinition } from "../services/workflow/execution-definition.js";
import { createSeededWorkflowRun } from "../services/workflow/workflow-seed-admission.js";
import { ensureWorkflowStepRunRecords } from "../services/workflow/workflow-step-materialization.js";
import { resolveWorkflowStepKnowledgeContext } from "../services/heartbeat-workflow-knowledge-context.js";
import { knowledgeService, type KnowledgeBase } from "../services/knowledge/base.js";
import { workflowService } from "../services/workflow/engine.js";

afterEach(() => vi.restoreAllMocks());

async function reusedPublish() {
  const f = await fixture(), db = database();
  const [source] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
  // Build this fixture's historical definition before dispatching its QA tool.
  await db.update(workflowRuns).set({ status: "pending", metadata: { executionDefinitionVersion: 1 } })
    .where(eq(workflowRuns.id, f.runId));
  await db.transaction(tx => captureExecutionDefinition(tx, f.runId));
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  const result = await f.invoke();
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const receipt = result.toolArtifactReceipt!;
  const [qa] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  await db.update(workflowStepRuns).set({ status: "completed", metadata: {
    ...qa.metadata, toolArtifactReceipt: receipt } }).where(eq(workflowStepRuns.id, qa.id));
  const [product] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, receipt.input.workProductId));
  await db.update(issueWorkProducts).set({ metadata: { ...product.metadata, sha256: receipt.input.sha256 } })
    .where(eq(issueWorkProducts.id, product.id));
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, source.id));
  const [originalMission] = await db.select().from(missions).where(eq(missions.id, f.missionId));
  const [mission] = await db.insert(missions).values({ companyId: f.companyId, title: "Revision",
    ownerAgentId: originalMission.ownerAgentId, status: "active", sourceMissionId: f.missionId,
    sourceWorkflowRunId: source.id }).returning();
  const target = await createSeededWorkflowRun(db, { companyId: f.companyId, workflowId: source.workflowId,
    missionId: mission.id, triggeredBy: "board", seedFromRun: { sourceWorkflowRunId: source.id, stepIds: ["write"] } },
    { type: "board", userId: "local-board", source: "local_implicit" });
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, target.id));
  expect((await ensureWorkflowStepRunRecords(db, { runId: target.id, steps: [{ id: "write" }],
    buildMetadata: () => ({}), syncControls: async (_db, rows) => rows })).kind).toBe("ready");
  const contract = { ...legacyHtmlManualPublicationContract("publisher.mjs"),
    consumerParams: { receipt: "evidence", content: "source" } };
  const adapterConfig = { command: `${process.execPath} publisher.mjs`, workingDirectory: path.dirname(f.content),
    artifactContract: contract };
  // Explicit local publisher double: machine transport/scope only, no CMS or network.
  await writeFile(path.join(path.dirname(f.content), "publisher.mjs"), `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8')),url='https://example.org/article';
fs.writeFileSync(4,JSON.stringify({schemaVersion:'manual-onboarding.publication.v1',ok:true,command:'publish',
mode:'content-draft',section:'tech-blog',id:'article',date:'2026-11-28',title:null,publishedAtKst:'2026-11-28T00:00:00+09:00',
publicUrl:url,scope:JSON.parse(process.env.PAPERCOMPANY_ARTIFACT_SCOPE),
input:{contentSha256:v.content.sha256,qaSha256:v.qa.sha256,assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))},
cms:{ok:true,audience:'public',contentId:'article',slug:'article',publicUrl:url,liveStatus:200,blocks:1,assets:1,
commandKey:'article:1',contentHash:'a'.repeat(64),contentBytes:123}}));`);
  await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "publisher", adapterType: "builtin", adapterConfig });
  const frozen = freezeArtifactAttempt({ adapterConfig, step: {}, executionGeneration: 0, requestId: "publish" });
  const [consumer] = await db.insert(workflowStepRuns).values({ workflowRunId: target.id, stepId: "publish",
    status: "running", lastDispatchRequestId: "publish", metadata: { artifactExecution: frozen } }).returning();
  await db.insert(workflowStepOutputBindings).values({ companyId: f.companyId, workflowRunId: target.id,
    consumerStepRunId: consumer.id, referencedStepId: "write", workProductId: product.id });
  const input = { db, companyId: f.companyId, workflowRunId: target.id, stepRunId: consumer.id,
    stepId: "publish", requestId: "publish", parameters: { source: f.content,
      evidence: path.join(receipt.outputRoot, receipt.relativePath) } };
  return { ...f, input, receipt, mission, target, product, consumer, frozen };
}

it("consumes prior approved QA bytes for an approved reused artifact in the current publication scope", async () => {
  const f = await reusedPublish(), delivered = await prepareQaConsumer(f.input);
  expect(delivered.publicationScope).toMatchObject({ companyId: f.companyId, missionId: f.mission.id,
    workflowRunId: f.target.id, stepRunId: f.consumer.id });
  const transport = JSON.parse(delivered.inputBytes!.toString());
  expect(Buffer.from(transport.content.base64, "base64")).toEqual(await readFile(f.content));
  expect(transport.content.sha256).toBe(f.receipt.input.sha256);
  expect(transport.qa.sha256).toBe(f.receipt.sha256);
  const result = await executeCoreWorkflowTool({ ...f.input, toolName: "publisher", parameters: {
    ...f.input.parameters, id: "article", section: "tech-blog", date: "2026-11-28" } });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const stored = JSON.parse(await readFile(result.artifactPath!, "utf8"));
  expect(stored.scope).toEqual(delivered.publicationScope);
  expect(stored.input.qaSha256).toBe(f.receipt.sha256);
});

it.each(["approval", "binding", "hash", "receipt", "company", "attempt"])(
  "refuses prior receipt reuse after %s changes before a tool can launch", async scenario => {
  const f = await reusedPublish(), db = database();
  if (scenario === "approval") await db.update(workflowRunSeeds).set({ approvedByUserId: "" })
    .where(eq(workflowRunSeeds.targetRunId, f.target.id));
  if (scenario === "binding") await db.delete(workflowStepOutputBindings)
    .where(eq(workflowStepOutputBindings.consumerStepRunId, f.consumer.id));
  if (scenario === "hash") await writeFile(f.content, '{"changed":true}');
  if (scenario === "receipt") {
    const receiptPath = f.input.parameters.evidence;
    await chmod(receiptPath, 0o600); await writeFile(receiptPath, "{}");
  }
  if (scenario === "company") {
    const foreign = await fixture();
    const foreignQa = await foreign.invoke();
    f.input.parameters.evidence = path.join(foreignQa.toolArtifactReceipt!.outputRoot, foreignQa.toolArtifactReceipt!.relativePath);
  }
  if (scenario === "attempt") await db.update(workflowStepRuns).set({ lastDispatchRequestId: "new-qa" })
    .where(eq(workflowStepRuns.id, f.qaId));
  await expect(prepareQaConsumer(f.input)).rejects.toMatchObject({ status: 409,
    message: "qa_artifact_consumer_receipt_required" });
});

it.each(["publication", "publication-verify"] as const)("returns typed HTTP 409 for missing %s evidence without launching", async role => {
  const f = await reusedPublish(), contract = { ...f.frozen.contract, role };
  const frozen = freezeArtifactAttempt({ adapterConfig: { artifactContract: contract }, step: {},
    executionGeneration: 0, requestId: "publish" });
  await database().update(workflowStepRuns).set({ metadata: { artifactExecution: frozen } })
    .where(eq(workflowStepRuns.id, f.consumer.id));
  await expect(prepareQaConsumer({ ...f.input, parameters: {} })).rejects.toBeInstanceOf(HttpError);
  const result = await executeCoreWorkflowTool({ ...f.input, toolName: "publisher", parameters: {} });
  expect(result.status).toBe(409);
  expect(result.body.error).toBe("qa_artifact_consumer_receipt_required");
  expect(result.body.invocationProvenance).toBeNull();
});

const kb = (id: string, companyId = "company"): KnowledgeBase => ({ id, companyId, name: `KB ${id}`,
  type: "static", description: "", maxTokenBudget: 100, config: {}, createdAt: new Date(), updatedAt: new Date() });
function knowledgeInput(ids: string[]) {
  vi.spyOn(workflowService, "getStepExecutionContractForIssue").mockResolvedValue({ workflowRunId: "run",
    workflowId: "workflow", stepId: "research", stepName: "Research", knowledgeBaseIds: ids } as never);
  return { db: database(), companyId: "company", agentId: "agent", issueId: "issue", taskKey: null,
    issueTitle: null, issueDescription: null, note: null };
}

it("trims and deduplicates KB references before checking grants and retrieving", async () => {
  const input = knowledgeInput([" active ", "active", "  "]);
  vi.spyOn(knowledgeService, "listAccessible").mockResolvedValue([kb("active")]);
  const retrieve = vi.spyOn(knowledgeService, "retrieve").mockResolvedValue({ content: "rules", tokenCount: 1, source: "static" });
  const result = await resolveWorkflowStepKnowledgeContext(input);
  expect(result?.knowledgeBaseIds).toEqual(["active"]);
  expect(result?.entries).toHaveLength(1);
  expect(retrieve).toHaveBeenCalledTimes(1);
  expect(retrieve.mock.calls[0][1].kbId).toBe("active");
});

it("returns no KB context for an empty normalized contract", async () => {
  const input = knowledgeInput([" ", ""]);
  const accessible = vi.spyOn(knowledgeService, "listAccessible");
  expect(await resolveWorkflowStepKnowledgeContext(input)).toBeNull();
  expect(accessible).not.toHaveBeenCalled();
});

it("reports exact missing, foreign and ungranted IDs with scoped available hints without substituting", async () => {
  const denied = "00000000-0000-0000-0000-000000000001", foreign = "00000000-0000-0000-0000-000000000002";
  const input = knowledgeInput([" missing ", denied, foreign, "missing"]);
  vi.spyOn(knowledgeService, "listAccessible").mockResolvedValue([kb("active")]);
  vi.spyOn(knowledgeService, "getById").mockImplementation(async (_db, id) => id === denied ? kb(id)
    : id === foreign ? kb(id, "secret-company") : null);
  const retrieve = vi.spyOn(knowledgeService, "retrieve");
  const error = await resolveWorkflowStepKnowledgeContext(input).catch(e => e);
  expect(error).toMatchObject({ code: "workflow_step_kb_contract_invalid", details: {
    stepId: "research", workflowRunId: "run", knowledgeBaseIds: ["missing", denied, foreign],
    missingKnowledgeBaseIds: ["missing"], inaccessibleKnowledgeBaseIds: [denied], wrongCompanyKnowledgeBaseIds: [foreign],
    archiveStatusSupported: false, availableActiveKnowledgeBases: [{ id: "active", name: "KB active" }],
  } });
  expect(JSON.stringify(error.details)).not.toContain("secret-company");
  expect(retrieve).not.toHaveBeenCalled();
});
