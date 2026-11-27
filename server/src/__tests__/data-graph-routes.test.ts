// server/src/__tests__/data-graph-routes.test.ts
//
// [파일 목적] data-graph 읽기 전용 라우트 단위 테스트 — 문제-우선 모드 추천 결정 표 4분기,
//   컨텍스트 팩의 출처 보존·비밀 가림, 잘못된 입력 400, 미인증 401·타회사 403.
// [범위] 라우트는 DB 없는 순수 서비스 호출만 하므로 supertest + 가짜 actor 미들웨어로 검증한다.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues, missions } from "@paperclipai/db";
import { dataGraphRoutes } from "../routes/data-graph.js";
import { errorHandler } from "../middleware/index.js";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

type TestActor = {
  type: "board" | "agent" | "none";
  userId?: string;
  companyId?: string;
  companyIds?: string[];
  source?: string;
  isInstanceAdmin?: boolean;
};

function createApp(actor: TestActor, db?: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", dataGraphRoutes(db));
  app.use(errorHandler);
  return app;
}

const boardActor: TestActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};
// [회사 경계] company-2 소속 에이전트 키 — company-1 접근은 403이어야 한다.
const otherCompanyAgentActor: TestActor = { type: "agent", companyId: "company-2" };
const COMPANY_PATH = "/api/companies/company-1";

