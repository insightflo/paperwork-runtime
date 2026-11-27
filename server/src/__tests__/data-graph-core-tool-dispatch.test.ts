// server/src/__tests__/data-graph-core-tool-dispatch.test.ts
//
// [파일 목적] core-tool-executor의 data_graph_query 내장 도구 dispatch 분기 단위 테스트.
// [범위] builtin(kind data-graph-query) 도구 행이 executeDataGraphQueryTool로 위임되는지,
//   실행 스코프가 신뢰된 호출 컨텍스트 companyId로 강제되는지(rawArgs 주입 companyId 무시),
//   구조화 ok/error 결과가 예외 없이 도구 결과 본문으로 반환되는지 검증한다.
//   도구 스펙·실행기 자체 계약은 data-graph-tool.test.ts가 담당한다.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues, missions, toolDefinitions } from "@paperclipai/db";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";

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

/** 회사 A 그래프와 격리 검증용 회사 B 미러를 심고 data_graph_query 내장 도구 행을 등록한다. */
async function seedWorld(target: Db) {
  const [companyA] = await target.insert(companies).values({ name: "Dispatch A", issuePrefix: randomUUID() }).returning();
  const [companyB] = await target.insert(companies).values({ name: "Dispatch B", issuePrefix: randomUUID() }).returning();
  const [agentA] = await target.insert(agents).values({ companyId: companyA.id, name: "Worker A", status: "running" }).returning();
  const [agentB] = await target.insert(agents).values({ companyId: companyB.id, name: "Worker B", status: "running" }).returning();
  const [missionA] = await target.insert(missions).values({ companyId: companyA.id, ownerAgentId: agentA.id, title: "Mission A", status: "active" }).returning();
  const [missionB] = await target.insert(missions).values({ companyId: companyB.id, ownerAgentId: agentB.id, title: "Mission B", status: "active" }).returning();
  const [issueA] = await target.insert(issues).values({ companyId: companyA.id, missionId: missionA.id, title: "Issue A", status: "in_progress" }).returning();
  const [mirrorIssue] = await target.insert(issues).values({ companyId: companyB.id, missionId: missionB.id, title: "Mirror B", status: "open" }).returning();
  await target.insert(toolDefinitions).values({
    companyId: companyA.id,
    name: "data_graph_query",
    adapterType: "builtin",
    adapterConfig: { kind: "data-graph-query" },
  });
  return { companyA, companyB, missionA, missionB, issueA, mirrorIssue };
}

type GraphToolData = {
  ok: boolean;
  error?: string;
  graph?: { nodes: { kind: string; id: string }[] };
  contextPack?: {
    seed: { nodeType: string; nodeId: string };
    provenance: { nodeType: string; nodeId: string; hop: number }[];
  };
};

describe("executeCoreWorkflowTool data_graph_query dispatch", () => {
  it("dispatches the builtin read-only tool with trusted company scoping, ignoring companyId injected in args", async () => {
    const world = await seedWorld(db);

    const result = await executeCoreWorkflowTool({
      db,
      companyId: world.companyA.id,
      toolName: "data_graph_query",
      parameters: {
        seedKind: "issue",
        seedId: world.issueA.id,
        // 모델이 회사 경계를 넘으려 주입한 companyId — 실행 스코프는 호출 컨텍스트 companyId만 따른다.
        companyId: world.companyB.id,
      },
      requestId: randomUUID(),
    });

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.source).toBe("core");
    expect(result.body.tool).toBe("data_graph_query");
    const data = result.body.data as GraphToolData;
    expect(data.ok, JSON.stringify(result.body)).toBe(true);
    if (!data.ok || !data.graph || !data.contextPack) return;

    const nodeKeys = data.graph.nodes.map((node) => `${node.kind}:${node.id}`);
    expect(nodeKeys).toContain(`issue:${world.issueA.id}`);
    expect(nodeKeys).toContain(`mission:${world.missionA.id}`);
    expect(nodeKeys).not.toContain(`issue:${world.mirrorIssue.id}`);
    expect(nodeKeys).not.toContain(`mission:${world.missionB.id}`);

    expect(data.contextPack.seed).toEqual({ nodeType: "issue", nodeId: world.issueA.id });
    const seedProvenance = data.contextPack.provenance.find((entry) => entry.nodeType === "issue");
    expect(seedProvenance?.hop).toBe(0);
  });

  it("returns the structured ok:false failure instead of throwing on invalid args", async () => {
    const world = await seedWorld(db);

    const result = await executeCoreWorkflowTool({
      db,
      companyId: world.companyA.id,
      toolName: "data_graph_query",
      parameters: { seedKind: "issue", seedId: "" },
      requestId: randomUUID(),
    });

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const data = result.body.data as GraphToolData;
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe("string");
  });
});
