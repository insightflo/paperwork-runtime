import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";

/** [owner-choice-card Stage 2] normal-flow choice 카드(`sourceContext.decisionKind === "choice"`)의
 *  표시 상태를 원본 decision 에서 순수하게 정규화한다. choice 페이로드(decisionKind·choiceOptions·
 *  decisionPoint·suggestedDecision·safeAutoAdvance·ttlMs·irreversible)는 스키마 워커가 채우는
 *  확장 필드라 shared 타입에 아직 없으므로, 여기서 런타임 방어 파싱(unknown → 검증된 뷰)으로만 읽는다.
 *  파싱 실패는 예외를 던지지 않고 안전한 기본값으로 내려가며, choice 가 아닌 카드는 항상 NOT_CHOICE 다. */

export interface OwnerChoiceOptionView {
  id: string;
  label: string;
  summary: string;
  recommended: boolean;
  irreversible: boolean;
}

export interface OwnerChoiceCardView {
  isChoiceCard: boolean;
  /** Korean decision-point label — 알려진 키가 아니면 null(표시 생략). */
  decisionPointLabel: string | null;
  choiceOptions: OwnerChoiceOptionView[];
  /** safeAutoAdvance && !irreversible && suggestedDecision 일 때만 한국어 안내 문구, 아니면 null. */
  autoAdvanceNotice: string | null;
  /** 옵션 클릭 시 기존 submit 흐름으로 제출할 action 의 id — 정의에서 결정할 수 없으면 null. */
  submitActionId: string | null;
}

const NOT_CHOICE: OwnerChoiceCardView = {
  isChoiceCard: false,
  decisionPointLabel: null,
  choiceOptions: [],
  autoAdvanceNotice: null,
  submitActionId: null,
};

const DECISION_POINT_LABELS: Record<string, string> = {
  topic_selection: "주제 선택",
  direction_choice: "방향 선택",
  budget_threshold: "예산 확인",
  publish_approval: "발행 승인",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseChoiceOption(raw: unknown): OwnerChoiceOptionView | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asString(record.id);
  if (!id) return null;
  return {
    id,
    label: asString(record.label) ?? id,
    summary: asString(record.summary) ?? "",
    recommended: record.recommended === true,
    irreversible: record.irreversible === true,
  };
}

/** choiceOptions 확장 필드가 비어 있으면 정의 옵션으로 최소 뷰를 만든다(표시는 유지, summary/irreversible 은 미확정). */
function optionsFromDefinition(decision: OperatorDecisionView): OwnerChoiceOptionView[] {
  return decision.definition.options.map((option) => ({
    id: option.id,
    label: option.label,
    summary: option.description ?? "",
    recommended: option.recommended === true,
    irreversible: false,
  }));
}

function formatAutoAdvanceNotice(ttlMs: unknown): string {
  const ttl = typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : null;
  const hours = ttl !== null ? Math.round(ttl / 3_600_000) : null;
  return hours !== null && hours > 0
    ? `${hours}시간 무응답 시 추천 선택지로 자동 진행 예정`
    : "무응답 시 추천 선택지로 자동 진행 예정";
}

/** 옵션 클릭 → resolve 에 쓸 action 선택: 선택을 요구하는 submit 액션을 우선하고, 없으면 submit, 그 다음 첫 액션. */
function chooseSubmitActionId(actions: OperatorDecisionView["definition"]["actions"]): string | null {
  const submitAction = actions.find((action) => action.outcome === "submit" && action.requiresSelection)
    ?? actions.find((action) => action.outcome === "submit")
    ?? actions[0];
  return submitAction?.id ?? null;
}

export function buildOwnerChoiceCardView(decision: OperatorDecisionView): OwnerChoiceCardView {
  const source = asRecord(decision.sourceContext);
  if (!source || source.decisionKind !== "choice") return NOT_CHOICE;

  const rawOptions = Array.isArray(source.choiceOptions) ? source.choiceOptions : null;
  const parsedOptions = rawOptions
    ? rawOptions.map(parseChoiceOption).filter((option): option is OwnerChoiceOptionView => option !== null)
    : [];
  const choiceOptions = parsedOptions.length > 0 ? parsedOptions : optionsFromDefinition(decision);

  const decisionPoint = asString(source.decisionPoint);
  const suggestedDecision = asString(source.suggestedDecision);
  // 자동 진행 대상 옵션이 되돌릴 수 없는 선택이면 카드 레벨 irreversible 과 동일하게 취급한다 —
  // 무응답 자동 진행이 비가역 행동을 대신 수행해서는 안 된다.
  const suggestedOption = suggestedDecision === null
    ? null
    : choiceOptions.find((option) => option.id === suggestedDecision) ?? null;
  const irreversible = source.irreversible === true || (suggestedOption?.irreversible ?? false);
  const autoAdvanceNotice = source.safeAutoAdvance === true && !irreversible && suggestedDecision !== null
    ? formatAutoAdvanceNotice(source.ttlMs)
    : null;

  return {
    isChoiceCard: true,
    decisionPointLabel: decisionPoint === null ? null : DECISION_POINT_LABELS[decisionPoint] ?? null,
    choiceOptions,
    autoAdvanceNotice,
    submitActionId: chooseSubmitActionId(decision.definition.actions),
  };
}
