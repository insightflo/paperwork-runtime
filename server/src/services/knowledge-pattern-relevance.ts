// server/src/services/knowledge-pattern-relevance.ts
//
// [파일 목적] 지식 패턴 카드 관련도 순수 선택기 — 카드↔문맥의 결정론적 매칭.
//   소비자: 오너 언블록 방아쇠(mission-owner-related-patterns), 카드 중복 힌트(knowledge-patterns),
//   T1c 검색 랭킹. LLM 없음, 프로즈 파싱 없음 — 구조화 필드·토큰 중복만.
// [T1b — mistology 흡수] 단일 카드 토큰 카운트에서 결합 그래프+정규화 가중치 엔진으로 확장:
//   - 엔티티 가중치: errorSignatures 10 > symbols 6 > files 3 > coupled 1. 같은 엔티티가 여러
//     영역에 걸치면 최고 가중치 1회만 합산(태그 3점+본문 토큰 1점의 기존 가산 계약은 유지).
//   - TF-IDF: 희소 심볼/파일에 log2(1+N/df) 부스트를 [1,2]로 클램프 — 고빈도 단어
//     (workflow/mission/issue)는 부스트가 1로 붕괴해 인플레이션되지 않는다.
//   - 그래프 1-hop 전파(files→coupled, 허브 감쇠) 합산 + via 경유 라벨.
//   - requireMultiBody: 본문 토큰 1개만 겹친 카드는 0점(단일 토큰 우연 일치 차단).
//     단 files/symbols/errorSignatures 정확 일치는 예외(태그는 기존 계약상 생존 신호).
// [비고] knowledge-patterns.ts와 서로 import하지 않는다(순환 방지).

import type { KnowledgePattern } from "./knowledge-patterns.js";
import {
  corpusHasEntityKey,
  extractFileRefs,
  normalizeCodePathRef,
  normalizeKnowledgeTokens,
  resolvePathAlias,
} from "./knowledge-text-normalizer.js";
import { propagateCoupledPatterns } from "./knowledge-pattern-graph.js";

export const DEFAULT_RELEVANCE_SCORE_LIMIT = 3;
const MIN_RELEVANCE_SCORE = 2;
const TAG_MATCH_SCORE = 3;
const SIGNATURE_WEIGHT = 10;
const SYMBOL_WEIGHT = 6;
const FILE_WEIGHT = 3;
const COUPLED_WEIGHT = 1;
const IDF_CEILING = 2;
const MIN_ENTITY_KEY_LENGTH = 3;

export type RelatedKnowledgePattern = {
  id: string;
  title: string;
  score: number;
  /** 1-hop 결합 전파 경유 엔티티(T1c 주입 브리핑·T3 explain용 — 전파 기여가 없으면 생략). */
  via?: string[];
};

export type RelevanceOptions = {
  /** 경로 별칭 맵(예: { "@": "server/src" }) — 제공될 때만 질의·카드 경로에 적용. */
  aliasMap?: Readonly<Record<string, string>>;
};

type RelevanceCard = Pick<KnowledgePattern, "id" | "title" | "symptoms" | "rootCause" | "scopeTags"> &
  Partial<Pick<KnowledgePattern, "summary" | "files" | "symbols" | "coupled" | "errorSignatures">>;

/** 엔티티 영역 라벨 — 점수·설명이 공유하는 영역 식별자(propagated = files→coupled 1-hop 전파). */
export type KnowledgePatternEntityZone = "signature" | "symbol" | "file" | "coupled" | "propagated";

/** 엔티티 영역 히트 — 병합 후 최고 가중치 1회 합산. boostable/strong은 가드·IDF 판정용,
 *  zone은 최고 가중치 기여 영역의 라벨(explain 출력 전용 — 점수 계산에는 관여하지 않는다). */
type EntityHit = { weight: number; boostable: boolean; strong: boolean; zone: KnowledgePatternEntityZone };

