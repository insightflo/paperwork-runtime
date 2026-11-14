import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  companyKnowledgePatterns,
  createDb,
  workflowDefinitions,
  workflowRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { knowledgePatternsService } from "../services/knowledge-patterns.js";
import { retire, supersedeWithLineage } from "../services/knowledge-pattern-lifecycle.js";
import {
  explainRelatedKnowledgePatterns,
  selectRelatedKnowledgePatterns,
} from "../services/knowledge-pattern-relevance.js";
import { knowledgePatternsRoutes } from "../routes/knowledge-patterns.js";
import { errorHandler } from "../middleware/index.js";
import { buildEvalCorpus, type EvalPatternCard } from "./helpers/knowledge-pattern-eval-fixtures.js";

const { visible } = buildEvalCorpus();
const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping knowledge pattern hardening DB evals: ${support.reason ?? "unsupported"}`);
}

function rank(query: string, cards: readonly EvalPatternCard[] = visible) {
  return selectRelatedKnowledgePatterns(cards, [query], Math.max(1, cards.length));
}

// [T3 — mistology 후보⑦⑩ 하드닝 eval] 입력 변형 내성(스택트레이스·diff 경로)과 고빈도
//   단어 IDF 방어는 순수 랭킹으로 검증하고, 동시 supersede 경합·검색 오염·explain 라우트만
//   임베디드 PG로 이원화한다(부팅 비용 최소화 — 지정 이원화 원칙).
describe("knowledge pattern hardening evals (pure)", () => {
  it("TS/Node 스택트레이스 :line:col 변형도 같은 파일로 정규화해 소환한다", () => {
    const stack = [
      "AdapterTimeoutError: claude_local child exceeded 600s",
      "    at processAdapter.execute (server/src/adapters/process/execute.ts:142:9)",
      "    at heartbeatSweep (server/src/services/runtime-execution-lifecycle.ts:88:2)",
    ].join("\n");
    const results = rank(stack);
    expect(results[0]?.id).toBe("seed-03");
    // 두 번째 프레임 파일은 seed-08(파일 직접 히트 + execute.ts 1-hop 전파)도 띄운다.
    const viaCoupled = results.find((entry) => entry.id === "seed-08");
    expect(viaCoupled).toBeTruthy();
    expect(viaCoupled?.via).toEqual(
      expect.arrayContaining(["server/src/adapters/process/execute.ts"]),
    );
  });

  it("diff a/·b/ 접두사와 백슬래시·라인 접미사 경로도 정규화 후 동일 파일로 매칭된다", () => {
    const diff = rank("diff --git a/server/src/services/budgets.ts b/server/src/services/budgets.ts");
    expect(diff[0]?.id).toBe("seed-12");
    const windows = rank("a\\server\\src\\services\\budgets.ts:77:12 확인");
    expect(windows[0]?.id).toBe("seed-12");
    const bSide = rank("b/packages/db/drizzle.config.ts 변경 검토");
    expect(bSide[0]?.id).toBe("seed-04");
  });

  it("고빈도 엔티티 IDF 붕괴 방어 — 84장 공유 심볼은 부스트가 붕괴해 희소 엔티티를 넘지 못한다", () => {
    // 총점 비교가 아니라 explain의 엔티티 contribution으로 증명한다 — 노이즈 태그
    //   (workflow/step/owner/token)가 질의 토큰과 겹치면 총점이 태그+본문으로 오르므로
    //   총점 상한은 태그 인플레를 섞어 읽게 된다.
    const explained = explainRelatedKnowledgePatterns(visible, ["sharedWorkflowVocabHelper processAdapter 확인"]);
    const seed = explained[0]!;
    expect(seed.id).toBe("seed-03");
    const rareSymbol = seed.entities.find((entry) => entry.zone === "symbol" && entry.entity === "processadapter");
    expect(rareSymbol?.idf).toBeGreaterThanOrEqual(2); // df=1 희소 심볼은 상한 부스트 ×2
    const noise = explained.filter((entry) => entry.id.startsWith("noise-"));
    expect(noise.length).toBeGreaterThan(0);
    for (const card of noise) {
      const shared = card.entities.find(
        (entry) => entry.zone === "symbol" && entry.entity === "sharedworkflowvocabhelper",
      );
      expect(shared, `${card.id}: 공유 심볼 히트가 없다`).toBeTruthy();
      // df≈80/96 → idfBoost ≈ log2(2.2) ≈ 1.14 — 희소(×2) 대비 명확히 붕괴.
      expect(shared!.idf).toBeLessThan(1.2);
      expect(shared!.contribution).toBeLessThan(8); // 6×1.14≈6.8 << 희소 12
      expect(card.score).toBeLessThan(seed.score); // 태그·본문 인플레까지 합쳐도 시드 아래
    }
  });
});

describeEP("knowledge pattern hardening evals (embedded PG)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let evidenceRunId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("knowledge-pattern-hardening-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Hardening Co", status: "active", issuePrefix: "KH1",
    });
    const definitionId = randomUUID();
    evidenceRunId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: definitionId, companyId, name: "hardening-evidence", stepsJson: [],
    });
    await db.insert(workflowRuns).values({
      id: evidenceRunId, workflowId: definitionId, companyId,
      status: "completed", triggeredBy: "test",
    });
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  function operatorCard(overrides: Record<string, unknown> = {}) {
    return {
      companyId,
      kind: "failure_mode",
      title: "하드닝 카드",
      summary: "eval용 카드.",
      evidence: [{ type: "workflow_run", id: evidenceRunId }],
      source: "operator",
      ...overrides,
    };
  }

  it("동시 supersedeWithLineage 4-way 경합 — 정확히 1승자, 고아 카드 없음", async () => {
    const target = await knowledgePatternsService(db).create(operatorCard({ title: "4-way 대체 대상" }));
    const results = await Promise.allSettled(
      ["A", "B", "C", "D"].map((label) =>
        supersedeWithLineage(db, {
          companyId, existingId: target.id, reason: `대체안 ${label}`,
          next: {
            kind: "failure_mode", title: `4-way 대체안 ${label}`, summary: "동시 대체 경합.",
            evidence: [{ type: "workflow_run", id: evidenceRunId }], source: "operator",
          },
        }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const result of rejected) {
      expect(String((result as PromiseRejectedResult).reason.message))
        .toMatch(/already superseded|superseded concurrently/);
    }
    const [row] = await db
      .select()
      .from(companyKnowledgePatterns)
      .where(eq(companyKnowledgePatterns.id, target.id));
    expect(row!.supersededById).toBe((fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value.id);
    const titles = await db
      .select({ title: companyKnowledgePatterns.title })
      .from(companyKnowledgePatterns)
      .where(eq(companyKnowledgePatterns.companyId, companyId));
    expect(titles.filter((r) => r.title.startsWith("4-way 대체안"))).toHaveLength(1);
  });

  it("검색 오염 0 — superseded/retired/draft 카드는 강한 엔티티를 실어도 기본 검색에 없다", async () => {
    const svc = knowledgePatternsService(db);
    const probeFile = "server/src/services/contamination-probe.ts";
    const superseded = await svc.create(operatorCard({ title: "대체될 프로브 카드", files: [probeFile] }));
    await svc.create(operatorCard({ title: "대체 카드", supersedeId: superseded.id }));
    const retiring = await svc.create(operatorCard({ title: "은퇴할 프로브 카드", files: [probeFile] }));
    await retire(db, { companyId, id: retiring.id, reason: "eval 은퇴" });
    const draft = await svc.create(operatorCard({
      title: "얕은 에이전트 초안", files: [probeFile],
      evidence: [], rootCause: null, whatWorked: null, source: "agent_candidate",
    }));
    expect(draft.status).toBe("draft");
    const active = await svc.create(operatorCard({ title: "정상 프로브 카드", files: [probeFile] }));

    const results = await svc.search({ companyId, files: [probeFile] });
    const ids = new Set(results.map((card) => card.id));
    expect(ids.has(active.id)).toBe(true);
    for (const leakedId of [superseded.id, retiring.id, draft.id]) {
      expect(ids.has(leakedId)).toBe(false);
    }
    const ranked = selectRelatedKnowledgePatterns(results, [probeFile], Math.max(1, results.length));
    expect(ranked[0]?.id).toBe(active.id);
  });

  it("routes: GET /explain — 보드는 카드별 점수 근거 JSON, 에이전트는 403", async () => {
    const svc = knowledgePatternsService(db);
    const probe = await svc.create(operatorCard({
      title: "explain 프로브 카드",
      files: ["server/src/services/explain-probe.ts"],
      errorSignatures: ["explain_probe_signature_v1"],
    }));

    const boardApp = express();
    boardApp.use(express.json());
    boardApp.use((req, _res, next) => {
      (req as typeof req & { actor: unknown }).actor = {
        type: "board", source: "board_key", companyId, companyIds: [companyId],
        isInstanceAdmin: false, actorId: "board-user", agentId: null,
      };
      next();
    });
    boardApp.use("/api", knowledgePatternsRoutes(db));
    boardApp.use(errorHandler);

    const res = await request(boardApp).get(
      `/api/companies/${companyId}/knowledge-patterns/explain?q=${encodeURIComponent("explain_probe_signature_v1")}`,
    );
    expect(res.status).toBe(200);
    const top = res.body.explanations[0];
    expect(top.id).toBe(probe.id);
    expect(top.passesMinScore).toBe(true);
    expect(top.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ zone: "signature", weight: 10, idf: 1, contribution: 10 }),
    ]));
    expect(top.requireMultiBody).toMatchObject({ suppressed: false });
    const empty = await request(boardApp).get(`/api/companies/${companyId}/knowledge-patterns/explain`);
    expect(empty.status).toBe(200);
    expect(empty.body.explanations).toEqual([]);

    const agentApp = express();
    agentApp.use(express.json());
    agentApp.use((req, _res, next) => {
      (req as typeof req & { actor: unknown }).actor = { type: "agent", companyId, agentId: randomUUID(), runId: null };
      next();
    });
    agentApp.use("/api", knowledgePatternsRoutes(db));
    agentApp.use(errorHandler);
    const denied = await request(agentApp).get(
      `/api/companies/${companyId}/knowledge-patterns/explain?q=x`,
    );
    expect(denied.status).toBe(403);
  });
});
