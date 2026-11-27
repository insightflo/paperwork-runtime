// server/src/__tests__/heartbeat-workflow-graph-context.test.ts
//
// [파일 목적] heartbeat-workflow-knowledge-context의 appendOptionalDataGraphContext
//   opt-in 주입 헬퍼 단위 테스트 — opt-in false는 DB 접근 없이 기존 마크다운을
//   byte-for-byte 보존하고, 빈 그래프(0 fact)는 fail-open으로 보존하며,
//   opt-in true는 출처 인용 블록을 예산 안에서 기존 마크다운 뒤에 붙인다.
// [범위] PGlite 인메모리 DB(terminal-cleanup-fixture)로 adapter 실물 파이프라인을
//   통과시킨다. 목 없이 실제 동작만 단언한다.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { agents, companies, issueWorkProducts, issues, missions } from "@paperclipai/db";
import { appendOptionalDataGraphContext } from "../services/heartbeat-workflow-knowledge-context.js";
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

const EXISTING = "## Knowledge Brief\n\n- Deployment checklist: approvals + rollback notes.\n";

describe("appendOptionalDataGraphContext", () => {
  it("keeps the existing markdown byte-for-byte without touching the DB when opt-in is false", async () => {
    // enabled=false는 그래프 질의 전에 short-circuit해야 한다.
    // db를 아예 주지 않아(빈 객체) 질의가 일어나면 이 테스트는 에러로 실패한다.
    const result = await appendOptionalDataGraphContext({} as Db, {
      companyId: randomUUID(),
      seedKind: "issue",
      seedId: randomUUID(),
      existingMarkdown: EXISTING,
    });
    expect(result).toBe(EXISTING);
  });

  it("fails open byte-for-byte when the opt-in graph has no facts (seed row absent)", async () => {
    const [company] = await db.insert(companies).values({ name: "Inject Empty", issuePrefix: randomUUID() }).returning();
    const result = await appendOptionalDataGraphContext(db, {
      companyId: company.id,
      seedKind: "mission",
      seedId: randomUUID(), // absent seed → 0 nodes → 0 facts → empty markdown
      existingMarkdown: EXISTING,
      enabled: true,
    });
    expect(result).toBe(EXISTING);
  });

  it("appends the provenance-cited graph block within budget when opted in with related nodes", async () => {
    const [company] = await db.insert(companies).values({ name: "Inject Rich", issuePrefix: randomUUID() }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Inject worker", status: "running" }).returning();
    const [mission] = await db.insert(missions).values({ companyId: company.id, ownerAgentId: agent.id, title: "Inject mission", status: "active" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, missionId: mission.id, title: "Fix checkout bug", status: "in_progress" }).returning();
    await db.insert(issueWorkProducts).values({ companyId: company.id, issueId: issue.id, type: "artifact", provider: "test", title: "Patch draft", status: "done" }).returning();

    const maxChars = 800;
    const result = await appendOptionalDataGraphContext(db, {
      companyId: company.id,
      seedKind: "issue",
      seedId: issue.id,
      existingMarkdown: EXISTING,
      enabled: true,
      maxChars,
    });
    expect(result.startsWith(EXISTING + "\n\n")).toBe(true);
    const appended = result.slice((EXISTING + "\n\n").length);
    // helper는 adapter 블록을 재가공 없이(composable) 그대로 붙인다.
    const direct = await buildWorkflowStepGraphContext(db, {
      companyId: company.id,
      seedKind: "issue",
      seedId: issue.id,
      maxChars,
    });
    expect(direct.factCount).toBeGreaterThan(0);
    expect(appended).toBe(direct.markdown);
    expect(appended.startsWith("### Related Context (Data Graph · 2-hop)")).toBe(true);
    // provenance citations: 엣지 via 컬럼과 Sources 목록이 모두 인용된다.
    expect(appended).toContain("issues.mission_id");
    expect(appended).toContain("Sources:");
    // 예산: 붙은 블록 전체가 maxChars 안에 머문다.
    expect(appended.length).toBeLessThanOrEqual(maxChars);
  });
});
