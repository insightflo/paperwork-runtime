import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, knowledgeBases, knowledgeNodes } from "@paperclipai/db";
import { findKnowledgeBaseReferenceErrors } from "../services/missions/plan-kbids-validation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// [purpose] Pre-PLAN kbIds guard (RES-12846 prevention): a dynamic plan step's kbIds
// must contain knowledge_bases.id. A knowledge_nodes.id slipped into kbIds previously
// passed plan admission and failed only at runtime (workflow_step_kb_contract_invalid).
// The guard must reject node ids with an actionable message naming the parent KB,
// reject unknown ids cleanly, and never disclose cross-company KB ownership.
const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping plan kbIds guard tests: ${support.reason ?? "unsupported"}`);
}

describeEP("plan kbIds guard — knowledge_nodes.id mistaken for knowledge_bases.id", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let otherCompanyId: string;
  let kbId: string;
  let nodeId: string;
  let otherKbId: string;
  let otherNodeId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plan-kbids-guard-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Kbids Guard Co", status: "active", issuePrefix: "KBG1" },
      { id: otherCompanyId, name: "Other Guard Co", status: "active", issuePrefix: "KBG2" },
    ]);
    kbId = randomUUID();
    otherKbId = randomUUID();
    await db.insert(knowledgeBases).values([
      { id: kbId, companyId, name: "Guard Playbook", type: "static", description: "" },
      { id: otherKbId, companyId: otherCompanyId, name: "Other Guard Playbook", type: "static", description: "" },
    ]);
    nodeId = randomUUID();
    otherNodeId = randomUUID();
    await db.insert(knowledgeNodes).values([
      { id: nodeId, companyId, kbId, slug: "guard-intro", title: "Guard Intro", summary: "", content: "" },
      {
        id: otherNodeId, companyId: otherCompanyId, kbId: otherKbId,
        slug: "guard-intro", title: "Other Guard Intro", summary: "", content: "",
      },
    ]);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  const unit = (kbIds: string[]) => ({
    id: "step-1",
    kind: "mission_plan_unit",
    title: "[ACTION] Use knowledge",
    kbIds,
    sourceRef: { type: "mission_plan_unit", id: "step-1" },
  });

  it("valid knowledge_bases.id passes", async () => {
    const errors = await findKnowledgeBaseReferenceErrors({ db, companyId, units: [unit([kbId])] });
    expect(errors).toEqual([]);
  });

  it("knowledge_nodes.id in kbIds is rejected with the parent knowledgeBaseId hint", async () => {
    const errors = await findKnowledgeBaseReferenceErrors({ db, companyId, units: [unit([nodeId])] });
    expect(errors).toHaveLength(1);
    const message = errors[0]!.message;
    expect(message).toContain("kbIds must contain knowledge_bases.id, not knowledge_nodes.id");
    expect(message).toContain(`found node ${nodeId} belonging to knowledge_base ${kbId}`);
    expect(message).toContain("step-1");
  });

  it("mixed list reports only the offending id", async () => {
    const errors = await findKnowledgeBaseReferenceErrors({ db, companyId, units: [unit([kbId, nodeId])] });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain(`found node ${nodeId} belonging to knowledge_base ${kbId}`);
    expect(errors[0]!.message).not.toContain(`${kbId} belonging`);
  });

  it("cross-company node and kb ids are rejected without leaking the other company's kb", async () => {
    const errors = await findKnowledgeBaseReferenceErrors({ db, companyId, units: [unit([otherNodeId, otherKbId])] });
    expect(errors).toHaveLength(2);
    const nodeError = errors.find((error) => error.message.includes(otherNodeId));
    const kbError = errors.find((error) => error.message.includes(otherKbId));
    expect(nodeError).toBeDefined();
    expect(kbError).toBeDefined();
    // The foreign node must NOT be recognized as a node: no parent-KB disclosure.
    expect(nodeError!.message).not.toContain("not knowledge_nodes.id");
    expect(nodeError!.message).not.toContain(otherKbId);
    expect(nodeError!.message).toContain("is not an existing knowledge_bases.id");
    // The foreign KB id appears only echoed back as the planner's own declared input.
    expect(kbError!.message).toContain("is not an existing knowledge_bases.id");
  });

  it("unknown id (neither kb nor node) is rejected cleanly", async () => {
    const unknownId = randomUUID();
    const errors = await findKnowledgeBaseReferenceErrors({ db, companyId, units: [unit([unknownId])] });
    expect(errors).toHaveLength(1);
    const message = errors[0]!.message;
    expect(message).toContain("is not an existing knowledge_bases.id");
    expect(message).toContain(unknownId);
    expect(message).not.toContain("not knowledge_nodes.id");
  });

  it("non-uuid symbolic kb references keep the legacy pass-through contract", async () => {
    // knowledge_bases.id and knowledge_nodes.id are both uuids; symbolic refs
    // ("kb-research-policy") are a different reference form that predates this guard.
    const errors = await findKnowledgeBaseReferenceErrors({
      db, companyId,
      units: [{ ...unit([]), knowledgeBaseIds: ["kb-research-policy"], kbRefs: ["kb:rollout"] }],
    });
    expect(errors).toEqual([]);
  });
});
