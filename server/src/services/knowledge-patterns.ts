// server/src/services/knowledge-patterns.ts
//
// [파일 목적] 사고→패턴 지식 위키 서비스 — company_knowledge_patterns 테이블의
//   append-only 큐레이션 카드 생성/승인/큐레이션. 설계: artifacts doc/plans/2026-08-28-incident-pattern-knowledge-wiki.md
//   읽기 경로(검색·입력 판독기·근거 실재성 검증)는 knowledge-pattern-read.ts로 분리했다(T1c — 300줄 상한).
// [불변식]
//   - append-only: 내용(title/summary/evidence 등) 수정 API 없음. 대체는 supersedeId로 새 카드 발행
//     + 이전 카드 링크 갱신. 유일한 상태 전이는 approve(자동 초안 draft→active)뿐 — 내용 불변.
//   - 회사 스코프 필수(규칙 1). 검색/대체 대상은 같은 회사로 제한.
//   - 구조화 레코드만 권위(규칙 8) — evidence는 {type,id,note} 배열, 프로즈 파싱 없음.
//   - 생성 시 activity log 기록.
//   - [T1c] files/symbols/coupled/errorSignatures는 공유 Zod 계약으로 정규화해 저장한다.
// [게이트 보존 — PR #729] create는 (1) assertEvidenceExists(근거 실재 검증) 후
//   (2) db.transaction으로 삽입+supersede 가드 체인을 원자적으로 묶는다. 이 구조는 변경 금지.
//   [T2b] applyEvidenceGate(얕은 에이전트 → draft 강등)·assertNoDuplicateSignature(서명 중복 충돌) 추가.
// [소비] 미션 오너 진단/기획 검색, 자기개선 근거 참조. draft 초안은 검색 기본 제외(승인 전 무측).
//   실행 프롬프트 주입은 별도 계약(관련도+게이트+측정 롤아웃 — knowledge-pattern-injection)으로만.

import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companyKnowledgePatterns } from "@paperclipai/db";
import type { AdoptionAssetRegistryEntry } from "./self-improvement-adoption-planner.js";
import type { RelatedKnowledgePattern } from "./knowledge-pattern-relevance.js";
import {
  applyEvidenceGate,
  assertNoDuplicateSignature,
  DEFECT_SIGNATURE_MAX,
  findSimilarKnowledgePatternCards,
  isDuplicateSignaturePgError,
  KnowledgePatternDuplicateSignatureError,
} from "./knowledge-pattern-evidence-gate.js";
import {
  assertEvidenceExists,
  KINDS,
  KNOWLEDGE_PATTERN_STATUS_ACTIVE,
  KNOWLEDGE_PATTERN_STATUS_DRAFT,
  readEntities,
  readEvidence,
  readTags,
  readTrimmed,
  searchKnowledgePatterns,
  SUMMARY_MAX,
  TEXT_MAX,
  TITLE_MAX,
  type CreateKnowledgePatternInput,
  type KnowledgePatternSearchInput,
} from "./knowledge-pattern-read.js";

export type KnowledgePatternKind = "failure_mode" | "success_recipe" | "constraint";
export type KnowledgePatternSource = "mission_owner_compile" | "agent_candidate" | "operator" | "auto_rework_draft";
// 하위 호환 재수출 — 상수 정의는 read.ts(검색이 소유)로 이동했다.
export { KNOWLEDGE_PATTERN_STATUS_DRAFT, KNOWLEDGE_PATTERN_STATUS_ACTIVE } from "./knowledge-pattern-read.js";

const SOURCES: readonly string[] = ["mission_owner_compile", "agent_candidate", "operator", "auto_rework_draft"];

export type KnowledgePattern = typeof companyKnowledgePatterns.$inferSelect;

// [Phase 2 — 자기개선 연결] 검색된 패턴 카드를 adoption planner의 assetRegistry
//   엔트리(knowledge_pattern 자산)로 변환한다. 호출자는 회사 스코프 검색 결과만
//   넘겨야 한다(규칙 1) — 플래너는 레지스트리 등재 여부로 참조 해석을 판정한다.
export function knowledgePatternAdoptionRegistryEntries(
  cards: Array<Pick<KnowledgePattern, "id">>,
): AdoptionAssetRegistryEntry[] {
  return cards.map((card) => ({ assetType: "knowledge_pattern", assetRef: card.id, resolvedRef: card.id }));
}

async function logPatternActivity(
  writer: Pick<Db, "insert">,
  input: { companyId: string; actorId?: string | null; action: string; entityId: string; details: Record<string, unknown> },
): Promise<void> {
  await writer.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: input.actorId ?? "knowledge-patterns",
    action: input.action,
    entityType: "knowledge_pattern",
    entityId: input.entityId,
    details: input.details,
  });
}

