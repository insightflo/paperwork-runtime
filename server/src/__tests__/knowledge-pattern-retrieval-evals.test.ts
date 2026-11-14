import { describe, expect, it } from "vitest";

import { BRIEF_CARD_LIMIT, BRIEF_MAX_CHARS, formatKnowledgePatternBriefs } from "../services/knowledge-pattern-brief.js";
import {
  explainRelatedKnowledgePatterns,
  selectRelatedKnowledgePatterns,
} from "../services/knowledge-pattern-relevance.js";
import { buildEvalCorpus, type EvalPatternCard } from "./helpers/knowledge-pattern-eval-fixtures.js";

// [T3 — mistology 후보⑦] 지식 패턴 검색 품질 정량 eval — 임베디드 PG 없이 관련도 엔진을
//   직접 호출해 회귀 방지망 지표를 측정한다(순수 함수만, 부팅 비용 0).
//   코퍼스: Paperwork 실제 결함 유형 시드 16장 + 도메인 단어 남용 노이즈 84장(오염 4장 포함).
//   visible = 기본 검색 계약의 순수 거울(active + supersededById IS NULL) — 오염 카드가
//   "강한 엔티티를 싣고도 한 장도 랭크되지 않는가"를 증명하는 데 쓴다.

const { seeds, all, visible, contaminated } = buildEvalCorpus();

function rank(query: string, cards: readonly EvalPatternCard[] = visible) {
  return selectRelatedKnowledgePatterns(cards, [query], Math.max(1, cards.length));
}

function topIds(query: string, n: number) {
  return rank(query).slice(0, n).map((entry) => entry.id);
}

