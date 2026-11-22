import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companyKnowledgePatterns, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_FAILURE_MODE_TTL_DAYS,
  FUZZY_TITLE_JACCARD_THRESHOLD,
  normalizeTitleTokens,
  titleJaccardSimilarity,
} from "../services/knowledge-pattern-dedupe.js";
import { KnowledgePatternDuplicateSignatureError } from "../services/knowledge-pattern-evidence-gate.js";
import { knowledgePatternsService } from "../services/knowledge-patterns.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping mistology hygiene tests: ${support.reason ?? "unsupported"}`);
}

// [미스톨로지 위생] 제목 토큰 정규화 + Jaccard 유사도 — 순수 함수 단위 테스트(EP 불필요).
describe("knowledge pattern dedupe helpers (pure)", () => {
  it("normalizeTitleTokens lowercases and strips UUIDs, hex ids, dates, punctuation, 1-char tokens", () => {
    const tokens = normalizeTitleTokens(
      "Gate FAIL! 2026-11-22 9f8e7d6c-b4a5-4321-9876-fedcba098765 deadbeef01, x",
    );
    expect(tokens).toEqual(new Set(["gate", "fail"]));
  });

  it("normalizeTitleTokens keeps Hangul and tokens longer than one char", () => {
    expect(normalizeTitleTokens("구조 게이트 토큰 불일치 QA")).toEqual(
      new Set(["구조", "게이트", "토큰", "불일치", "qa"]),
    );
  });

  it("titleJaccardSimilarity stays in [0,1], 0 on empty sets, >= threshold on near-duplicate titles", () => {
    expect(titleJaccardSimilarity("", "abc")).toBe(0);
    expect(titleJaccardSimilarity("abc def", "abc def")).toBe(1);
    const near = titleJaccardSimilarity(
      "구조 게이트 토큰 불일치로 QA 스텝 무발사",
      "구조 게이트 토큰 불일치로 QA 스텝 미발사",
    );
    expect(near).toBeCloseTo(6 / 8, 5);
    expect(near).toBeGreaterThanOrEqual(FUZZY_TITLE_JACCARD_THRESHOLD);
    expect(titleJaccardSimilarity("세금 계산서 발행", "위성 이미지 해상도")).toBe(0);
  });
});

// [미스톨로지 위생] 임베디드 PG — failure_mode 30일 읽기 TTL + 생성 시점 퍼지 중복 흡수
//   + 정확 서명 409 계약 보존 검증.
describeEP("knowledge pattern mistology hygiene (embedded PG)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("knowledge-pattern-hygiene-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hygiene Co", status: "active", issuePrefix: "MH1" });
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  function createCard(overrides: Record<string, unknown> = {}) {
    return knowledgePatternsService(db).create({
      companyId,
      kind: "failure_mode",
      title: "미스톨로지 위생 기본 카드",
      summary: "위생 검증용 카드.",
      evidence: [],
      source: "operator",
      ...overrides,
    });
  }

  async function ageCard(id: string, days: number) {
    await db
      .update(companyKnowledgePatterns)
      .set({ createdAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) })
      .where(eq(companyKnowledgePatterns.id, id));
  }

  it("30d TTL hides stale failure_mode on default active search, keeps durable constraint, null opts out", async () => {
    const svc = knowledgePatternsService(db);
    const stale = await createCard({ title: "오래된 failure_mode 카드" });
    const durable = await createCard({ kind: "constraint", title: "오래된 constraint 카드" });
    const fresh = await createCard({ title: "신선한 failure_mode 카드" });
    await ageCard(stale.id, DEFAULT_FAILURE_MODE_TTL_DAYS + 10);
    await ageCard(durable.id, DEFAULT_FAILURE_MODE_TTL_DAYS + 10);

    const def = await svc.search({ companyId });
    expect(def.some((c) => c.id === fresh.id)).toBe(true);
    expect(def.some((c) => c.id === stale.id)).toBe(false);
    expect(def.some((c) => c.id === durable.id)).toBe(true);

    const noTtl = await svc.search({ companyId, maxFailureModeAgeDays: null });
    expect(noTtl.some((c) => c.id === stale.id)).toBe(true);
  });

  it("fuzzy duplicate title or overlapping errorSignatures returns the existing card without a new row", async () => {
    const first = await createCard({
      title: "구조 게이트 토큰 불일치로 QA 스텝 무발사",
      errorSignatures: ["TypeError: gate token mismatch"],
    });
    const countRows = () =>
      db
        .select({ id: companyKnowledgePatterns.id })
        .from(companyKnowledgePatterns)
        .where(eq(companyKnowledgePatterns.companyId, companyId));
    const before = await countRows();

    const byTitle = await createCard({ title: "구조 게이트 토큰 불일치로 QA 스텝 미발사" });
    expect(byTitle.id).toBe(first.id);
    const bySignature = await createCard({
      title: "전혀 다른 제목의 재발 카드",
      errorSignatures: ["TypeError: gate token mismatch"],
    });
    expect(bySignature.id).toBe(first.id);
    expect(await countRows()).toHaveLength(before.length);

    const distinct = await createCard({ title: "완전히 다른 신규 카드", errorSignatures: [] });
    expect(distinct.id).not.toBe(first.id);
    const listed = await knowledgePatternsService(db).search({ companyId });
    expect(listed.some((c) => c.id === distinct.id)).toBe(true);
  });

  it("exact defectSignature duplicate still throws KnowledgePatternDuplicateSignatureError (409 contract)", async () => {
    const signature = randomUUID().replace(/-/g, "").repeat(2);
    await createCard({ title: "서명 보유 원본 카드", defectSignature: signature });
    // 같은 제목이라 퍼지 흡수가 먼저 잡히면 409가 새지 않는다 — 정확 서명 단언이 우선이다.
    await expect(createCard({ title: "서명 보유 원본 카드", defectSignature: signature }))
      .rejects.toBeInstanceOf(KnowledgePatternDuplicateSignatureError);
  });
});
