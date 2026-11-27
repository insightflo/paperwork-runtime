// server/src/__tests__/logical-graph.test.ts
//
// [파일 목적] 논리 데이터 그래프(services/data-graph/logical-graph.ts) 단위 테스트.
//   PGlite 인메모리 DB(terminal-cleanup-fixture)로 실제 Drizzle 질의를 검증한다.
// [범위] 엣지 카탈로그 완전성·스키마 정렬, maxHops/limit 클램프+truncated, 회사 격리,
//   issue seed의 1-hop/2-hop 탐색, 전 seed kind 지원, knowledge 링크 탐색.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { OperatorDecisionDefinitionJson } from "@paperclipai/db";
import {
  agents, companies, heartbeatRuns, issueWorkProducts, issues, knowledgeBases, knowledgeNodes,
  missions, operatorDecisions, workflowDefinitions, workflowRuns, workflowStepRuns,
} from "@paperclipai/db";
import {
  clampLogicalGraphLimit, clampLogicalGraphMaxHops, LOGICAL_DATA_GRAPH_EDGES,
  LOGICAL_GRAPH_DEFAULT_LIMIT, LOGICAL_GRAPH_MAX_HOPS, LOGICAL_GRAPH_MAX_LIMIT,
  queryLogicalDataGraph, type LogicalGraphNodeKind,
} from "../services/data-graph/logical-graph.js";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

let db: Db;
let closeDb: () => Promise<void>;

const decisionDefinition: OperatorDecisionDefinitionJson = {
  options: [], actions: [], selection: null,
  comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
  approvedScope: [], forbiddenScope: [],
};

type World = {
  companyA: { id: string }; companyB: { id: string };
  mission: { id: string }; missionB: { id: string };
  issueA: { id: string }; parentIssue: { id: string }; siblingIssue: { id: string };
  chain: Array<{ id: string }>;
  workProduct: { id: string }; decision: { id: string };
  runRoot: { id: string }; runRetry: { id: string };
  wfParent: { id: string }; wfRun: { id: string }; step: { id: string };
  knowledge1: { id: string }; knowledge2: { id: string };
};

/** 회사 A에 2-hop 검증용 풍부한 그래프를, 회사 B에 격리 검증용 미러를 심는다. */
async function seedWorld(target: Db): Promise<World> {
  const [companyA] = await target.insert(companies).values({ name: "Graph A", issuePrefix: randomUUID() }).returning();
  const [companyB] = await target.insert(companies).values({ name: "Graph B", issuePrefix: randomUUID() }).returning();
  const [agentA] = await target.insert(agents).values({ companyId: companyA.id, name: "Worker A", status: "running" }).returning();
  const [agentB] = await target.insert(agents).values({ companyId: companyB.id, name: "Worker B", status: "running" }).returning();
  const [flowA] = await target.insert(workflowDefinitions).values({ companyId: companyA.id, name: "flow-a" }).returning();
  await target.insert(workflowDefinitions).values({ companyId: companyB.id, name: "flow-b" });
  const [mission] = await target.insert(missions).values({ companyId: companyA.id, ownerAgentId: agentA.id, title: "Mission A", status: "active" }).returning();
  const [missionB] = await target.insert(missions).values({ companyId: companyB.id, ownerAgentId: agentB.id, title: "Mission B", status: "active" }).returning();
  const [wfParent] = await target.insert(workflowRuns).values({ companyId: companyA.id, workflowId: flowA.id, triggeredBy: "test", status: "completed" }).returning();
  const [wfRun] = await target.insert(workflowRuns).values({ companyId: companyA.id, workflowId: flowA.id, missionId: mission.id, parentRunId: wfParent.id, triggeredBy: "test", status: "running" }).returning();
  const [step] = await target.insert(workflowStepRuns).values({ workflowRunId: wfRun.id, stepId: "step-1", status: "running" }).returning();
  const [runRoot] = await target.insert(heartbeatRuns).values({ companyId: companyA.id, agentId: agentA.id, status: "running", workflowStepRunId: step.id }).returning();
  const [runRetry] = await target.insert(heartbeatRuns).values({ companyId: companyA.id, agentId: agentA.id, status: "running", retryOfRunId: runRoot.id }).returning();
  const [issueA] = await target.insert(issues).values({ companyId: companyA.id, missionId: mission.id, title: "Issue A", status: "in_progress", checkoutRunId: runRoot.id, executionRunId: runRoot.id }).returning();
  const [parentIssue] = await target.insert(issues).values({ companyId: companyA.id, missionId: mission.id, title: "Child of A", status: "in_progress", parentId: issueA.id }).returning();
  const [siblingIssue] = await target.insert(issues).values({ companyId: companyA.id, missionId: mission.id, title: "Sibling", status: "todo" }).returning();
  const chain: Array<{ id: string }> = [];
  let prevParent: string | null = issueA.id;
  for (let i = 0; i < 4; i += 1) {
    const [row] = await target.insert(issues).values({ companyId: companyA.id, title: `Chain ${i}`, status: "backlog", parentId: prevParent }).returning();
    chain.push(row);
    prevParent = row.id;
  }
  const [workProduct] = await target.insert(issueWorkProducts).values({ companyId: companyA.id, issueId: issueA.id, type: "artifact", provider: "test", title: "WP", status: "done", createdByRunId: runRoot.id }).returning();
  const [decision] = await target.insert(operatorDecisions).values({
    companyId: companyA.id, issueId: issueA.id, requestKey: randomUUID(), requestHash: "hash",
    interactionType: "single_select", title: "Decision", sourceType: "test", sourceId: "src-1",
    sourceContext: { workflowRunId: wfRun.id }, definition: decisionDefinition,
  }).returning();
  await target.update(workflowStepRuns).set({ issueId: issueA.id }).where(eq(workflowStepRuns.id, step.id));
  const knowledge2Id = randomUUID();
  const [kb] = await target.insert(knowledgeBases).values({ companyId: companyA.id, name: "KB A", type: "company" }).returning();
  const [knowledge1] = await target.insert(knowledgeNodes).values({
    companyId: companyA.id, kbId: kb.id, slug: "node-1", title: "K1",
    linkedNodeIds: [knowledge2Id], sourceRefs: [{ type: "issue", id: issueA.id }],
  }).returning();
  const [knowledge2] = await target.insert(knowledgeNodes).values({
    companyId: companyA.id, kbId: kb.id, id: knowledge2Id, slug: "node-2", title: "K2",
  }).returning();
  const [issueB] = await target.insert(issues).values({ companyId: companyB.id, missionId: missionB.id, title: "Issue B", status: "todo" }).returning();
  return {
    companyA, companyB, mission, missionB, issueA, parentIssue, siblingIssue, chain,
    workProduct, decision, runRoot, runRetry, wfParent, wfRun, step, knowledge1, knowledge2, issueB,
  };
}

