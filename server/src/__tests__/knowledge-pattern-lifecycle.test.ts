import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, companyKnowledgePatterns, createDb, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { knowledgePatternsService } from "../services/knowledge-patterns.js";
import { retire, supersedeWithLineage } from "../services/knowledge-pattern-lifecycle.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping knowledge pattern lifecycle tests: ${support.reason ?? "unsupported"}`);
}

// [T2a — mistology 흡수] supersede 계보 보존(versionNumber/supersedeReason/pitfalls
//   병합)과 retired 은퇴 라이프사이클 검증. 기존 create() 회귀는 knowledge-patterns.test.ts가 담당.
describeEP("knowledge pattern lifecycle (supersede lineage + retire)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let evidenceWorkflowRunId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("knowledge-pattern-lifecycle-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lifecycle Co", status: "active", issuePrefix: "KL1" });
    const workflowDefinitionId = randomUUID();
    evidenceWorkflowRunId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowDefinitionId, companyId, name: "evidence-fixture", stepsJson: [] });
    await db.insert(workflowRuns).values({
      id: evidenceWorkflowRunId, workflowId: workflowDefinitionId, companyId,
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

  function seedCard(overrides: Record<string, unknown> = {}) {
    return knowledgePatternsService(db).create({
      companyId,
      kind: "failure_mode",
      title: "시드 카드",
      summary: "라이프사이클 검증용 원본 카드.",
      evidence: [{ type: "workflow_run", id: evidenceWorkflowRunId }],
      source: "mission_owner_compile",
      ...overrides,
    });
  }

  function nextCard(overrides: Record<string, unknown> = {}) {
    return {
      kind: "failure_mode",
      title: "다음 버전 카드",
      summary: "대체 발행되는 새 버전.",
      evidence: [{ type: "workflow_run", id: evidenceWorkflowRunId }],
      source: "mission_owner_compile",
      ...overrides,
    };
  }

  it("preserves lineage on supersede: merged pitfalls, inherited whatWorked, versionNumber+1, reason recorded", async () => {
    const original = await seedCard({ title: "v1 오답", whatWorked: "구 게이트 재큐" });
    expect(original.versionNumber).toBe(1);
    expect(original.pitfalls).toEqual([]);

    const v2 = await supersedeWithLineage(db, {
      companyId, existingId: original.id, reason: "v1의 원인 분석이 틀렸다",
      next: nextCard({ title: "v2 정정", pitfalls: ["구 토큰과 신 토큰을 문자열 비교하면 안 된다"] }),
    });
    expect(v2.versionNumber).toBe(2);
    expect(v2.supersedeReason).toBe("v1의 원인 분석이 틀렸다");
    expect(v2.whatWorked).toBe("구 게이트 재큐");
    expect(v2.pitfalls).toEqual(["구 토큰과 신 토큰을 문자열 비교하면 안 된다"]);

    const [supersededRow] = await db.select().from(companyKnowledgePatterns).where(eq(companyKnowledgePatterns.id, original.id));
    expect(supersededRow.supersededById).toBe(v2.id);

    const v3 = await supersedeWithLineage(db, {
      companyId, existingId: v2.id, reason: "v2도 절반만 맞았다",
      next: nextCard({
        title: "v3 최종", whatWorked: "세대 토큰 CAS",
        pitfalls: ["구 토큰과 신 토큰을 문자열 비교하면 안 된다", "게이트 없이 재완료하면 안 된다"],
      }),
    });
    expect(v3.versionNumber).toBe(3);
    expect(v3.whatWorked).toBe("세대 토큰 CAS");
    expect(v3.pitfalls).toEqual(["구 토큰과 신 토큰을 문자열 비교하면 안 된다", "게이트 없이 재완료하면 안 된다"]);
  });

  it("retire moves active card to retired, records reason, and excludes it from default search", async () => {
    const svc = knowledgePatternsService(db);
    const card = await seedCard({ title: "은퇴 대상 카드" });
    const retired = await retire(db, { companyId, id: card.id, reason: "더 이상 유효하지 않은 조직 관행" });
    expect(retired.status).toBe("retired");
    expect(retired.supersedeReason).toBe("더 이상 유효하지 않은 조직 관행");
    expect(retired.supersededById).toBeNull();

    // 현재 search 필터: includeDrafts 미지정 시 status='active' 고정 → retired는 기본 제외.
    const defaultSearch = await svc.search({ companyId });
    expect(defaultSearch.some((c) => c.id === card.id)).toBe(false);
    // includeDrafts=true는 status 조건을 떼므로 retired도 노출된다(기본 제외만 보장하는 계약).
    const withDrafts = await svc.search({ companyId, includeDrafts: true });
    expect(withDrafts.some((c) => c.id === card.id && c.status === "retired")).toBe(true);

    const logs = await db.select().from(activityLog);
    expect(logs.some((row) => row.action === "knowledge_pattern.retired" && row.entityId === card.id)).toBe(true);
  });

  it("rejects retiring superseded/retired cards and superseding a retired (chain-terminal) card", async () => {
    const a = await seedCard({ title: "체인 루트" });
    const b = await supersedeWithLineage(db, {
      companyId, existingId: a.id, reason: "정정", next: nextCard({ title: "체인 v2" }),
    });
    await expect(retire(db, { companyId, id: a.id, reason: "superseded 카드 은퇴 시도" })).rejects.toThrow(/cannot be retired/);

    const retiredB = await retire(db, { companyId, id: b.id, reason: "말단 은퇴" });
    expect(retiredB.status).toBe("retired");
    await expect(retire(db, { companyId, id: b.id, reason: "재은퇴 시도" })).rejects.toThrow(/cannot be retired/);
    await expect(supersedeWithLineage(db, {
      companyId, existingId: b.id, reason: "말단 부활 시도", next: nextCard({ title: "부활 카드" }),
    })).rejects.toThrow(/retired/);
  });

  it("concurrent supersedeWithLineage on one target: exactly one winner, no orphan card", async () => {
    const target = await seedCard({ title: "동시 대체 대상" });
    const results = await Promise.allSettled([
      supersedeWithLineage(db, { companyId, existingId: target.id, reason: "A", next: nextCard({ title: "계보 대체안 A" }) }),
      supersedeWithLineage(db, { companyId, existingId: target.id, reason: "B", next: nextCard({ title: "계보 대체안 B" }) }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason.message)).toMatch(/already superseded|superseded concurrently/);

    const [row] = await db.select().from(companyKnowledgePatterns).where(eq(companyKnowledgePatterns.id, target.id));
    expect(row!.supersededById).toBe((fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value.id);
    const titles = await db
      .select({ title: companyKnowledgePatterns.title })
      .from(companyKnowledgePatterns)
      .where(eq(companyKnowledgePatterns.companyId, companyId));
    expect(titles.filter((r) => r.title === "계보 대체안 A" || r.title === "계보 대체안 B")).toHaveLength(1);
  });

  it("reuses create gates: forged evidence and invalid kind rejected before any write", async () => {
    const target = await seedCard({ title: "게이트 검증 대상" });
    const before = await db.select({ id: companyKnowledgePatterns.id }).from(companyKnowledgePatterns);
    await expect(supersedeWithLineage(db, {
      companyId, existingId: target.id, reason: "위조 근거",
      next: nextCard({ evidence: [{ type: "mission", id: randomUUID() }] }),
    })).rejects.toThrow(/does not exist/);
    await expect(supersedeWithLineage(db, {
      companyId, existingId: target.id, reason: "잘못된 종류",
      next: nextCard({ kind: "gossip" }),
    })).rejects.toThrow(/kind/);
    const after = await db.select({ id: companyKnowledgePatterns.id }).from(companyKnowledgePatterns);
    expect(after.length).toBe(before.length);
    const [row] = await db.select().from(companyKnowledgePatterns).where(eq(companyKnowledgePatterns.id, target.id));
    expect(row!.supersededById).toBeNull();
  });
});