export function knowledgePatternsService(db: Db) {
  return {
    /** [중복 힌트 — EvoHarness] 유사 기존 카드 비차단 힌트 — 구현은 evidence-gate.ts(T2b 통합). */
    findSimilar: (input: Parameters<typeof findSimilarKnowledgePatternCards>[1]): Promise<RelatedKnowledgePattern[]> =>
      findSimilarKnowledgePatternCards(db, input),
    /** append-only 생성. supersedeId가 있으면 같은 회사의 기존 카드를 대체 체인으로 연결한다.
     *  [T1c] files/symbols/coupled/errorSignatures를 공유 Zod로 정규화해 저장(누락 시 빈 배열). */
    create: async (input: CreateKnowledgePatternInput): Promise<KnowledgePattern> => {
      const kind = String(input.kind ?? "");
      if (!KINDS.includes(kind)) throw new Error(`knowledge pattern kind must be one of ${KINDS.join(", ")}`);
      const source = String(input.source ?? "");
      if (!SOURCES.includes(source)) throw new Error(`knowledge pattern source must be one of ${SOURCES.join(", ")}`);
      const title = readTrimmed(input.title, "title", TITLE_MAX, true)!;
      const summary = readTrimmed(input.summary, "summary", SUMMARY_MAX, true)!;
      const evidence = readEvidence(input.evidence);
      const symptoms = readTrimmed(input.symptoms, "symptoms", TEXT_MAX, false);
      const rootCause = readTrimmed(input.rootCause, "rootCause", TEXT_MAX, false);
      const whatWorked = readTrimmed(input.whatWorked, "whatWorked", TEXT_MAX, false);
      const scopeTags = readTags(input.scopeTags);
      const { files, symbols, coupled, errorSignatures } = readEntities(input);
      const defectSignature = readTrimmed(input.defectSignature, "defectSignature", DEFECT_SIGNATURE_MAX, false);
      // [T2b 쓰기 게이트] 얕은 에이전트 제출은 거부 대신 draft 강등 — status만 변경, 데이터 불변.
      const status = applyEvidenceGate({ evidence, rootCause, whatWorked }, source);

      // [근거 실재성 ⓑ] 위조·타회사 근거가 즉시 active 카드가 되는 것을 쓰기 시점에 차단한다.
      await assertEvidenceExists(db, evidence, input.companyId);

      // [supersede 원자성 ⓐ] 삽입+체인 연결을 단일 트랜잭션으로 묶고, 가드 UPDATE가
      // 0행이면(동시 대체 패배) 롤백한다 — 패배 쪽 고아 active 카드 잔존을 원천 차단.
      const card = await db.transaction(async (tx) => {
        if (input.supersedeId) {
          const [existing] = await tx
            .select({ id: companyKnowledgePatterns.id, companyId: companyKnowledgePatterns.companyId, supersededById: companyKnowledgePatterns.supersededById, status: companyKnowledgePatterns.status })
            .from(companyKnowledgePatterns)
            .where(eq(companyKnowledgePatterns.id, input.supersedeId))
            .for("update")
            .limit(1);
          if (!existing || existing.companyId !== input.companyId) {
            throw new Error("knowledge pattern supersede target must exist in the same company");
          }
          if (existing.supersededById) {
            throw new Error("knowledge pattern supersede target is already superseded");
          }
          if (existing.status === "retired") {
            throw new Error("knowledge pattern supersede target is retired (chain terminal)");
          }
        }

        // [T2b 서명 중복 — 명시 충돌] 사람·에이전트 제출은 onConflictDoNothing 대신 409 신호.
        if (defectSignature) await assertNoDuplicateSignature(tx, { companyId: input.companyId, defectSignature });

        let created: KnowledgePattern;
        try {
          [created] = await tx
            .insert(companyKnowledgePatterns)
            .values({
              companyId: input.companyId, kind, title, summary, evidence,
              ...(symptoms ? { symptoms } : {}),
              ...(rootCause ? { rootCause } : {}),
              ...(whatWorked ? { whatWorked } : {}),
              scopeTags, files, symbols, coupled, errorSignatures,
              source, status, defectSignature,
              createdByAgentId: input.createdByAgentId ?? null,
              supersededById: null,
            })
            .returning();
        } catch (error) {
          if (isDuplicateSignaturePgError(error)) {
            throw new KnowledgePatternDuplicateSignatureError(null);
          }
          throw error;
        }

        if (input.supersedeId) {
          const linked = await tx
            .update(companyKnowledgePatterns)
            .set({ supersededById: created.id })
            .where(and(
              eq(companyKnowledgePatterns.id, input.supersedeId),
              isNull(companyKnowledgePatterns.supersededById),
              ne(companyKnowledgePatterns.status, "retired"),
            ))
            .returning({ id: companyKnowledgePatterns.id });
          if (linked.length === 0) {
            throw new Error("knowledge pattern supersede target was superseded concurrently");
          }
        }

        await logPatternActivity(tx, {
          companyId: input.companyId,
          actorId: input.createdByAgentId,
          action: "knowledge_pattern.created",
          entityId: created.id,
          details: { kind, title, source, status, supersededId: input.supersedeId ?? null },
        });
        return created;
      });
      return card;
    },

    /** [P1 자동 초안 — 반복 QA 기계 교정] 동일 결함 서명 반복 감지 시 failure_mode 초안 카드 생성.
     *  append-only 유지: 초안은 새 insert이고 유일한 상태 전이는 approve(draft→active)뿐이다.
     *  (company_id, defect_signature) 부분 유일 인덱스로 중복 초안 방지 — 충돌 시 {card: null}.
     *  초안은 검색/주입 기본 제외(status='draft')라 승인 전까지 소비 면에서 무측. */
    createAutoReworkDraft: async (input: {
      companyId: string;
      signature: string;
      title: string;
      summary: string;
      symptoms?: string | null;
      whatWorked?: string | null;
      evidence?: Array<Record<string, unknown>>;
    }): Promise<{ card: KnowledgePattern | null }> => {
      const signature = input.signature.trim();
      if (!signature) throw new Error("knowledge pattern auto draft requires a defect signature");
      const title = readTrimmed(input.title, "title", TITLE_MAX, true)!;
      const summary = readTrimmed(input.summary, "summary", SUMMARY_MAX, true)!;
      const evidence = readEvidence(input.evidence);
      const symptoms = readTrimmed(input.symptoms, "symptoms", TEXT_MAX, false);
      const whatWorked = readTrimmed(input.whatWorked, "whatWorked", TEXT_MAX, false);

      const [card] = await db
        .insert(companyKnowledgePatterns)
        .values({
          companyId: input.companyId,
          kind: "failure_mode",
          title,
          summary,
          evidence,
          ...(symptoms ? { symptoms } : {}),
          whatWorked: whatWorked ?? null,
          scopeTags: ["qa-remediation"],
          source: "auto_rework_draft",
          defectSignature: signature,
          status: KNOWLEDGE_PATTERN_STATUS_DRAFT,
        })
        .onConflictDoNothing()
        .returning();

      if (!card) return { card: null };
      await logPatternActivity(db, {
        companyId: input.companyId,
        action: "knowledge_pattern.auto_draft",
        entityId: card.id,
        details: { kind: "failure_mode", title, source: "auto_rework_draft", defectSignature: signature },
      });
      return { card };
    },

    /** [P1 승인 + P2 주입 큐레이션] 자동 초안 draft→active 전이. 유일하게 허용된 status 변경이며
     *  카드 내용은 불변. audience는 사람이 승인 시에만 'agent'로 지정 가능(기본 'ops' 유지 =
     *  주입 없음). fail-closed — 주입은 명시적 사람 선택일 때만 열린다. */
    approve: async (input: {
      companyId: string;
      id: string;
      /** 승인과 동시에 주입 대상으로 큐레이션('agent'). 미지정 시 'ops'(주입 없음). */
      audience?: string | null;
    }): Promise<KnowledgePattern> => {
      const audience = input.audience == null || input.audience === "" ? null : String(input.audience);
      if (audience != null && audience !== "agent" && audience !== "ops") {
        throw new Error("knowledge pattern audience must be 'agent' or 'ops'");
      }
      const [updated] = await db
        .update(companyKnowledgePatterns)
        .set({
          status: KNOWLEDGE_PATTERN_STATUS_ACTIVE,
          ...(audience ? { audience } : {}),
        })
        .where(and(
          eq(companyKnowledgePatterns.id, input.id),
          eq(companyKnowledgePatterns.companyId, input.companyId),
          eq(companyKnowledgePatterns.status, KNOWLEDGE_PATTERN_STATUS_DRAFT),
        ))
        .returning();
      if (!updated) {
        throw new Error("knowledge pattern draft not found (already active or belongs to another company)");
      }
      await logPatternActivity(db, {
        companyId: input.companyId,
        action: "knowledge_pattern.approved",
        entityId: updated.id,
        details: { source: updated.source, defectSignature: updated.defectSignature, audience: updated.audience },
      });
      return updated;
    },

    /** [P2 주입 큐레이션] 사람(보드)이 카드의 audience를 지정한다 — 내용 불변, 주입 자격 플래그만 변경.
     *  draft/active 모두 가능(승인 전 주입 예약 포함). 기본 'ops' = 주입 없음(fail-closed). */
    curateAudience: async (input: { companyId: string; id: string; audience: string }): Promise<KnowledgePattern> => {
      if (input.audience !== "agent" && input.audience !== "ops") {
        throw new Error("knowledge pattern audience must be 'agent' or 'ops'");
      }
      const [updated] = await db
        .update(companyKnowledgePatterns)
        .set({ audience: input.audience })
        .where(and(eq(companyKnowledgePatterns.id, input.id), eq(companyKnowledgePatterns.companyId, input.companyId)))
        .returning();
      if (!updated) {
        throw new Error("knowledge pattern not found (belongs to another company)");
      }
      await logPatternActivity(db, {
        companyId: input.companyId,
        action: "knowledge_pattern.audience_curated",
        entityId: updated.id,
        details: { audience: updated.audience, status: updated.status },
      });
      return updated;
    },

    /** 검색(실제 구현은 knowledge-pattern-read.ts) — q·엔티티 질의 시 관련도 재정렬(T1c). */
    search: (input: KnowledgePatternSearchInput): Promise<KnowledgePattern[]> => searchKnowledgePatterns(db, input),
  };
}