let world: World;

beforeAll(async () => {
  const fixture = await terminalDatabase();
  db = fixture.db;
  closeDb = fixture.close;
  world = await seedWorld(db);
});

afterAll(async () => {
  await closeDb();
});

describe("edge catalog", () => {
  const nodeKinds: LogicalGraphNodeKind[] = ["mission", "issue", "work_product", "decision", "run", "workflow_run", "step_run", "knowledge_node"];

  it("covers every node kind with unique edge kinds and non-empty via columns", () => {
    const edgeKinds = new Set(LOGICAL_DATA_GRAPH_EDGES.map((edge) => edge.kind));
    expect(edgeKinds.size).toBe(15);
    for (const edge of LOGICAL_DATA_GRAPH_EDGES) {
      expect(nodeKinds).toContain(edge.fromKind);
      expect(nodeKinds).toContain(edge.toKind);
      expect(edge.viaColumn.length).toBeGreaterThan(0);
    }
    for (const nodeKind of nodeKinds) {
      expect(LOGICAL_DATA_GRAPH_EDGES.some((edge) => edge.fromKind === nodeKind || edge.toKind === nodeKind)).toBe(true);
    }
  });

  it("aligns via columns with the real drizzle tables", () => {
    expect(issues.missionId).toBeDefined();
    expect(issues.parentId).toBeDefined();
    expect(issues.checkoutRunId).toBeDefined();
    expect(issues.executionRunId).toBeDefined();
    expect(issueWorkProducts.issueId).toBeDefined();
    expect(issueWorkProducts.createdByRunId).toBeDefined();
    expect(heartbeatRuns.retryOfRunId).toBeDefined();
    expect(heartbeatRuns.workflowStepRunId).toBeDefined();
    expect(workflowRuns.missionId).toBeDefined();
    expect(workflowRuns.parentRunId).toBeDefined();
    expect(workflowStepRuns.issueId).toBeDefined();
    expect(workflowStepRuns.workflowRunId).toBeDefined();
    expect(operatorDecisions.issueId).toBeDefined();
    expect(operatorDecisions.sourceContext).toBeDefined();
    expect(knowledgeNodes.sourceRefs).toBeDefined();
    expect(knowledgeNodes.linkedNodeIds).toBeDefined();
  });
});

