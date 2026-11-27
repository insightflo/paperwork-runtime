// server/src/__tests__/workflow-context-adapter.test.ts
//
// [파일 목적] workflow-context-adapter(Two-Graph thin bridge) 단위 테스트 — 빈 그래프는
//   프롬프트 비대 영(zero bloat) 계약, 비어 있지 않은 그래프는 maxChars 안의 출처 인용
//   마크다운, 비밀 모양 문자열 가림을 검증한다.
// [범위] PGlite 인메모리 DB(terminal-cleanup-fixture)로 traversal·팩 실물 파이프라인을
//   통과시킨다. 목 없이 실제 동작만 단언한다.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { agents, companies, issueWorkProducts, issues, missions } from "@paperclipai/db";
import { buildWorkflowStepGraphContext } from "../services/data-graph/workflow-context-adapter.js";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  const terminal = await terminalDatabase();
  db = terminal.db;
  closeDb = terminal.close;
});

afterAll(async () => {
  await closeDb();
});

async function seedCompany(name: string): Promise<{ companyId: string; agentId: string }> {
  const [company] = await db.insert(companies).values({ name, issuePrefix: randomUUID() }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: `${name} worker`, status: "running" }).returning();
  return { companyId: company.id, agentId: agent.id };
}

describe("buildWorkflowStepGraphContext", () => {
  it("returns the empty contract (zero prompt bloat) when the seed row is absent", async () => {
    const { companyId } = await seedCompany("Adapter Empty");
    const result = await buildWorkflowStepGraphContext(db, {
      companyId,
      seedKind: "mission",
      seedId: randomUUID(),
    });
    expect(result).toEqual({ markdown: "", factCount: 0, truncated: false, provenanceCount: 0 });
  });

  it("renders a provenance-cited markdown block bounded by maxChars", async () => {
    const { companyId, agentId } = await seedCompany("Adapter Rich");
    const [mission] = await db.insert(missions).values({
      companyId, ownerAgentId: agentId, title: "Launch mission", status: "active",
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId, missionId: mission.id, title: "Fix checkout bug", status: "in_progress",
    }).returning();
    await db.insert(issueWorkProducts).values({
      companyId, issueId: issue.id, type: "artifact", provider: "test", title: "Patch draft", status: "done",
    }).returning();

    const result = await buildWorkflowStepGraphContext(db, { companyId, seedKind: "issue", seedId: issue.id });
    expect(result.factCount).toBeGreaterThan(0);
    expect(result.provenanceCount).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
    expect(result.markdown.startsWith("### Related Context (Data Graph · 2-hop)")).toBe(true);
    // 엣지 fact와 Sources 목록 양쪽에 via 근거 컬럼이 인용된다.
    expect(result.markdown).toContain("issues.mission_id");
    expect(result.markdown).toContain("issue_work_products.issue_id");
    expect(result.markdown).toContain("Sources:");
    expect(result.markdown.length).toBeLessThanOrEqual(4_000);

    // 예산을 줄이면 fact를 통째로 버려 truncated=true, 마크다운 전체가 예산 안에 머문다.
    const bounded = await buildWorkflowStepGraphContext(db, {
      companyId, seedKind: "issue", seedId: issue.id, maxChars: 300,
    });
    expect(bounded.markdown.length).toBeLessThanOrEqual(300);
    expect(bounded.truncated).toBe(true);
  });

  it("redacts secret-shaped strings before rendering", async () => {
    const { companyId, agentId } = await seedCompany("Adapter Secret");
    const [mission] = await db.insert(missions).values({
      companyId, ownerAgentId: agentId, title: "Mission api_key: supersecretvalue99", status: "active",
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId, missionId: mission.id, title: "Issue token sk-abcdefghij1234567890 leak", status: "in_progress",
    }).returning();
    const result = await buildWorkflowStepGraphContext(db, { companyId, seedKind: "issue", seedId: issue.id });
    expect(result.markdown).not.toContain("supersecretvalue99");
    expect(result.markdown).not.toContain("sk-abcdefghij1234567890");
    expect(result.markdown).toContain("[REDACTED]");
  });
});
