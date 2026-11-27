// server/src/__tests__/data-graph-e2e.integration.test.ts
//
// [파일 목적] Stage 26 데이터 그래프 전 구간(end-to-end) 통합 테스트 — 시드(seedDataGraphQueryTool)
//   → core 도구 dispatch(executeCoreWorkflowTool) → 2-hop PG 탐색 → GraphRAG 컨텍스트 팩
//   (출처 인용·비밀 가림·회사 격리) → appendOptionalDataGraphContext bounded 마크다운 블록까지
//   실물 PGlite DB 위의 한 세계에서 검증한다.
// [범위] 회사 A(mission → issue(description 칼럼 비밀 모양 문자열) → work_product + decision)와
//   격리 대조용 회사 B 미러. 도구 스펙·dispatch 분기·adapter 개별 계약은 data-graph-*.test.ts가 담당한다.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agents, companies, issueWorkProducts, issues, missions, operatorDecisions, toolDefinitions,
  type OperatorDecisionDefinitionJson,
} from "@paperclipai/db";
import { appendOptionalDataGraphContext } from "../services/heartbeat-workflow-knowledge-context.js";
import { DATA_GRAPH_QUERY_TOOL_SPEC, seedDataGraphQueryTool } from "../services/data-graph/data-graph-tool.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  const fixture = await terminalDatabase();
  db = fixture.db;
  closeDb = fixture.close;
});

afterAll(async () => {
  await closeDb?.();
});

// issues.description 칼럼의 비밀 모양 문자열 — 그래프 어떤 필드로도 재노출되면 안 된다.
const DESCRIPTION_SECRET = "api_key: sk-e2e1234567890abcdef";
// decision title은 그래프 노드 label로 원문 채로 팩에 흐르는 유일한 비밀 경로다.
// 팩 sanitize가 이 원문을 [REDACTED]로 가려야 가림이 "실제 발동"했음을 증명할 수 있다.
const DECISION_TITLE_SECRET = "token: ghp_E2Eabcdef1234567890";

const DECISION_DEFINITION: OperatorDecisionDefinitionJson = {
  options: [],
  actions: [{ id: "approve", label: "Approve", outcome: "submit", tone: "primary", requiresSelection: false }],
  selection: null,
  comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
  approvedScope: [],
  forbiddenScope: [],
};

/** 회사 A에 2-hop 체인(mission → issue → work_product+decision)을, 회사 B에 격리 미러를 심는다. */
async function seedWorld(target: Db) {
  const [companyA] = await target.insert(companies).values({ name: "E2E A", issuePrefix: randomUUID() }).returning();
  const [companyB] = await target.insert(companies).values({ name: "E2E B", issuePrefix: randomUUID() }).returning();
  const [agentA] = await target.insert(agents).values({ companyId: companyA.id, name: "Worker A", status: "running" }).returning();
  const [agentB] = await target.insert(agents).values({ companyId: companyB.id, name: "Worker B", status: "running" }).returning();
  const [missionA] = await target.insert(missions).values({ companyId: companyA.id, ownerAgentId: agentA.id, title: "Launch rollout", status: "active" }).returning();
  const [missionB] = await target.insert(missions).values({ companyId: companyB.id, ownerAgentId: agentB.id, title: "Mirror rollout", status: "active" }).returning();
  const [issueA] = await target.insert(issues).values({
    companyId: companyA.id, missionId: missionA.id, title: "Ship checkout flow", status: "in_progress",
    description: DESCRIPTION_SECRET,
  }).returning();
  const [issueB] = await target.insert(issues).values({ companyId: companyB.id, missionId: missionB.id, title: "Mirror checkout", status: "open" }).returning();
  const [workProduct] = await target.insert(issueWorkProducts).values({
    companyId: companyA.id, issueId: issueA.id, type: "artifact", provider: "test", title: "Checkout patch", status: "done",
  }).returning();
  const [decision] = await target.insert(operatorDecisions).values({
    companyId: companyA.id, issueId: issueA.id, requestKey: `e2e:${randomUUID()}`, requestHash: "e2e-hash",
    status: "pending", interactionType: "action", title: `Approve deploy (${DECISION_TITLE_SECRET})`,
    sourceType: "workflow_step", sourceId: "deploy-gate",
    sourceContext: { missionId: missionA.id, workflowId: null, workflowRunId: null, artifactRefs: [] },
    definition: DECISION_DEFINITION,
  }).returning();
  return { companyA, companyB, missionA, missionB, issueA, issueB, workProduct, decision };
}