describe("clamping", () => {
  it("clamps maxHops to [1,2] and limit to [1,100] with defaults 2/50", () => {
    expect(clampLogicalGraphMaxHops(undefined)).toBe(LOGICAL_GRAPH_MAX_HOPS);
    expect(clampLogicalGraphMaxHops(99)).toBe(2);
    expect(clampLogicalGraphMaxHops(0)).toBe(1);
    expect(clampLogicalGraphMaxHops(Number.NaN)).toBe(2);
    expect(clampLogicalGraphLimit(undefined)).toBe(LOGICAL_GRAPH_DEFAULT_LIMIT);
    expect(clampLogicalGraphLimit(9999)).toBe(LOGICAL_GRAPH_MAX_LIMIT);
    expect(clampLogicalGraphLimit(0)).toBe(1);
    expect(clampLogicalGraphLimit(2.9)).toBe(2);
  });

  it("never expands beyond 2 hops even when maxHops is inflated", async () => {
    const [c1, c2, c3, c4] = world.chain;
    const result = await queryLogicalDataGraph(db, { companyId: world.companyA.id, seedKind: "issue", seedId: c1.id, maxHops: 99 });
    const ids = result.nodes.map((node) => node.id);
    expect(ids).toContain(c2.id);
    expect(ids).toContain(c3.id);
    expect(ids).not.toContain(c4.id);
    expect(result.truncated).toBe(false);
  });

  it("caps returned nodes at the limit and flags truncation", async () => {
    const capped = await queryLogicalDataGraph(db, { companyId: world.companyA.id, seedKind: "mission", seedId: world.mission.id, limit: 3 });
    expect(capped.nodes.length).toBe(3);
    expect(capped.truncated).toBe(true);
    const single = await queryLogicalDataGraph(db, { companyId: world.companyA.id, seedKind: "mission", seedId: world.mission.id, limit: 1 });
    expect(single.nodes.map((node) => node.id)).toEqual([world.mission.id]);
    expect(single.truncated).toBe(true);
  });
});

describe("company isolation", () => {
  it("returns an empty graph for a cross-company seed", async () => {
    const result = await queryLogicalDataGraph(db, { companyId: world.companyA.id, seedKind: "mission", seedId: world.missionB.id });
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("never leaks nodes from another company", async () => {
    const result = await queryLogicalDataGraph(db, { companyId: world.companyA.id, seedKind: "issue", seedId: world.issueA.id });
    const ids = result.nodes.map((node) => node.id);
    expect(ids).not.toContain(world.issueB.id);
    expect(ids).not.toContain(world.missionB.id);
  });
});

describe("issue seed traversal", () => {
  it("expands 1-hop neighbors and 2-hop context from an issue seed", async () => {
    const result = await queryLogicalDataGraph(db, { companyId: world.companyA.id, seedKind: "issue", seedId: world.issueA.id });
    const byId = new Map(result.nodes.map((node) => [node.id, node]));
    for (const id of [world.mission.id, world.parentIssue.id, world.workProduct.id, world.decision.id, world.runRoot.id, world.step.id]) {
      expect(byId.get(id)?.hop).toBe(1);
    }
    for (const id of [world.siblingIssue.id, world.wfRun.id, world.runRetry.id]) {
      expect(byId.get(id)?.hop).toBe(2);
    }
    expect(byId.get(world.issueA.id)?.hop).toBe(0);
    expect(byId.has(world.chain[2].id)).toBe(false);
    expect(byId.has(world.wfParent.id)).toBe(false);
    expect(result.truncated).toBe(false);
    const kinds = new Set(result.edges.map((edge) => edge.kind));
    for (const kind of ["mission_issue", "issue_parent", "issue_work_product", "issue_run", "work_product_run", "run_retry", "run_step_run", "workflow_run_mission", "step_run_issue", "step_run_workflow_run", "decision_issue", "decision_workflow_run"]) {
      expect(kinds.has(kind as never)).toBe(true);
    }
    expect(result.edges.every((edge) => edge.via.length > 0)).toBe(true);
    const retryEdge = result.edges.find((edge) => edge.kind === "run_retry");
    expect(retryEdge?.from.id).toBe(world.runRetry.id);
    expect(retryEdge?.to.id).toBe(world.runRoot.id);
  });

  it("supports every documented seed kind", async () => {
    const seeds: Array<[LogicalGraphNodeKind, string]> = [
      ["mission", world.mission.id], ["issue", world.issueA.id], ["work_product", world.workProduct.id],
      ["decision", world.decision.id], ["run", world.runRoot.id], ["workflow_run", world.wfRun.id],
      ["step_run", world.step.id], ["knowledge_node", world.knowledge1.id],
    ];
    for (const [seedKind, seedId] of seeds) {
      const result = await queryLogicalDataGraph(db, { companyId: world.companyA.id, seedKind, seedId });
      expect(result.nodes.some((node) => node.id === seedId && node.hop === 0)).toBe(true);
      expect(result.nodes.length).toBeGreaterThan(1);
    }
  });

  it("follows knowledge links and source refs from a knowledge seed", async () => {
    const result = await queryLogicalDataGraph(db, { companyId: world.companyA.id, seedKind: "knowledge_node", seedId: world.knowledge1.id });
    const ids = result.nodes.map((node) => node.id);
    expect(ids).toContain(world.knowledge2.id);
    expect(ids).toContain(world.issueA.id);
    expect(ids).toContain(world.mission.id);
    const kinds = new Set(result.edges.map((edge) => edge.kind));
    expect(kinds.has("knowledge_link")).toBe(true);
    expect(kinds.has("knowledge_source")).toBe(true);
    expect(ids).not.toContain(world.issueB.id);
  });
});
