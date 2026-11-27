// server/src/__tests__/data-graph-tool.test.ts
//
// [파일 목적] 읽기 전용 agent tool data_graph_query(services/data-graph/data-graph-tool.ts) 단위 테스트.
// [범위] 도구 스펙 메타데이터·JSON 스키마 구조, 인자 검증 실패 시 throw 없는 { ok:false, error },
//   유효 호출의 companyId 스코프 강제(타사 회사 노드 미포함)와 출처 인용(provenance)·비밀 가림 팩.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues, missions } from "@paperclipai/db";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";
import {
  DATA_GRAPH_QUERY_TOOL_SPEC,
  dataGraphQueryToolArgsSchema,
  executeDataGraphQueryTool,
} from "../services/data-graph/data-graph-tool.js";

let db: Db;
let closeDb: () => Promise<void>;

const SECRET = "sk-abcdef1234567890abcdef";
const SECRET_LABEL = `api_key: ${SECRET}`;

beforeAll(async () => {
  const fixture = await terminalDatabase();
  db = fixture.db;
  closeDb = fixture.close;
});

afterAll(async () => {
  await closeDb?.();
});

/** 회사 A(비밀 제목 이슈 포함 2-hop 그래프)와 격리 검증용 회사 B 미러를 심는다. */
async function seedWorld(target: Db) {
  const [companyA] = await target.insert(companies).values({ name: "Tool A", issuePrefix: randomUUID() }).returning();
  const [companyB] = await target.insert(companies).values({ name: "Tool B", issuePrefix: randomUUID() }).returning();
  const [agentA] = await target.insert(agents).values({ companyId: companyA.id, name: "Worker A", status: "running" }).returning();
  const [agentB] = await target.insert(agents).values({ companyId: companyB.id, name: "Worker B", status: "running" }).returning();
  const [missionA] = await target.insert(missions).values({ companyId: companyA.id, ownerAgentId: agentA.id, title: "Mission A", status: "active" }).returning();
  const [missionB] = await target.insert(missions).values({ companyId: companyB.id, ownerAgentId: agentB.id, title: "Mission B", status: "active" }).returning();
  const [secretIssue] = await target.insert(issues).values({ companyId: companyA.id, missionId: missionA.id, title: SECRET_LABEL, status: "in_progress" }).returning();
  const [plainIssue] = await target.insert(issues).values({ companyId: companyA.id, missionId: missionA.id, title: "Plain A", status: "open" }).returning();
  const [mirrorIssue] = await target.insert(issues).values({ companyId: companyB.id, missionId: missionB.id, title: "Mirror B", status: "open" }).returning();
  return { companyA, companyB, missionA, secretIssue, plainIssue, mirrorIssue };
}

describe("DATA_GRAPH_QUERY_TOOL_SPEC", () => {
  it("declares a read-only data_graph_query tool with bounded parameter JSON schema", () => {
    expect(DATA_GRAPH_QUERY_TOOL_SPEC.name).toBe("data_graph_query");
    expect(DATA_GRAPH_QUERY_TOOL_SPEC.description).toMatch(/read[- ]only/i);

    const schema = DATA_GRAPH_QUERY_TOOL_SPEC.parametersJsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["seedKind", "seedId"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["limit", "maxChars", "maxHops", "seedId", "seedKind"]);
    expect(schema.properties.seedKind.enum).toEqual([
      "mission", "issue", "work_product", "decision", "run", "workflow_run", "step_run", "knowledge_node",
    ]);
    expect(schema.properties.seedKind.type).toBe("string");
    expect(schema.properties.seedId).toMatchObject({ type: "string", minLength: 1 });
    expect(schema.properties.maxHops).toMatchObject({ type: "integer", enum: [1, 2], default: 2 });
    expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 100, default: 50 });
    expect(schema.properties.maxChars).toMatchObject({ type: "integer", minimum: 200, maximum: 16000, default: 4000 });
  });
});

