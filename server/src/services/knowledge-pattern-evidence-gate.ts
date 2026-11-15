// server/src/services/knowledge-pattern-evidence-gate.ts
//
// [파일 목적] 지식 패턴 카드 쓰기 게이트(T2b — mistology 후보③⑤ 흡수) — create()가
//   호출하는 입구 품질 장치 2종과, 같은 "중복 방지" 계열의 유사 카드 비차단 힌트를 모은다.
//   - applyEvidenceGate: 에이전트 계열 제출이 근거·분석 모두 얕으면 거부 대신 status='draft'
//     로 강등한다 — 자동 초안(createAutoReworkDraft)과 같은 철학(승인 전 검색·주입 무측).
//     사람(operator) 제출은 어떤 내용이든 강등 없이 통과한다(게이트가 사람을 막는 설정 금지).
//   - assertNoDuplicateSignature: 동일 회사에 같은 defectSignature 카드가 이미 있으면
//     명시적 충돌을 던진다 — auto_rework_draft의 onConflictDoNothing(조용한 멱등)과 대비해
//     사람·에이전트 제출은 "이미 있으니 supersede하라"는 신호를 돌려준다.
//   - findSimilarKnowledgePatternCards: 등록 전 상위 유사 카드 비차단 힌트(기존
//     knowledge-patterns.ts의 findSimilar 로직 이동 — 서명 단언과 같은 중복 방지 계열).
// [불변식]
//   - 강등은 status 필드만 바꾼다 — 게이트를 통과한 나머지 입력 데이터는 불변.
//   - 서명 중복 체크는 create() 트랜잭션 안에서만 호출한다(삽입과 원자 직렬화).
//   - 서명 조회는 status 무관 전체 행을 본다 — (company_id, defect_signature) 부분 유일
//     인덱스가 non-null 전체를 잠그므로 draft/retired 잔존 서명까지 잡아야 충돌이 500이
//     아니라 의도된 오류로 보고된다.
//   - 회사 스코프 필수(규칙 1) — 모든 조회는 같은 회사로 제한.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyKnowledgePatterns } from "@paperclipai/db";
import {
  KNOWLEDGE_PATTERN_STATUS_ACTIVE,
  KNOWLEDGE_PATTERN_STATUS_DRAFT,
  searchKnowledgePatterns,
} from "./knowledge-pattern-read.js";
import { selectRelatedKnowledgePatterns, type RelatedKnowledgePattern } from "./knowledge-pattern-relevance.js";

/** defectSignature 상한 — QA 기계 서명은 sha256 hex(64자)라 여유 상한. */
export const DEFECT_SIGNATURE_MAX = 200;
export const KNOWLEDGE_PATTERN_SIGNATURE_UNIQUE_INDEX = "company_knowledge_patterns_company_signature_uq";

/** 카드 출처 열거의 단일 원본 — create() 입력 게이트·라우트 Zod 검증·lifecycle의
 *  supersede 입력 게이트가 같은 목록을 봐야 drift하지 않는다(세 곳 복제에서 통합).
 *  services/knowledge-patterns.ts의 private 사본은 과업 파일 범위 밖이라 남는다 — 이
 *  상수와 같은 리터럴을 유지하는 게 계약이다(어긋나면 라우트 통과 입력이 서비스에서 거부). */
export const SOURCES = ["mission_owner_compile", "agent_candidate", "operator", "auto_rework_draft"] as const;

/** explain 라우트가 요청하는 검색 상한 — searchKnowledgePatterns의 limit 캡(read.ts)과
 *  동일 값. 진단이 가시 집합 전체를 대상으로 하므로 허용 최대치를 명시 상수로 둔다. */
export const KNOWLEDGE_PATTERN_SEARCH_LIMIT_MAX = 200;

/** 동일 회사의 defect_signature 중복 충돌 — 사전 조회와 INSERT 23505 경합 모두 이 타입으로 수렴(409). */
export class KnowledgePatternDuplicateSignatureError extends Error {
  readonly existingCardId: string | null;

  constructor(existingCardId: string | null, status?: string | null) {
    const location = existingCardId
      ? `on card ${existingCardId}${status ? ` (status=${status})` : ""}`
      : "on an existing card";
    super(`knowledge pattern defect signature already registered ${location}; supersede does not free the signature slot (the chain head keeps it) — submit a different defectSignature or omit it`);
    this.name = "KnowledgePatternDuplicateSignatureError";
    this.existingCardId = existingCardId;
  }
}