describe("POST /companies/:companyId/data-graph/recommend-mode", () => {
  it("routes the problem-first decision table to all 4 modes", async () => {
    const table: Array<[Record<string, unknown>, string]> = [
      [{}, "single_agent"],
      [{ requiresStructuralPause: true }, "workflow_graph"],
      [{ requiresDeterministicBranching: true }, "workflow_graph"],
      [{ requiresMultiHopContext: true }, "data_graph_rag"],
      [{ estimatedHops: 3 }, "data_graph_rag"],
      [{ requiresStructuralPause: true, requiresMultiHopContext: true }, "two_graph"],
      [{ requiresDeterministicBranching: true, estimatedHops: 2 }, "two_graph"],
    ];
    for (const [input, mode] of table) {
      const res = await request(createApp(boardActor))
        .post(`${COMPANY_PATH}/data-graph/recommend-mode`)
        .send(input);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.mode).toBe(mode);
      expect(typeof res.body.rationale).toBe("string");
    }
  });

  it("rejects an invalid payload with 400", async () => {
    const res = await request(createApp(boardActor))
      .post(`${COMPANY_PATH}/data-graph/recommend-mode`)
      .send({ requiresStructuralPause: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });
});

describe("POST /companies/:companyId/data-graph/context-pack", () => {
  it("returns a provenance-preserving redacted context pack", async () => {
    const res = await request(createApp(boardActor))
      .post(`${COMPANY_PATH}/data-graph/context-pack`)
      .send({
        seed: { nodeType: "mission", nodeId: "m-1" },
        nodes: [
          { nodeType: "mission", nodeId: "m-1", hop: 0, label: "Launch mission" },
          { nodeType: "issue", nodeId: "i-1", hop: 1, summary: "api_key: sk-prod-verysecret123" },
        ],
        edges: [
          {
            kind: "has_issue",
            from: { nodeType: "mission", nodeId: "m-1" },
            to: { nodeType: "issue", nodeId: "i-1" },
            viaEdge: "issues.mission_id",
          },
        ],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.seed).toEqual({ nodeType: "mission", nodeId: "m-1" });
    expect(res.body.facts).toHaveLength(3);
    expect(res.body.facts[0]).toContain("mission:m-1 (hop 0, via seed)");
    expect(res.body.facts[1]).toContain("via issues.mission_id");
    expect(res.body.facts[2]).toContain("has_issue: mission:m-1 → issue:i-1");
    // [비밀 미노출] 원문 토큰은 응답 어디에도 재노출되지 않는다.
    expect(JSON.stringify(res.body)).not.toContain("sk-prod-verysecret123");
    expect(JSON.stringify(res.body)).toContain("[REDACTED]");
    expect(res.body.provenance).toEqual([
      { nodeType: "mission", nodeId: "m-1", hop: 0, viaEdge: "seed" },
      { nodeType: "issue", nodeId: "i-1", hop: 1, viaEdge: "issues.mission_id" },
    ]);
    expect(res.body.truncated).toBe(false);
    expect(typeof res.body.charCount).toBe("number");
  });

  it("rejects a payload without seed with 400", async () => {
    const res = await request(createApp(boardActor))
      .post(`${COMPANY_PATH}/data-graph/context-pack`)
      .send({ nodes: [], edges: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });
});

describe("GET /companies/:companyId/data-graph/query", () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let companyId: string;
  let missionId: string;
  let issueId: string;

  beforeAll(async () => {
    const fixture = await terminalDatabase();
    db = fixture.db;
    closeDb = fixture.close;
    const [company] = await db.insert(companies).values({ name: "Query Co", issuePrefix: randomUUID() }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Q Worker", status: "running" }).returning();
    const [mission] = await db.insert(missions).values({ companyId: company.id, ownerAgentId: agent.id, title: "Q Mission", status: "active" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, missionId: mission.id, title: "Q Issue", status: "in_progress" }).returning();
    companyId = company.id;
    missionId = mission.id;
    issueId = issue.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns the bounded traversal for a valid seed", async () => {
    const res = await request(createApp(boardActor, db))
      .get(`/api/companies/${companyId}/data-graph/query`)
      .query({ seed: `mission:${missionId}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.seed).toEqual({ kind: "mission", id: missionId });
    const nodeKeys = res.body.nodes.map((node: { kind: string; id: string }) => `${node.kind}:${node.id}`);
    expect(nodeKeys).toContain(`mission:${missionId}`);
    expect(nodeKeys).toContain(`issue:${issueId}`);
    expect(res.body.edges).toHaveLength(1);
    expect(res.body.edges[0]).toMatchObject({ kind: "mission_issue", via: "issues.mission_id" });
    expect(res.body.truncated).toBe(false);
    expect(res.body.contextPack).toBeUndefined();
  });

  it("rejects a malformed seed with 400", async () => {
    const res = await request(createApp(boardActor, db))
      .get(`/api/companies/${companyId}/data-graph/query`)
      .query({ seed: "mission:not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("rejects an agent key of another company with 403", async () => {
    const res = await request(createApp(otherCompanyAgentActor, db))
      .get(`${COMPANY_PATH}/data-graph/query`)
      .query({ seed: `mission:${missionId}` });
    expect(res.status).toBe(403);
  });

  it("attaches a provenance-bearing context pack when includeContextPack=true", async () => {
    const res = await request(createApp(boardActor, db))
      .get(`/api/companies/${companyId}/data-graph/query`)
      .query({ seed: `mission:${missionId}`, includeContextPack: "true" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.contextPack.seed).toEqual({ nodeType: "mission", nodeId: missionId });
    expect(res.body.contextPack.facts[0]).toContain(`mission:${missionId} (hop 0, via seed)`);
    expect(JSON.stringify(res.body.contextPack.provenance)).toContain("issues.mission_id");
  });
});

describe("company access enforcement", () => {
  it("rejects unauthenticated actors with 401 on both endpoints", async () => {
    const recommend = await request(createApp({ type: "none" }))
      .post(`${COMPANY_PATH}/data-graph/recommend-mode`)
      .send({});
    expect(recommend.status).toBe(401);

    const pack = await request(createApp({ type: "none" }))
      .post(`${COMPANY_PATH}/data-graph/context-pack`)
      .send({ seed: { nodeType: "mission", nodeId: "m-1" }, nodes: [], edges: [] });
    expect(pack.status).toBe(401);
  });

  it("rejects an agent key of another company with 403 on both endpoints", async () => {
    const recommend = await request(createApp(otherCompanyAgentActor))
      .post(`${COMPANY_PATH}/data-graph/recommend-mode`)
      .send({});
    expect(recommend.status).toBe(403);

    const pack = await request(createApp(otherCompanyAgentActor))
      .post(`${COMPANY_PATH}/data-graph/context-pack`)
      .send({ seed: { nodeType: "mission", nodeId: "m-1" }, nodes: [], edges: [] });
    expect(pack.status).toBe(403);
  });
});
