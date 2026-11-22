// server/src/services/knowledge-pattern-dedupe.ts
//
// [파일 목적] 지식 위키 미스톨로지 위생 — failure_mode 카드의 읽기 TTL 조건과
//   생성 시점 퍼지 중복 흡수(제목 Jaccard·오류 서명 교집합)를 제공한다.
//   - buildFailureModeTtlCondition: 기본 active 검색에서 maxDays보다 오래된
//     failure_mode만 제외한다 — 내구 constraint·success_recipe는 항상 통과.
//   - findFuzzyDuplicateActivePattern: create()에서 정확 서명 충돌(409) 뒤에 호출해
//     "거의 같은" 카드는 새 행 대신 기존 active 카드를 반환한다.
// [불변식]
//   - 정확한 defectSignature 중복은 evidence-gate의 assertNoDuplicateSignature가
//     그대로 409로 처리한다 — 이 모듈은 그 뒤의 흡수 경로이며 서명 계약을 바꾸지 않는다.
//   - 퍼지 후보는 같은 회사의 active·미대체 failure_mode만(최신 200행 창).
//   - 회사 스코프 필수(규칙 1) — 모든 조회는 같은 회사로 제한.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyKnowledgePatterns } from "@paperclipai/db";

/** failure_mode 읽기 TTL 기본값(일) — 명시 null이 아니면 기본 검색에 적용. */
export const DEFAULT_FAILURE_MODE_TTL_DAYS = 30;
/** 제목 퍼지 중복 임계 — Jaccard ≥ 이 값이면 동일 패턴 재제출로 본다. */
export const FUZZY_TITLE_JACCARD_THRESHOLD = 0.72;
/** 퍼지 후보 창 — 같은 회사의 최신 active failure_mode만 이 안에서 비교한다. */
const FUZZY_DEDUPE_CANDIDATE_LIMIT = 200;

type KnowledgePatternRow = typeof companyKnowledgePatterns.$inferSelect;

const UUID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DATE_TOKEN = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/g;
const LONG_HEX_TOKEN = /[0-9a-f]{7,}/g;
const NON_TOKEN = /[^\p{L}\p{N}]+/gu;

/** 제목을 퍼지 비교용 토큰 집합으로 정규화 — 소문자화하고 UUID·긴 hex ID·날짜를
 *  제거한 뒤 구두점을 공백으로 치환해 분할, 길이 1 이하 토큰은 버린다. 휘발성 ID가
 *  토큰으로 남아 같은 사고의 재제목을 갈라놓지 않게 한다. */
export function normalizeTitleTokens(title: string): Set<string> {
  const cleaned = title
    .toLowerCase()
    .replace(UUID_TOKEN, " ")
    .replace(DATE_TOKEN, " ")
    .replace(LONG_HEX_TOKEN, " ")
    .replace(NON_TOKEN, " ");
  return new Set(cleaned.split(/\s+/).filter((token) => token.length > 1));
}

/** 두 제목의 Jaccard 유사도 — |교집합|/|합집합| ∈ [0,1]. 어느 쪽이든 토큰이 없으면 0. */
export function titleJaccardSimilarity(a: string, b: string): number {
  const left = normalizeTitleTokens(a);
  const right = normalizeTitleTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/** failure_mode만 maxDays보다 오래된 행을 제외하는 읽기 TTL 조건 — 다른 kind는 항상 통과. */
export function buildFailureModeTtlCondition(maxDays: number) {
  return sql`(${companyKnowledgePatterns.kind} <> 'failure_mode' OR ${companyKnowledgePatterns.createdAt} >= NOW() - make_interval(days => ${maxDays}))`;
}

function normalizedSignatureSet(signatures: readonly string[]): Set<string> {
  return new Set(signatures.map((signature) => signature.trim()).filter((signature) => signature !== ""));
}

/** 생성 시점 퍼지 중복 — 같은 회사의 active·미대체 failure_mode(최신 200) 중
 *  오류 서명이 하나라도 겹치거나 제목 Jaccard가 임계 이상인 첫 카드를 돌려준다.
 *  failure_mode가 아닌 kind는 무조건 null — 호출부는 서명 409 단언 뒤에 둔다. */
export async function findFuzzyDuplicateActivePattern(
  tx: Pick<Db, "select">,
  input: {
    companyId: string;
    kind: string;
    title: string;
    errorSignatures: readonly string[];
  },
): Promise<KnowledgePatternRow | null> {
  if (input.kind !== "failure_mode") return null;
  const candidates = await tx
    .select()
    .from(companyKnowledgePatterns)
    .where(and(
      eq(companyKnowledgePatterns.companyId, input.companyId),
      eq(companyKnowledgePatterns.kind, "failure_mode"),
      // read.ts가 이 모듈의 TTL 조건을 import하므로 역방향 상수 import는 피한다(값 동일).
      eq(companyKnowledgePatterns.status, "active"),
      isNull(companyKnowledgePatterns.supersededById),
    ))
    .orderBy(desc(companyKnowledgePatterns.createdAt))
    .limit(FUZZY_DEDUPE_CANDIDATE_LIMIT);

  const inputSignatures = normalizedSignatureSet(input.errorSignatures);
  for (const row of candidates) {
    const rowSignatures = normalizedSignatureSet(row.errorSignatures);
    for (const signature of rowSignatures) {
      if (inputSignatures.has(signature)) return row;
    }
    if (titleJaccardSimilarity(row.title, input.title) >= FUZZY_TITLE_JACCARD_THRESHOLD) return row;
  }
  return null;
}