/** [T3 explain] 카드 한 장의 점수 근거 — 랭킹과 같은 파이프라인에서 수집하는 읽기 전용 진단 레코드. */
export type KnowledgePatternEntityContribution = {
  zone: KnowledgePatternEntityZone;
  entity: string;
  weight: number;
  /** 적용된 IDF 배율(비부스트 영역은 1). */
  idf: number;
  /** 실제 합산 점수(weight × idf). */
  contribution: number;
};

export type KnowledgePatternScoreExplanation = {
  id: string;
  title: string;
  score: number;
  /** MIN_RELEVANCE_SCORE 통과 여부 — select 결과 포함과 동일 의미. */
  passesMinScore: boolean;
  via?: string[];
  tagMatches: string[];
  bodyTokenMatches: string[];
  entities: KnowledgePatternEntityContribution[];
  /** requireMultiBody 판정 — suppressed면 단일 본문 토큰 우연 일치로 점수가 0이 됐다. */
  requireMultiBody: { bodyHits: number; tagHits: number; strongEntity: boolean; suppressed: boolean };
};

const asArray = (value: readonly string[] | undefined): string[] => [...(value ?? [])];

const collapseKey = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

/** TF-IDF 부스트 — log2(1 + N/df)를 [1, IDF_CEILING]로 클램프(희소 상승·고빈도 붕괴 방어). */
function idfBoost(documentFrequency: number, corpusSize: number): number {
  if (corpusSize <= 1 || documentFrequency <= 0) return 1;
  return Math.min(IDF_CEILING, Math.max(1, Math.log2(1 + corpusSize / documentFrequency)));
}

function mergeHit(hits: Map<string, EntityHit>, key: string, hit: EntityHit): void {
  const previous = hits.get(key);
  if (!previous) {
    hits.set(key, hit);
    return;
  }
  hits.set(key, {
    weight: Math.max(previous.weight, hit.weight),
    boostable: previous.boostable || hit.boostable,
    strong: previous.strong || hit.strong,
    zone: hit.weight > previous.weight ? hit.zone : previous.zone,
  });
}

type PreparedRelevanceContext = {
  contextTokens: ReadonlySet<string>; contextCorpus: string; fileRefSet: ReadonlySet<string>;
  fileRefsByCard: ReadonlyMap<string, string[]>; symbolKeysByCard: ReadonlyMap<string, string[]>;
  fileDf: ReadonlyMap<string, number>; symbolDf: ReadonlyMap<string, number>;
  propagation: ReturnType<typeof propagateCoupledPatterns>;
  aliasMap: Readonly<Record<string, string>>; corpusSize: number;
};

/** 질의·코퍼스 전처리 — select/explain 공통 단일 소스. 토큰·파일 참조가 모두 없으면 null(매칭 불가). */
function prepareRelevanceContext(
  cards: readonly RelevanceCard[],
  contextTexts: readonly string[],
  options: RelevanceOptions,
): PreparedRelevanceContext | null {
  const contextText = contextTexts.join(" ");
  const contextTokens = new Set(normalizeKnowledgeTokens(contextText));
  const contextCorpus = collapseKey(contextText);
  const aliasMap = options.aliasMap ?? {};
  const fileRefSet = new Set(
    extractFileRefs(contextTexts)
      .map((ref) => resolvePathAlias(normalizeCodePathRef(ref), aliasMap))
      .filter((ref) => ref.length > 0),
  );
  if (contextTokens.size === 0 && fileRefSet.size === 0) return null;

  // 코퍼스 통계: 파일/심볼의 문서 빈도(IDF) — 카드별 정규화 결과를 재사용한다.
  const fileRefsByCard = new Map<string, string[]>();
  const symbolKeysByCard = new Map<string, string[]>();
  const fileDf = new Map<string, number>();
  const symbolDf = new Map<string, number>();
  for (const card of cards) {
    const files = asArray(card.files)
      .map((ref) => resolvePathAlias(normalizeCodePathRef(ref), aliasMap))
      .filter((ref) => ref.length > 0);
    const symbols = asArray(card.symbols).map(collapseKey).filter((key) => key.length > 0);
    fileRefsByCard.set(card.id, files);
    symbolKeysByCard.set(card.id, symbols);
    for (const ref of new Set(files)) fileDf.set(ref, (fileDf.get(ref) ?? 0) + 1);
    for (const key of new Set(symbols)) symbolDf.set(key, (symbolDf.get(key) ?? 0) + 1);
  }

  const propagation = propagateCoupledPatterns(
    cards.map((card) => ({ id: card.id, files: asArray(card.files), coupled: asArray(card.coupled) })),
    [...fileRefSet],
    { aliasMap },
  );
  return { contextTokens, contextCorpus, fileRefSet, fileRefsByCard, symbolKeysByCard, fileDf, symbolDf, propagation, aliasMap, corpusSize: cards.length };
}

