// server/src/__tests__/data-graph-tool-seed.test.ts
//
// [파일 목적] data_graph_query 내장 도구 정의 시드(seedDataGraphQueryTool) 단위 테스트.
// [범위] 회사별 tool_definitions 시드 행이 core-tool-executor의 builtin kind
//   "data-graph-query" 실행 계약(이름·adapterType·adapterConfig·읽기 전용 스키마)과
//   일치하는지, 재시드가 멱등하며 기존 행을 건드리지 않는지, companyId 옵션이 대상
//   회사만 제한하는지, 시드된 행이 executeCoreWorkflowTool dispatch로 실제 실행되는지
//   검증한다. 그래프 탐색·컨텍스트 팩 자체 계약은 data-graph-tool.test.ts가 담당한다.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues, missions, toolDefinitions } from "@paperclipai/db";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";
import {
  DATA_GRAPH_QUERY_TOOL_SPEC,
  seedDataGraphQueryTool,
} from "../services/data-graph/data-graph-tool.js";
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

/** dispatch 스모크용 1-hop 그래프(회사 A)와 companyId 옵션 격리 검증용 회사 B를 심는다. */
async function seedWorld(target: Db) {
  const [companyA] = await target.insert(companies).values({ name: "Seed A", issuePrefix: randomUUID() }).returning();
  const [companyB] = await target.insert(companies).values({ name: "Seed B", issuePrefix: randomUUID() }).returning();
  const [agentA] = await target.insert(agents).values({ companyId: companyA.id, name: "Worker A", status: "running" }).returning();
  const [missionA] = await target.insert(missions).values({ companyId: companyA.id, ownerAgentId: agentA.id, title: "Mission A", status: "active" }).returning();
  const [issueA] = await target.insert(issues).values({ companyId: companyA.id, missionId: missionA.id, title: "Issue A", status: "in_progress" }).returning();
  return { companyA, companyB, missionA, issueA };
}

describe("seedDataGraphQueryTool", () => {
  it("registers one builtin data_graph_query row per company matching the core executor kind contract", async () => {
    const world = await seedWorld(db);

    const result = await seedDataGraphQueryTool(db);

    expect(result.companies).toBe(2);
    expect(result.toolsSeeded).toBe(2);
    for (const company of [world.companyA, world.companyB]) {
      const rows = await db.select().from(toolDefinitions)
        .where(and(
          eq(toolDefinitions.companyId, company.id),
          eq(toolDefinitions.name, DATA_GRAPH_QUERY_TOOL_SPEC.name),
        ));
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.adapterType).toBe("builtin");
      // core-tool-executor.ts의 builtin 분기가 보는 kind — 어긋나면 dispatch가 실패한다.
      expect(row?.adapterConfig).toEqual({ kind: "data-graph-query" });
      expect(row?.enabled).toBe(true);
      expect(row?.description).toBe(DATA_GRAPH_QUERY_TOOL_SPEC.description);
      expect(row?.inputSchema).toEqual(DATA_GRAPH_QUERY_TOOL_SPEC.parametersJsonSchema);
    }
  });

  it("is idempotent: re-seeding inserts nothing and leaves the existing row untouched", async () => {
    const world = await seedWorld(db);

    await seedDataGraphQueryTool(db, { companyId: world.companyA.id });
    const second = await seedDataGraphQueryTool(db, { companyId: world.companyA.id });

    expect(second.companies).toBe(1);
    expect(second.toolsSeeded).toBe(0);
    const rows = await db.select({ id: toolDefinitions.id, description: toolDefinitions.description })
      .from(toolDefinitions)
      .where(and(
        eq(toolDefinitions.companyId, world.companyA.id),
        eq(toolDefinitions.name, DATA_GRAPH_QUERY_TOOL_SPEC.name),
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe(DATA_GRAPH_QUERY_TOOL_SPEC.description);
  });

  it("seeds only the requested company when the companyId option is given", async () => {
    const world = await seedWorld(db);

    const result = await seedDataGraphQueryTool(db, { companyId: world.companyA.id });

    expect(result.companies).toBe(1);
    expect(result.toolsSeeded).toBe(1);
    const otherRows = await db.select({ id: toolDefinitions.id })
      .from(toolDefinitions)
      .where(eq(toolDefinitions.companyId, world.companyB.id));
    expect(otherRows).toHaveLength(0);
  });

  it("seeded row dispatches through executeCoreWorkflowTool as a structured read-only result", async () => {
    const world = await seedWorld(db);
    await seedDataGraphQueryTool(db, { companyId: world.companyA.id });

    const result = await executeCoreWorkflowTool({
      db,
      companyId: world.companyA.id,
      toolName: DATA_GRAPH_QUERY_TOOL_SPEC.name,
      parameters: { seedKind: "issue", seedId: world.issueA.id },
      requestId: randomUUID(),
    });

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.source).toBe("core");
    expect(result.body.tool).toBe(DATA_GRAPH_QUERY_TOOL_SPEC.name);
    const data = result.body.data as { ok: boolean; error?: string };
    expect(data.ok, JSON.stringify(result.body)).toBe(true);
  });
});
