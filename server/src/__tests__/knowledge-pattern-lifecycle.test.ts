import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, companyKnowledgePatterns, createDb, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { knowledgePatternsService } from "../services/knowledge-patterns.js";
import { KnowledgePatternDuplicateSignatureError } from "../services/knowledge-pattern-evidence-gate.js";
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
    // [B2] retire는 supersedeReason을 덮어쓰지 않는다 — 은퇴 사유는 activity log에만 남는다.
    expect(retired.supersedeReason).toBeNull();
    expect(retired.supersededById).toBeNull();

    // 현재 search 필터: includeDrafts 미지정 시 status='active' 고정 → retired는 기본 제외.
    const defaultSearch = await svc.search({ companyId });
    expect(defaultSearch.some((c) => c.id === card.id)).toBe(false);
    // includeDrafts=true는 status 조건을 떼므로 retired도 노출된다(기본 제외만 보장하는 계약).
    const withDrafts = await svc.search({ companyId, includeDrafts: true });
    expect(withDrafts.some((c) => c.id === card.id && c.status === "retired")).toBe(true);

    const logs = await db.select().from(activityLog);
    const retireLog = logs.find((row) => row.action === "knowledge_pattern.retired" && row.entityId === card.id);
    expect(retireLog).toBeTruthy();
    expect((retireLog!.details as { reason?: string }).reason).toBe("더 이상 유효하지 않은 조직 관행");
  });

  // [B2] 체인 헤드가 이미 대체 사유를 갖고 있어도 은퇴가 그것을 덮어쓰지 않는다 —
  //   supersedeReason은 "이 버전이 왜 만들어졌는지"의 계보라 은퇴 사유와 다른 계약이다.
  it("retire preserves an existing supersedeReason — the retire reason lives only in the activity log", async () => {
    const root = await seedCard({ title: "보존 체인 루트" });
    const head = await supersedeWithLineage(db, {
      companyId, existingId: root.id, reason: "v1 판정이 틀렸다", next: nextCard({ title: "보존 체인 헤드" }),
    });
    expect(head.supersedeReason).toBe("v1 판정이 틀렸다");

    const retired = await retire(db, { companyId, id: head.id, reason: "말단 폐기" });
    expect(retired.status).toBe("retired");
    expect(retired.supersedeReason).toBe("v1 판정이 틀렸다");
    const [row] = await db.select().from(companyKnowledgePatterns).where(eq(companyKnowledgePatterns.id, head.id));
    expect(row!.supersedeReason).toBe("v1 판정이 틀렸다");

    const logs = await db.select().from(activityLog);
    const retireLog = logs.find((entry) => entry.action === "knowledge_pattern.retired" && entry.entityId === head.id);
    expect((retireLog!.details as { reason?: string }).reason).toBe("말단 폐기");
  });

  // [B2] pitfalls 계보 병합 상한(60) — 무상한 누적 방지. 초과 시 배열 앞쪽(구 카드
  //   계승분 = 가장 오래된 교훈)부터 잘라 최근 입력을 유지한다.
  it("caps merged pitfalls at 60, dropping the oldest lineage entries and keeping recent ones", async () => {
    const existing = Array.from({ length: 55 }, (_, i) => `기존 교훈 ${i}`);
    const [seeded] = await db.insert(companyKnowledgePatterns).values({
      companyId,
      kind: "failure_mode",
      title: "pitfalls 상한 시드",
      summary: "병합 상한 검증용 — 55개 계승분을 직접 심는다.",
      source: "operator",
      pitfalls: existing,
    }).returning();

    const incoming = Array.from({ length: 10 }, (_, i) => `새 교훈 ${i}`);
    const v2 = await supersedeWithLineage(db, {
      companyId, existingId: seeded.id, reason: "상한 검증",
      next: nextCard({ title: "상한 v2", pitfalls: incoming }),
    });
    expect(v2.pitfalls).toHaveLength(60);
    expect(v2.pitfalls[0]).toBe("기존 교훈 5"); // 가장 오래된 5개(0~4)는 잘린다
    expect(v2.pitfalls[59]).toBe("새 교훈 9"); // 최근 입력 10개는 전부 유지
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

  it("inherits defectSignature across supersede chain and coordinates with createAutoReworkDraft", async () => {
    const svc = knowledgePatternsService(db);
    const sig1 = `sig-inherit-${randomUUID()}`;
    const sig2 = `sig-override-${randomUUID()}`;
    const draft = await svc.createAutoReworkDraft({
      companyId, signature: sig1, title: "자동 초안 v1", summary: "반복 결함 초안",
    });
    const v1 = await svc.approve({ companyId, id: draft.card!.id });

    // ① 서명 미지정 supersede → 기존 카드 서명 계승 + 이전 행 슬롯 해제
    const v2 = await supersedeWithLineage(db, {
      companyId, existingId: v1.id, reason: "서명 계승 대체", next: nextCard({ title: "계승 v2" }),
    });
    expect(v2.defectSignature).toBe(sig1);
    const [v1Row] = await db.select().from(companyKnowledgePatterns).where(eq(companyKnowledgePatterns.id, v1.id));
    expect(v1Row!.supersededById).toBe(v2.id);
    expect(v1Row!.defectSignature).toBeNull();

    // ② 계승 후 동일 서명 createAutoReworkDraft → v2가 슬롯 보유, onConflictDoNothing으로 card:null 반환
    const dupDraft = await svc.createAutoReworkDraft({
      companyId, signature: sig1, title: "재발 초안", summary: "동일 서명 재감지",
    });
    expect(dupDraft.card).toBeNull();

    // 다단계 체인에서도 서명 계승 유지
    const v3 = await supersedeWithLineage(db, {
      companyId, existingId: v2.id, reason: "3차 계승", next: nextCard({ title: "계승 v3" }),
    });
    expect(v3.defectSignature).toBe(sig1);
    const [v2Row] = await db.select().from(companyKnowledgePatterns).where(eq(companyKnowledgePatterns.id, v2.id));
    expect(v2Row!.defectSignature).toBeNull();

    // 타 카드 보유 서명으로 명시 덮어쓰기 시 409 오류 + 롤백으로 기존 서명/계보 보존
    const holder = await seedCard({ title: "타 서명 점유 카드", defectSignature: `sig-taken-${randomUUID()}` });
    await expect(supersedeWithLineage(db, {
      companyId, existingId: v3.id, reason: "충돌 서명", next: nextCard({ defectSignature: holder.defectSignature }),
    })).rejects.toBeInstanceOf(KnowledgePatternDuplicateSignatureError);
    const [v3Intact] = await db.select().from(companyKnowledgePatterns).where(eq(companyKnowledgePatterns.id, v3.id));
    expect(v3Intact!.defectSignature).toBe(sig1);
    expect(v3Intact!.supersededById).toBeNull();

    // 변경 시그니처 명시 대체 → v4는 새 서명, 구 서명 슬롯은 해제되어 createAutoReworkDraft와 공존 가능
    const v4 = await supersedeWithLineage(db, {
      companyId, existingId: v3.id, reason: "서명 변경 대체",
      next: nextCard({ title: "변경 서명 v4", defectSignature: sig2 }),
    });
    expect(v4.defectSignature).toBe(sig2);
    const [v3Row] = await db.select().from(companyKnowledgePatterns).where(eq(companyKnowledgePatterns.id, v3.id));
    expect(v3Row!.defectSignature).toBeNull();

    const coexistingDraft = await svc.createAutoReworkDraft({
      companyId, signature: sig1, title: "구 서명 재발 초안", summary: "해제된 구 서명으로 재생성",
    });
    expect(coexistingDraft.card).not.toBeNull();
    expect(coexistingDraft.card!.defectSignature).toBe(sig1);
    expect(coexistingDraft.card!.id).not.toBe(v4.id);
  });

  it("rejects cross-company evidence (F1a gate) and cross-company supersede/retire", async () => {
    const otherCompanyId = randomUUID();
    const foreignDefId = randomUUID();
    const foreignRunId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Foreign Co", status: "active", issuePrefix: "KF1" });
    await db.insert(workflowDefinitions).values({ id: foreignDefId, companyId: otherCompanyId, name: "foreign-def", stepsJson: [] });
    await db.insert(workflowRuns).values({
      id: foreignRunId, workflowId: foreignDefId, companyId: otherCompanyId, status: "completed", triggeredBy: "test",
    });

    const target = await seedCard({ title: "회사 격리 검증 대상", whatWorked: "회사 격리 게이트" });
    await expect(supersedeWithLineage(db, {
      companyId, existingId: target.id, reason: "타회사 근거",
      next: nextCard({ evidence: [{ type: "workflow_run", id: foreignRunId }] }),
    })).rejects.toThrow(/does not exist/);
    await expect(supersedeWithLineage(db, {
      companyId: otherCompanyId, existingId: target.id, reason: "타회사 대체", next: nextCard({ evidence: [] }),
    })).rejects.toThrow(/same company/);
    await expect(retire(db, { companyId: otherCompanyId, id: target.id, reason: "타회사 은퇴" })).rejects.toThrow(/cannot be retired/);

    const [row] = await db.select().from(companyKnowledgePatterns).where(eq(companyKnowledgePatterns.id, target.id));
    expect(row!.supersededById).toBeNull();
    expect(row!.status).toBe("active");
    const foreignCards = await db.select().from(companyKnowledgePatterns).where(eq(companyKnowledgePatterns.companyId, otherCompanyId));
    expect(foreignCards).toHaveLength(0);
  });
});