describe("knowledge pattern retrieval evals (pure ranking — no embedded PG)", () => {
  it("signature Recall@1 ≥ 14/16 — 고유 서명 질의가 자기 카드를 1위로 소환한다", () => {
    const missed = seeds
      .filter((seed) => rank(seed.signatureQuery)[0]?.id !== seed.card.id)
      .map((seed) => seed.key);
    expect(seeds.length - missed.length, `Recall@1 misses: ${missed.join(", ")}`).toBeGreaterThanOrEqual(14);
    expect(missed).toEqual([]);
  });

  it("한국어 조사 변형 Recall@2 ≥ 14/16 — 조사가 붙어도 본문 토큰으로 소환된다", () => {
    const variants = seeds.filter((seed) => seed.koreanQuery);
    expect(variants.length).toBe(16);
    const missed = variants
      .filter((seed) => !topIds(seed.koreanQuery!, 2).includes(seed.card.id))
      .map((seed) => seed.key);
    expect(variants.length - missed.length, `ko Recall@2 misses: ${missed.join(", ")}`)
      .toBeGreaterThanOrEqual(14);
  });

  it("camelCase 서브워드 변형 Recall@2 ≥ 11/12 — 심볼을 띄어 써도 본문 토큰으로 소환된다", () => {
    const variants = seeds.filter((seed) => seed.camelQuery);
    expect(variants.length).toBe(12);
    const missed = variants
      .filter((seed) => !topIds(seed.camelQuery!, 2).includes(seed.card.id))
      .map((seed) => seed.key);
    expect(variants.length - missed.length, `camel Recall@2 misses: ${missed.join(", ")}`)
      .toBeGreaterThanOrEqual(11);
  });

  it("1-hop coupled 동시 소환 — 질의 파일이 앵커 카드와 결합 카드를 함께 띄우고 via가 남는다", () => {
    const results = rank("server/src/services/plugin-webhook-receipt.ts wake 웹훅 수신");
    const ids = results.map((entry) => entry.id);
    expect(ids).toContain("seed-06"); // files 앵커 카드(직접 히트)
    expect(ids).toContain("seed-07"); // coupled 결합 카드(1-hop 전파)
    const coupled = results.find((entry) => entry.id === "seed-07");
    expect(coupled?.via).toEqual(expect.arrayContaining(["server/src/services/plugin-webhook-receipt.ts"]));
  });

  it("True-Negative — 도메인 무관 질의에는 카드가 한 장도 뜨지 않는다(침묵률 100%)", () => {
    const foreign = [
      "kubernetes pod eviction policy",
      "redis sentinel failover election",
      "graphql federation subgraph gateway",
      "nginx ingress rate limit",
      "kafka consumer lag rebalance",
      "elasticsearch shard reallocation",
      "openssl certificate expiry alert",
      "docker overlay network mtu",
    ];
    const loud = foreign.filter((query) => rank(query).length > 0);
    expect(loud, `silence broken by: ${loud.join(" | ")}`).toEqual([]);
  });

  it("오염 0 — 비가시(superseded/draft/retired) 카드는 강한 엔티티를 실어도 랭크되지 않는다", () => {
    // 순수 엔진은 상태를 모른다 — 오염 카드는 코퍼스 전체(all)에 넣으면 실제로 상위에 뜬다.
    //   즉 visible 필터가 진짜로 막아야 하는 카드다(약한 카드라면 오염 검증이 무의미).
    expect(contaminated.length).toBeGreaterThanOrEqual(3);
    const inAll = selectRelatedKnowledgePatterns(
      all,
      ["gate_token_mismatch: stale completion token"],
      10,
    );
    expect(inAll.some((entry) => entry.id === "noise-081" && entry.score >= 10)).toBe(true);

    // 가시 집합(기본 검색 계약의 순수 거울)에서는 모든 시드 질의에 한 장도 누출되지 않는다.
    const leaked = new Set(contaminated.map((card) => card.id));
    for (const seed of seeds) {
      for (const entry of rank(seed.signatureQuery)) {
        expect(leaked.has(entry.id), `${entry.id} leaked via ${seed.key}`).toBe(false);
      }
    }
  });

  it("브리핑 상한 불변식 — 랭크 상위 카드는 2장+요약 행으로 카드당 280자 이내다", () => {
    const query = seeds[0]!.signatureQuery;
    const ranked = rank(query).slice(0, 5);
    expect(ranked.length).toBeGreaterThanOrEqual(1);
    const cardsById = new Map(visible.map((card) => [card.id, card]));
    const cards = ranked.map((entry) => cardsById.get(entry.id)!);
    const briefs = formatKnowledgePatternBriefs(cards, { contextTexts: [query] });
    expect(briefs.length).toBeLessThanOrEqual(BRIEF_CARD_LIMIT + 1);
    for (const brief of briefs) expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    if (ranked.length > BRIEF_CARD_LIMIT) {
      expect(briefs[briefs.length - 1]).toContain(`외 ${ranked.length - BRIEF_CARD_LIMIT}장 유사`);
    }
  });

  it("explain — 점수·순서가 select와 일치하고 영역·IDF·가드 근거를 실어준다", () => {
    const query = seeds[0]!.signatureQuery;
    const ranked = rank(query);
    const explained = explainRelatedKnowledgePatterns(visible, [query]);
    // 통과 집합의 순서가 랭킹과 동일해야 한다(같은 파이프라인 — scoreKnowledgePatternCard 공유).
    expect(explained.filter((entry) => entry.passesMinScore).map((entry) => entry.id))
      .toEqual(ranked.map((entry) => entry.id));
    const top = explained[0]!;
    expect(top.id).toBe("seed-01");
    expect(top.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ zone: "signature", weight: 10, contribution: 10 }),
    ]));
    expect(top.requireMultiBody.suppressed).toBe(false);

    // requireMultiBody 억제 판정 수집 — 단일 본문 토큰 카드는 점수 0 + suppressed 플래그.
    const suppression = explainRelatedKnowledgePatterns(
      [{ id: "lone", title: "계산서만 쓴 카드", symptoms: null, rootCause: null, scopeTags: [] }],
      ["계산서 발행 오류"],
    );
    expect(suppression[0]?.requireMultiBody).toMatchObject({ bodyHits: 1, tagHits: 0, strongEntity: false, suppressed: true });
    expect(suppression[0]?.score).toBe(0);
  });
});