/** 카드 1장 점수 + 근거 수집 — select는 근거를 버리고 explain은 그대로 반환한다(로직 단일 소스). */
function scoreKnowledgePatternCard(
  card: RelevanceCard,
  context: PreparedRelevanceContext,
): {
  score: number; via: string[]; tagMatches: string[]; bodyTokenMatches: string[];
  entities: KnowledgePatternEntityContribution[];
  requireMultiBody: KnowledgePatternScoreExplanation["requireMultiBody"];
} {
  // 기존 계약 유지: 본문 토큰 세트에 스코프태그(소문자)를 포함한다(태그 단어 토큰 중복 +1).
  const bodyTokens = new Set([
    ...normalizeKnowledgeTokens(`${card.title ?? ""} ${card.symptoms ?? ""} ${card.rootCause ?? ""}`),
    ...normalizeKnowledgeTokens(card.summary ?? ""),
    ...(card.scopeTags ?? []).map((tag) => tag.toLowerCase()),
  ]);
  let score = 0;
  const tagMatches: string[] = [];
  for (const tag of card.scopeTags ?? []) {
    if (context.contextTokens.has(tag.toLowerCase())) {
      score += TAG_MATCH_SCORE;
      tagMatches.push(tag);
    }
  }
  const bodyTokenMatches: string[] = [];
  for (const token of bodyTokens) {
    if (token.length >= 2 && context.contextTokens.has(token)) {
      score += 1;
      bodyTokenMatches.push(token);
    }
  }

  // 엔티티 영역(서명>심볼>파일>결합) — 동일 엔티티 다중 영역 히트는 최고 가중치 1회.
  const hits = new Map<string, EntityHit>();
  for (const signature of asArray(card.errorSignatures)) {
    const key = collapseKey(signature);
    if (key.length >= MIN_ENTITY_KEY_LENGTH && corpusHasEntityKey(key, context.contextCorpus, context.contextTokens)) {
      mergeHit(hits, `sig:${key}`, { weight: SIGNATURE_WEIGHT, boostable: false, strong: true, zone: "signature" });
    }
  }
  for (const symbol of context.symbolKeysByCard.get(card.id) ?? []) {
    if (symbol.length >= MIN_ENTITY_KEY_LENGTH && corpusHasEntityKey(symbol, context.contextCorpus, context.contextTokens)) {
      mergeHit(hits, `sym:${symbol}`, { weight: SYMBOL_WEIGHT, boostable: true, strong: true, zone: "symbol" });
    }
  }
  for (const ref of context.fileRefsByCard.get(card.id) ?? []) {
    if (context.fileRefSet.has(ref)) mergeHit(hits, `file:${ref}`, { weight: FILE_WEIGHT, boostable: true, strong: true, zone: "file" });
  }
  for (const ref of asArray(card.coupled)
    .map((raw) => resolvePathAlias(normalizeCodePathRef(raw), context.aliasMap))
    .filter((ref) => ref.length > 0)) {
    if (context.fileRefSet.has(ref)) mergeHit(hits, `file:${ref}`, { weight: COUPLED_WEIGHT, boostable: false, strong: false, zone: "coupled" });
  }

  // 1-hop 전파 병합: 엔티티별 직접 가중치와 전파 강도(×coupled 가중치)의 최댓값.
  // via는 전파 엣지가 직접 히트(files 3/coupled 1)에 엄밀히 뒤지지 않는 엔티티만 싣는다 —
  //   직접 히트가 더 강한 엔티티는 전파 기여가 0이라 라벨 오염만 한다.
  const via: string[] = [];
  const propagated = context.propagation.get(card.id);
  if (propagated) {
    for (const [entity, factor] of propagated.perEntity) {
      const weight = factor * COUPLED_WEIGHT;
      if (weight >= (hits.get(`file:${entity}`)?.weight ?? 0)) via.push(entity);
      mergeHit(hits, `file:${entity}`, { weight, boostable: false, strong: false, zone: "propagated" });
    }
  }

  let hasStrongEntity = false;
  const entities: KnowledgePatternEntityContribution[] = [];
  for (const [key, hit] of hits) {
    if (hit.strong) hasStrongEntity = true;
    const idf = hit.boostable
      ? key.startsWith("sym:")
        ? idfBoost(context.symbolDf.get(key.slice(4)) ?? 1, context.corpusSize)
        : idfBoost(context.fileDf.get(key.slice(5)) ?? 1, context.corpusSize)
      : 1;
    const contribution = hit.weight * idf;
    score += contribution;
    entities.push({ zone: hit.zone, entity: key.slice(key.indexOf(":") + 1), weight: hit.weight, idf, contribution });
  }
  entities.sort((left, right) => right.contribution - left.contribution);

  // requireMultiBody: 본문 토큰 1개만 겹치고 태그·강한 엔티티 근거가 없으면 우연 일치로 0점.
  const suppressed = bodyTokenMatches.length === 1 && tagMatches.length === 0 && !hasStrongEntity;
  if (suppressed) score = 0;
  return {
    score, via, tagMatches, bodyTokenMatches, entities,
    requireMultiBody: { bodyHits: bodyTokenMatches.length, tagHits: tagMatches.length, strongEntity: hasStrongEntity, suppressed },
  };
}

