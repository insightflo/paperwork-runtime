// server/src/services/knowledge-pattern-lifecycle.ts
//
// [파일 목적] 사고→패턴 지식 카드의 라이프사이클 모듈(T2a — mistology 흡수).
//   supersede 계보 보존(supersedeWithLineage)과 삭제 대신 은퇴(retire)를 제공한다.
//   supersedeWithLineage는 대체 발행 시 기존 카드의 whatWorked/pitfalls를 새 카드에
//   병합 보존하고 versionNumber(체인 깊이)+supersedeReason(대체 사유)를 기록해
//   폐기된 오답의 교훈이 사라지지 않게 한다. retire는 쓸모없어진 카드를 active/draft에서
//   retired로 전이한다(내용 불변·status+supersede_reason만) — superseded와 달리 체인 말단.
// [불변식]
//   - 회사 스코프 필수(규칙 1). 대체·은퇴 대상은 같은 회사 카드만.
//   - 쓰기 게이트는 create()와 동일 계열을 재사용한다(readTrimmed/readEvidence/readTags/
//     readEntities/assertEvidenceExists — 우회 금지, knowledge-patterns.ts 본체는
//     이 과업의 파일 범위 밖이라 수정·재export하지 않는다).
//   - supersede 원자성: 기존 카드 SELECT FOR UPDATE로 직렬화하고 superseded_by_id 갱신은
//     IS NULL 가드 UPDATE로 유지한다(0행 시 throw — PR #729 게이트와 동일 계약).
//   - pitfalls는 주입 브리핑의 '피할 오답' 표시 전용이며 랭킹 점수에 기여하지 않는다.
//   - retired는 체인 말단 — retired 카드를 supersede 대상으로 삼는 것을 거부한다.

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companyKnowledgePatterns } from "@paperclipai/db";
import {
  assertEvidenceExists,
  KINDS,
  KNOWLEDGE_PATTERN_STATUS_ACTIVE,
  KNOWLEDGE_PATTERN_STATUS_DRAFT,
  readEntities,
  readEvidence,
  readTags,
  readTrimmed,
  SUMMARY_MAX,
  TEXT_MAX,
  TITLE_MAX,
} from "./knowledge-pattern-read.js";
import type { KnowledgePattern } from "./knowledge-patterns.js";

export const KNOWLEDGE_PATTERN_STATUS_RETIRED = "retired";

// knowledge-patterns.ts의 SOURCES와 동일 목록 — 해당 파일은 이 과업의 파일 범위 밖이라
// export를 추가할 수 없어 같은 계약을 여기에 둔다(create()의 source 게이트와 동일 검증).
const SOURCES: readonly string[] = ["mission_owner_compile", "agent_candidate", "operator", "auto_rework_draft"];

const PITFALL_MAX_ITEMS = 20;
const PITFALL_MAX_LENGTH = 500;
const REASON_MAX = 500;

/** pitfalls 입력 판독 — readTags와 동일 계열: 문자열 배열, trim, 빈 값 제거, 중복 제거.
 *  계보 병합 시 기존 pitfalls와 합쳐지므로 입력 자체만 상한을 둔다(병합 결과는 무상한 —
 *  폐기된 교훈을 상한으로 버리면 라이프사이클의 존재 목적이 훼손된다). */
function readPitfalls(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > PITFALL_MAX_ITEMS) {
    throw new Error(`knowledge pattern pitfalls must be an array of at most ${PITFALL_MAX_ITEMS} items`);
  }
  const items = value.map((item) => {
    if (typeof item !== "string") throw new Error("knowledge pattern pitfalls entries must be strings");
    return item.trim().slice(0, PITFALL_MAX_LENGTH);
  }).filter((item) => item !== "");
  return Array.from(new Set(items));
}

/** supersede 계보 보존 대체 발행. 단일 트랜잭션에서 ① 기존 카드 SELECT FOR UPDATE
 *  ② 새 카드 삽입(기존 whatWorked/pitfalls + 새 입력 pitfalls 병합 보존, versionNumber =
 *  기존+1, supersedeReason 기록) ③ 기존 superseded_by_id 가드 갱신(0행 시 throw) 순서로
 *  원자 실행한다. reason은 새 카드의 supersedeReason에 기록돼 체인 추적 시
 *  "왜 이 버전이 만들어졌는지"가 계보에 남는다. */