/** Postgres unique_violation(23505) 중 defect_signature 부분 유일 인덱스 충돌인지 판별(Drizzle cause 체인 포함). */
export function isDuplicateSignaturePgError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    const candidate = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; cause?: unknown };
    const constraint = candidate.constraint ?? candidate.constraint_name;
    if (candidate.code === "23505" && constraint === KNOWLEDGE_PATTERN_SIGNATURE_UNIQUE_INDEX) return true;
    current = candidate.cause;
  }
  return false;
}

// 기계 출처 — 게이트가 강등을 적용하는 source 집합. create()는 SOURCES 열거로 먼저 검증하므로
//   이 집합 밖(현재 operator뿐)은 항상 무강등 통과 = 사람 제출 차단 금지 계약.
const AGENT_SOURCES: ReadonlySet<string> = new Set(["mission_owner_compile", "agent_candidate", "auto_rework_draft"]);

export type EvidenceGateInput = {
  /** readEvidence()를 통과한 구조화 근거 — 0건이면 미달. */
  evidence: readonly Record<string, unknown>[];
  rootCause: string | null;
  whatWorked: string | null;
};

/** 에이전트 제출 강등 판정 — 근거가 비었거나 rootCause·whatWorked 둘 다 없으면 draft.
 *  통과/강등 외에 데이터를 바꾸지 않는다(status만). */
export function applyEvidenceGate(input: EvidenceGateInput, source: string): string {
  if (!AGENT_SOURCES.has(source)) return KNOWLEDGE_PATTERN_STATUS_ACTIVE;
  const hasAnalysis = input.rootCause != null || input.whatWorked != null;
  return input.evidence.length === 0 || !hasAnalysis
    ? KNOWLEDGE_PATTERN_STATUS_DRAFT
    : KNOWLEDGE_PATTERN_STATUS_ACTIVE;
}

/** 서명 중복 단언 — create() 트랜잭션 안에서 호출. 같은 회사에 동일 defectSignature를
 *  가진 카드가 어떤 status로든 남아 있으면 명시적 충돌 오류를 던진다(라우트가 409로 매핑).
 *  검색 대상을 status 무관으로 넓힌 이유는 파일 상단 불변식 참조 — 유일 인덱스의 잠금 범위와
 *  일치시켜 위반 경로가 500으로 새지 않게 한다. */
export async function assertNoDuplicateSignature(
  tx: Pick<Db, "select">,
  input: { companyId: string; defectSignature: string },
): Promise<void> {
  const [existing] = await tx
    .select({ id: companyKnowledgePatterns.id, status: companyKnowledgePatterns.status })
    .from(companyKnowledgePatterns)
    .where(and(
      eq(companyKnowledgePatterns.companyId, input.companyId),
      eq(companyKnowledgePatterns.defectSignature, input.defectSignature),
    ))
    .limit(1);
  if (existing) {
    throw new KnowledgePatternDuplicateSignatureError(existing.id, existing.status);
  }
}

/** [중복 힌트 — EvoHarness compaction 교훈] 새 카드와 유사한 기존 카드 상위 3건.
 *  supersede 대상 후보 제안용 비차단 힌트(superseded 제외 풀에서 스코프태그+토큰 중복).
 *  knowledge-patterns.ts의 findSimilar에서 이동 — 서명 단언과 같은 중복 방지 계열로 묶는다. */
export async function findSimilarKnowledgePatternCards(
  db: Db,
  input: {
    companyId: string;
    title: string;
    symptoms?: string | null;
    rootCause?: string | null;
    scopeTags?: readonly string[];
  },
): Promise<RelatedKnowledgePattern[]> {
  const cards = await searchKnowledgePatterns(db, { companyId: input.companyId, limit: 50 });
  return selectRelatedKnowledgePatterns(
    cards,
    [input.title, input.symptoms ?? "", input.rootCause ?? "", ...(input.scopeTags ?? [])],
  );
}
// [게이트와 실재성 검증의 관계] 강등된 draft라도 근거가 있으면 assertEvidenceExists의 실재성
//   검증은 동일하게 적용된다 — 호출은 create()/supersedeWithLineage()에 남고 이 모듈은
//   status 판정과 서명 단언만 담당한다.