/** 결정론적 관련도: 스코프태그 직접命中 + 정규화 토큰 중복 + 구조화 엔티티 가중치 + 1-hop 전파. */
export function selectRelatedKnowledgePatterns(
  cards: readonly RelevanceCard[],
  contextTexts: readonly string[],
  limit: number = DEFAULT_RELEVANCE_SCORE_LIMIT,
  options: RelevanceOptions = {},
): RelatedKnowledgePattern[] {
  const context = prepareRelevanceContext(cards, contextTexts, options);
  if (!context) return [];
  return cards
    .map((card) => {
      const scored = scoreKnowledgePatternCard(card, context);
      const entry: RelatedKnowledgePattern = { id: card.id, title: card.title, score: scored.score };
      if (scored.via.length > 0 && scored.score > 0) entry.via = scored.via;
      return entry;
    })
    .filter((entry) => entry.score >= MIN_RELEVANCE_SCORE)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, limit));
}

/** [T3 explain] 랭킹과 동일 파이프라인의 카드별 점수 근거 — 임계 미달·억제 카드까지 모두
 *  점수 내림차순으로 반환한다("왜 안 떴는가" 진단이 목적이므로 잘라내지 않는다).
 *  읽기 전용 — select와 점수가 완전히 일치하도록 scoreKnowledgePatternCard를 공유한다. */
export function explainRelatedKnowledgePatterns(
  cards: readonly RelevanceCard[],
  contextTexts: readonly string[],
  options: RelevanceOptions = {},
): KnowledgePatternScoreExplanation[] {
  const context = prepareRelevanceContext(cards, contextTexts, options);
  if (!context) return [];
  return cards
    .map((card) => {
      const scored = scoreKnowledgePatternCard(card, context);
      const explanation: KnowledgePatternScoreExplanation = {
        id: card.id,
        title: card.title,
        score: scored.score,
        passesMinScore: scored.score >= MIN_RELEVANCE_SCORE,
        tagMatches: scored.tagMatches,
        bodyTokenMatches: scored.bodyTokenMatches,
        entities: scored.entities,
        requireMultiBody: scored.requireMultiBody,
      };
      if (scored.via.length > 0 && scored.score > 0) explanation.via = scored.via;
      return explanation;
    })
    .sort((left, right) => right.score - left.score);
}