export async function supersedeWithLineage(
  db: Db,
  input: {
    companyId: string;
    existingId: string;
    reason: unknown;
    next: {
      kind: unknown;
      title: unknown;
      summary: unknown;
      evidence?: unknown;
      symptoms?: unknown;
      rootCause?: unknown;
      whatWorked?: unknown;
      scopeTags?: unknown;
      files?: unknown;
      symbols?: unknown;
      coupled?: unknown;
      errorSignatures?: unknown;
      pitfalls?: unknown;
      source: unknown;
      createdByAgentId?: string | null;
    };
  },
): Promise<KnowledgePattern> {
  const reason = readTrimmed(input.reason, "reason", REASON_MAX, true)!;
  const next = input.next;
  const kind = String(next.kind ?? "");
  if (!KINDS.includes(kind)) throw new Error(`knowledge pattern kind must be one of ${KINDS.join(", ")}`);
  const source = String(next.source ?? "");
  if (!SOURCES.includes(source)) throw new Error(`knowledge pattern source must be one of ${SOURCES.join(", ")}`);
  const title = readTrimmed(next.title, "title", TITLE_MAX, true)!;
  const summary = readTrimmed(next.summary, "summary", SUMMARY_MAX, true)!;
  const evidence = readEvidence(next.evidence);
  const symptoms = readTrimmed(next.symptoms, "symptoms", TEXT_MAX, false);
  const rootCause = readTrimmed(next.rootCause, "rootCause", TEXT_MAX, false);
  const nextWhatWorked = readTrimmed(next.whatWorked, "whatWorked", TEXT_MAX, false);
  const scopeTags = readTags(next.scopeTags);
  const { files, symbols, coupled, errorSignatures } = readEntities(next);
  const nextPitfalls = readPitfalls(next.pitfalls);

  // [근거 실재성 게이트 — create()와 동일] 위조 근거가 즉시 active 카드가 되는 것을 차단.
  await assertEvidenceExists(db, evidence);

  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(companyKnowledgePatterns)
      .where(eq(companyKnowledgePatterns.id, input.existingId))
      .for("update")
      .limit(1);
    if (!existing || existing.companyId !== input.companyId) {
      throw new Error("knowledge pattern supersede target must exist in the same company");
    }
    if (existing.supersededById) {
      throw new Error("knowledge pattern supersede target is already superseded");
    }
    if (existing.status === KNOWLEDGE_PATTERN_STATUS_RETIRED) {
      throw new Error("knowledge pattern supersede target is retired (chain terminal)");
    }

    // 계보 롤업: 기존 pitfalls를 앞에 두고 새 입력을 뒤에 병합(순서 보존 중복 제거).
    // whatWorked는 새 입력이 있으면 그것을, 없으면 기존 값을 계승한다.
    const pitfalls = Array.from(new Set([...existing.pitfalls, ...nextPitfalls]));
    const whatWorked = nextWhatWorked ?? existing.whatWorked;

    const [created] = await tx
      .insert(companyKnowledgePatterns)
      .values({
        companyId: input.companyId,
        kind,
        title,
        summary,
        evidence,
        ...(symptoms ? { symptoms } : {}),
        ...(rootCause ? { rootCause } : {}),
        ...(whatWorked ? { whatWorked } : {}),
        scopeTags,
        files,
        symbols,
        coupled,
        errorSignatures,
        pitfalls,
        versionNumber: existing.versionNumber + 1,
        supersedeReason: reason,
        source,
        createdByAgentId: next.createdByAgentId ?? null,
        supersededById: null,
      })
      .returning();

    const linked = await tx
      .update(companyKnowledgePatterns)
      .set({ supersededById: created.id })
      .where(and(eq(companyKnowledgePatterns.id, input.existingId), isNull(companyKnowledgePatterns.supersededById)))
      .returning({ id: companyKnowledgePatterns.id });
    if (linked.length === 0) {
      throw new Error("knowledge pattern supersede target was superseded concurrently");
    }

    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: next.createdByAgentId ?? "knowledge-patterns",
      action: "knowledge_pattern.superseded",
      entityType: "knowledge_pattern",
      entityId: created.id,
      details: { kind, title, source, supersededId: input.existingId, versionNumber: created.versionNumber, reason },
    });
    return created;
  });
}

/** 은퇴 — active/draft 카드를 retired로 전이한다(삭제 대신 체인 말단으로 보존).
 *  이미 superseded이거나 retired인 카드, 다른 회사 카드는 거부한다 — 가드 UPDATE가
 *  0행을 반환하면 throw. supersedeReason에 은퇴 사유를 기록한다. */
export async function retire(
  db: Db,
  input: { companyId: string; id: string; reason: unknown },
): Promise<KnowledgePattern> {
  const reason = readTrimmed(input.reason, "reason", REASON_MAX, true)!;
  const [updated] = await db
    .update(companyKnowledgePatterns)
    .set({ status: KNOWLEDGE_PATTERN_STATUS_RETIRED, supersedeReason: reason })
    .where(and(
      eq(companyKnowledgePatterns.id, input.id),
      eq(companyKnowledgePatterns.companyId, input.companyId),
      isNull(companyKnowledgePatterns.supersededById),
      inArray(companyKnowledgePatterns.status, [KNOWLEDGE_PATTERN_STATUS_ACTIVE, KNOWLEDGE_PATTERN_STATUS_DRAFT]),
    ))
    .returning();
  if (!updated) {
    throw new Error("knowledge pattern cannot be retired (missing, belongs to another company, already superseded, or not active/draft)");
  }
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "knowledge-patterns",
    action: "knowledge_pattern.retired",
    entityType: "knowledge_pattern",
    entityId: updated.id,
    details: { kind: updated.kind, title: updated.title, reason },
  });
  return updated;
}
