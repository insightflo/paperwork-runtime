import { buildHistoricalQaSourceDefectCard } from "./qa-source-defect-card-historical.js";
import { runWithNodeFallback, WorkflowCoreContractError } from "./workflow-core-client.js";

/**
 * [목적] Stage 6B 서브커맨드(qa-defect-card-historical)의 Node 브리지.
 *   workflow-core-client.ts 의 runWithNodeFallback/게이트/warn-once 계약을 그대로 재사용한다.
 * [주의] Rust 팔은 카드 JSON 텍스트를 stdout 에 직접 출력한다 — UTF-16 slice 경계에서 갈라진
 *   서로게이트는 \uXXXX 이스케이프로 심겨 있어 JSON.parse 가 TS 문자열과 동일하게 복원한다.
 *   입력이 시맨틱하게 불량하면(비문자열 sort key, 비반복 findings/qaRefs) Rust 는 exit 1 로
 *   종료한다 — Unavailable 과 구분할 수 없으므로 TS fallback 이 같은 TypeError 를 다시 던진다
 *   (호출자는 어느 판정이든 동일 실패를 본다 — fallback 이 판정을 갈아끼우지 않는다).
 *   F4: 서브프로세스 스폰은 db.transaction 밖 async 호출자에서만 — 호출자가 보장한다.
 * [수정시 영향] 호출처: qa-source-defect-owner-card.ts(legacy 카드 replay 후보 buildHistorical).
 *   응답 shape 검증을 느슨히 하면 parity 를 깨뜨린 채 fallback 없이 흐른다.
 */

type HistoricalCardInput = Parameters<typeof buildHistoricalQaSourceDefectCard>[0];
type HistoricalCard = ReturnType<typeof buildHistoricalQaSourceDefectCard>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rust 우선 · Node fallback — qa-defect-card-historical 은 카드 전체를 JSON 으로 반환한다.
 *   응답이 카드 최소 shape 를 만족하지 못하면 계약 위반으로 조용히 TS 팔로 되돌아간다(warn-once).
 */
export function buildHistoricalQaSourceDefectCardWithNodeFallback(
  input: HistoricalCardInput,
): Promise<HistoricalCard> {
  return runWithNodeFallback({
    subcommand: "qa-defect-card-historical",
    payload: () => input,
    fallback: () => buildHistoricalQaSourceDefectCard(input),
    interpret: (response) => {
      const r = response as Record<string, unknown> | null;
      const definition = r?.definition;
      if (!isRecord(r)
        || r.schemaVersion !== 1
        || typeof r.requestKey !== "string"
        || r.priority !== "high"
        || r.interactionType !== "single_select"
        || typeof r.title !== "string"
        || typeof r.description !== "string"
        || r.sourceType !== "workflow_qa_rejection"
        || typeof r.sourceId !== "string"
        || !isRecord(r.sourceContext)
        || !isRecord(definition)
        || !Array.isArray(definition.options)
        || !isRecord(definition.humanReview)
        || (r.continuationMode !== "issue_current_assignee" && r.continuationMode !== "none")) {
        throw new WorkflowCoreContractError("workflow_core_qa_defect_card_bad_shape");
      }
      return r as unknown as HistoricalCard;
    },
  });
}