type GraphToolData = {
  ok: boolean;
  error?: string;
  graph?: {
    nodes: Array<{ kind: string; id: string; hop: number }>;
    edges: Array<{ kind: string; from: { kind: string; id: string }; to: { kind: string; id: string }; via: string }>;
  };
  contextPack?: {
    seed: { nodeType: string; nodeId: string };
    facts: string[];
    provenance: Array<{ nodeType: string; nodeId: string; hop: number; viaEdge: string }>;
  };
};

describe("data graph end-to-end (seed → dispatch → 2-hop → context pack → prompt block)", () => {
  it("seeds the builtin data_graph_query row for both companies idempotently", async () => {
    const world = await seedWorld(db);

    const first = await seedDataGraphQueryTool(db);
    expect(first.companies).toBe(2);
    expect(first.toolsSeeded).toBe(2);
    const second = await seedDataGraphQueryTool(db);
    expect(second.toolsSeeded).toBe(0); // 멱등 — 재시드는 기존 행을 건드리지 않는다.

    for (const company of [world.companyA, world.companyB]) {
      const rows = await db.select().from(toolDefinitions)
        .where(and(eq(toolDefinitions.companyId, company.id), eq(toolDefinitions.name, DATA_GRAPH_QUERY_TOOL_SPEC.name)));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.adapterType).toBe("builtin");
      // core-tool-executor의 builtin 분기 kind 계약 — 어긋나면 다음 테스트의 dispatch가 실패한다.
      expect(rows[0]?.adapterConfig).toEqual({ kind: "data-graph-query" });
      expect(rows[0]?.enabled).toBe(true);
    }
  });

  it("dispatches a 2-hop traversal with provenance, redaction, and company isolation despite injected companyId", async () => {
    const world = await seedWorld(db);
    await seedDataGraphQueryTool(db);

    // rawArgs가 회사 B의 companyId를 주입해도 실행 스코프는 호출 컨텍스트(companyA)만 따른다.
    const result = await executeCoreWorkflowTool({
      db,
      companyId: world.companyA.id,
      toolName: DATA_GRAPH_QUERY_TOOL_SPEC.name,
      parameters: { seedKind: "mission", seedId: world.missionA.id, companyId: world.companyB.id },
      requestId: randomUUID(),
    });

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.source).toBe("core");
    expect(result.body.tool).toBe(DATA_GRAPH_QUERY_TOOL_SPEC.name);
    const data = result.body.data as GraphToolData;
    expect(data.ok, JSON.stringify(result.body)).toBe(true);
    if (!data.ok || !data.graph || !data.contextPack) return;

    // 2-hop 관련 노드: seed mission(hop0) → issue(hop1) → work_product·decision(hop2).
    const byKey = new Map(data.graph.nodes.map((node) => [`${node.kind}:${node.id}`, node.hop]));
    expect(byKey.get(`mission:${world.missionA.id}`)).toBe(0);
    expect(byKey.get(`issue:${world.issueA.id}`)).toBe(1);
    expect(byKey.get(`work_product:${world.workProduct.id}`)).toBe(2);
    expect(byKey.get(`decision:${world.decision.id}`)).toBe(2);

    // 엣지는 카탈로그 방향(from→to)과 근거 컬럼(via)을 그대로 인용한다.
    const edgeKeys = data.graph.edges.map((edge) => `${edge.kind}:${edge.from.id}->${edge.to.id}#${edge.via}`);
    expect(edgeKeys).toContain(`mission_issue:${world.missionA.id}->${world.issueA.id}#issues.mission_id`);
    expect(edgeKeys).toContain(`issue_work_product:${world.issueA.id}->${world.workProduct.id}#issue_work_products.issue_id`);
    expect(edgeKeys).toContain(`decision_issue:${world.decision.id}->${world.issueA.id}#operator_decisions.issue_id`);

    // 회사 B 레코드 0 노출 — 노드 집합과 응답 본문 전체 어디에도 B id가 없다.
    expect(byKey.has(`mission:${world.missionB.id}`)).toBe(false);
    expect(byKey.has(`issue:${world.issueB.id}`)).toBe(false);
    const bodyText = JSON.stringify(result.body);
    expect(bodyText).not.toContain(world.companyB.id);
    expect(bodyText).not.toContain(world.missionB.id);
    expect(bodyText).not.toContain(world.issueB.id);

    // 출처 인용 보존: seed(hop0, via seed)와 유입 엣지의 viaEdge가 provenance에 남는다.
    expect(data.contextPack.seed).toEqual({ nodeType: "mission", nodeId: world.missionA.id });
    const provenanceKeys = data.contextPack.provenance.map((entry) => `${entry.nodeType}:${entry.nodeId}`);
    expect(provenanceKeys).toContain(`issue:${world.issueA.id}`);
    expect(provenanceKeys).toContain(`work_product:${world.workProduct.id}`);
    expect(provenanceKeys).toContain(`decision:${world.decision.id}`);
    const issueProvenance = data.contextPack.provenance.find((entry) => entry.nodeType === "issue");
    expect(issueProvenance).toMatchObject({ hop: 1, viaEdge: "issues.mission_id" });

    // 비밀 가림: decision title의 토큰은 팩에서 [REDACTED]로 가려지고, description 칼럼의
    // 비밀은 graph·pack·본문 어디에도 재노출되지 않는다.
    const packText = data.contextPack.facts.join("\n");
    expect(packText).toContain("[REDACTED]");
    expect(packText).not.toContain(DECISION_TITLE_SECRET);
    expect(JSON.stringify(data.contextPack)).not.toContain(DECISION_TITLE_SECRET);
    expect(bodyText).not.toContain(DESCRIPTION_SECRET);
  });

  it("appends the bounded 2-hop context block from the same real DB data via appendOptionalDataGraphContext", async () => {
    const world = await seedWorld(db);
    const existing = "## Step prompt\n\n- Do the work.\n";
    const maxChars = 1200;

    const markdown = await appendOptionalDataGraphContext(db, {
      companyId: world.companyA.id,
      seedKind: "mission",
      seedId: world.missionA.id,
      existingMarkdown: existing,
      enabled: true,
      maxChars,
    });

    expect(markdown.startsWith(existing + "\n\n")).toBe(true);
    const block = markdown.slice((existing + "\n\n").length);
    expect(block.startsWith("### Related Context (Data Graph · 2-hop)\n\n")).toBe(true);
    expect(block).toContain("issues.mission_id"); // provenance 인용이 블록까지 유지된다.
    expect(block).toContain("operator_decisions.issue_id");
    expect(block).toContain("Sources:");
    expect(block).toContain("[REDACTED]");
    expect(block).not.toContain(DECISION_TITLE_SECRET);
    expect(block).not.toContain(DESCRIPTION_SECRET);
    // bounded: 블록 전체가 예산 안이고 회사 B 레코드는 0 노출이다.
    expect(block.length).toBeLessThanOrEqual(maxChars);
    expect(markdown).not.toContain(world.companyB.id);
    expect(markdown).not.toContain(world.missionB.id);
    expect(markdown).not.toContain(world.issueB.id);
  });
});