describe("dataGraphQueryToolArgsSchema", () => {
  it("applies documented defaults for optional bounds", () => {
    const seedId = randomUUID();
    expect(dataGraphQueryToolArgsSchema.parse({ seedKind: "issue", seedId })).toEqual({
      seedKind: "issue", seedId, maxHops: 2, limit: 50, maxChars: 4000,
    });
  });

  it("rejects missing, empty, unknown, and out-of-range values", () => {
    expect(dataGraphQueryToolArgsSchema.safeParse({ seedKind: "issue" }).success).toBe(false);
    expect(dataGraphQueryToolArgsSchema.safeParse({ seedKind: "issue", seedId: "  " }).success).toBe(false);
    expect(dataGraphQueryToolArgsSchema.safeParse({ seedKind: "company", seedId: "x" }).success).toBe(false);
    expect(dataGraphQueryToolArgsSchema.safeParse({ seedKind: "issue", seedId: "x", maxHops: 3 }).success).toBe(false);
    expect(dataGraphQueryToolArgsSchema.safeParse({ seedKind: "issue", seedId: "x", maxHops: 0 }).success).toBe(false);
    expect(dataGraphQueryToolArgsSchema.safeParse({ seedKind: "issue", seedId: "x", limit: 0 }).success).toBe(false);
    expect(dataGraphQueryToolArgsSchema.safeParse({ seedKind: "issue", seedId: "x", limit: 101 }).success).toBe(false);
    expect(dataGraphQueryToolArgsSchema.safeParse({ seedKind: "issue", seedId: "x", maxChars: 100 }).success).toBe(false);
    expect(dataGraphQueryToolArgsSchema.safeParse({ seedKind: "issue", seedId: "x", maxChars: 20000 }).success).toBe(false);
  });
});

describe("executeDataGraphQueryTool", () => {
  it("returns ok:false with an error string instead of throwing on invalid args", async () => {
    const result = await executeDataGraphQueryTool(db, randomUUID(), { seedKind: "issue", seedId: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error).toBe("string");
  });

  it("scopes the traversal to the calling company and returns a provenance-cited redacted pack", async () => {
    const world = await seedWorld(db);

    const result = await executeDataGraphQueryTool(db, world.companyA.id, {
      seedKind: "issue", seedId: world.secretIssue.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const nodeKeys = result.graph.nodes.map((n) => `${n.kind}:${n.id}`);
    expect(nodeKeys).toContain(`issue:${world.secretIssue.id}`);
    expect(nodeKeys).toContain(`mission:${world.missionA.id}`);
    expect(nodeKeys).not.toContain(`issue:${world.mirrorIssue.id}`);
    expect(nodeKeys).not.toContain(`mission:${world.companyB.id}`);

    expect(result.contextPack.seed).toEqual({ nodeType: "issue", nodeId: world.secretIssue.id });
    const provenanceKeys = result.contextPack.provenance.map((p) => `${p.nodeType}:${p.nodeId}`);
    expect(provenanceKeys).toContain(`issue:${world.secretIssue.id}`);
    expect(provenanceKeys).toContain(`mission:${world.missionA.id}`);
    const seedProvenance = result.contextPack.provenance.find((p) => p.nodeType === "issue");
    expect(seedProvenance?.hop).toBe(0);

    const packText = result.contextPack.facts.join("\n");
    expect(packText).not.toContain(SECRET);
    expect(packText).toContain("[REDACTED]");
    expect(packText).toContain("issues.mission_id");
  });

  it("clamps the context pack to the requested maxChars budget", async () => {
    const world = await seedWorld(db);

    const result = await executeDataGraphQueryTool(db, world.companyA.id, {
      seedKind: "issue", seedId: world.secretIssue.id, maxHops: 1, limit: 20, maxChars: 200,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contextPack.charCount).toBeLessThanOrEqual(200);
    expect(result.contextPack.truncated).toBe(true);
    expect(result.graph.nodes.length).toBeLessThanOrEqual(20);
  });
});
