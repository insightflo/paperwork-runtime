import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import type {
  OperatorDecisionAction,
  OperatorDecisionView,
} from "@paperclipai/shared/types/operator-decision";
import type { ResolveOperatorDecisionInput } from "../api/operator-decisions";
import { timeAgo } from "../lib/timeAgo";
import { buildOwnerChoiceCardView } from "../lib/owner-choice-card-view";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  HumanReviewPacket,
  HumanReviewEvidenceChips,
  HumanReviewInterpretationBlock,
  HumanReviewSymptomBlock,
  COMPACT_INTERPRETATION_FALLBACK,
  formatCompactInterpretation,
  hasCompactSymptom,
} from "./HumanReviewPacket";
import { OperatorDecisionOptions } from "./OperatorDecisionOptions";
import { CardHumanSummary } from "./CardHumanSummary";
import { operatorDecisionsApi } from "../api/operator-decisions";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { humanLabel } from "../lib/humanLabels";
import { commonDecisionFacts, OperatorDecisionFacts } from "./OperatorDecisionFacts";

/** 서버(mission-owner-human-input-card)가 nextAction 없을 때 채우는 recommendedNextStep 기본 폴백 문구. */
const NEXT_STEP_FALLBACK = "이슈 본문의 요청 근거를 확인한 뒤 승인·보류·반려 중 하나를 선택해 주세요.";
/** 서버 기본 승인 옵션의 고정 설명 — 신형 축소 카드에서 다음 단계 1줄 요약으로 표시만 교체한다. */
const SERVER_APPROVE_DESCRIPTION = "요청된 다음 단계를 승인합니다";

interface OperatorDecisionCardProps {
  decision: OperatorDecisionView;
  onResolve: (decisionId: string, input: ResolveOperatorDecisionInput) => Promise<unknown>;
}

function toneClass(tone: OperatorDecisionAction["tone"]) {
  if (tone === "danger") return "border-destructive/60 bg-destructive/5 text-destructive shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] hover:bg-destructive/10 dark:border-red-400/40 dark:bg-red-500/10 dark:text-red-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-red-500/15";
  if (tone === "primary") return "border-[#4d7c0f] bg-[#4d7c0f] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] hover:bg-[#3f6212] dark:border-[#a3e635]/50 dark:bg-[#a3e635] dark:text-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.34)] dark:hover:bg-[#bef264]";
  return "border-slate-200/90 bg-white text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-white/20 dark:hover:bg-[#111827]";
}

function sourceLabel(decision: OperatorDecisionView, lang: ReturnType<typeof useCompanyLanguage>) {
  if (!decision.requestedBy) return L(lang, { en: "System", ko: "시스템" });
  return `${decision.requestedBy.type === "agent" ? L(lang, { en: "Agent", ko: "에이전트" }) : L(lang, { en: "Board", ko: "운영자" })} ${decision.requestedBy.id.slice(0, 8)}`;
}

export function OperatorDecisionCard({ decision, onResolve }: OperatorDecisionCardProps) {
  const lang = useCompanyLanguage();
  const commonFacts = commonDecisionFacts(decision.definition.options);
  const subject = decision.definition.humanReview?.decisionSubject ?? decision.title;
  // [사람 카드 축소 Stage 4] symptom 이 있는 신형 패킷은 고정 축소 레이아웃(증상 → 선택지 → 쉬운 해석 → 근거 링크·액션)으로
  // 정렬한다. 선택·코멘트·resolve 제출 동작은 그대로 유지하고, 구형 카드는 기존 배치를 100% 보존한다.
  const compactCard = hasCompactSymptom(decision.definition.humanReview);
  // [owner-choice-card] normal-flow choice 카드의 표시 상태를 순수 헬퍼로 정규화한다.
  // choice 가 아닌(복구·축소·구형) 카드는 모두 isChoiceCard:false — 기존 경로에 영향이 없다.
  const choiceCard = buildOwnerChoiceCardView(decision);
  const choiceResolveAction = choiceCard.submitActionId === null
    ? null
    : decision.definition.actions.find((action) => action.id === choiceCard.submitActionId) ?? null;
  const choiceOptionsShown = choiceCard.isChoiceCard && choiceCard.choiceOptions.length > 0;
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submittingActionId, setSubmittingActionId] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const descriptionId = `operator-decision-${decision.id}-description`;
  const errorId = `operator-decision-${decision.id}-error`;
  const commentId = `operator-decision-${decision.id}-comment`;
  const optionGroups = decision.definition.optionGroups ?? null;
  const groupOf = (optionId: string) =>
    optionGroups?.find((group) => group.optionIds.includes(optionId)) ?? null;

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  // [사람 카드 UI 중복 정리] 신형 축소 카드에서 서버 기본 승인 설명을 다음 단계 1줄 요약으로만
  // 바꿔 표시한다(선택 문구는 '선택지' 영역에 1회). 표시 전용 사본이며 옵션 id·선택 상태·
  // onResolve 제출 값은 원본 decision 그대로다(영문·커스텀 description 옵션은 건드리지 않는다).
  const firstOption = decision.definition.options[0] ?? null;
  const nextStepOneLine = decision.definition.humanReview
    ? decision.definition.humanReview.recommendedNextStep.replace(/\s+/g, " ").trim()
    : "";
  const useNextStepDescription = compactCard
    && firstOption !== null
    && firstOption.id === "approve"
    && firstOption.description === SERVER_APPROVE_DESCRIPTION
    && nextStepOneLine.length > 0
    && nextStepOneLine !== NEXT_STEP_FALLBACK;
  const optionsDecision: OperatorDecisionView = useNextStepDescription
    ? {
        ...decision,
        definition: {
          ...decision.definition,
          options: decision.definition.options.map((option) =>
            option.id === "approve" ? { ...option, description: `요청된 다음 단계: ${nextStepOneLine}` } : option),
        },
      }
    : decision;

  // [카드 UX 핫픽스 ③ 2026-11-13] 승인/보류/반려 '형식 옵션'은 아래 액션 버튼과 같은 의미를
  //   두 번 표시한 것이다 — 실제 행동 옵션(재시작·재시도·재계획 등)과 같은 목록에 섞이면
  //   선택지가 겹쳐 보인다. 형식 옵션이 2개 이상이고 실제 옵션이 남아 있는 카드에서는
  //   주 선택지에 실제 옵션만 표시하고, 형식 옵션은 액션 버튼 누를 때 서버 계약이 요구하는
  //   선택지로 자동 매핑해 제출한다(와이어 result 형태는 구 계약과 동일).
  const FORMAT_OUTCOMES = new Set(["approve", "hold", "reject"]);
  const formatOptionIds = new Set(
    decision.definition.actions
      .filter((action) => FORMAT_OUTCOMES.has(action.outcome))
      .map((action) => action.id)
      .filter((id) => decision.definition.options.some((option) => option.id === id)),
  );
  const realOptions = optionsDecision.definition.options.filter((option) => !formatOptionIds.has(option.id));
  const hideFormatOptions = !optionGroups
    && decision.interactionType === "single_select"
    && formatOptionIds.size >= 2
    && realOptions.length > 0;
  const visibleOptionsDecision: OperatorDecisionView = hideFormatOptions
    ? { ...optionsDecision, definition: { ...optionsDecision.definition, options: realOptions } }
    : optionsDecision;

  /** 주 선택지에서 숨긴 형식 옵션을 액션 제출값으로 복원한다 — 예: 보류 버튼은 ['보류' 옵션]
   *  을 자동 선택한 것과 동일한 result 를 만든다. 실제 옵션이 선택돼 있으면 그 선택을 유지한다. */
  function effectiveSelectionFor(action: OperatorDecisionAction): string[] {
    if (!action.requiresSelection || !hideFormatOptions) return selectedOptionIds;
    const realSelected = selectedOptionIds.filter((id) => !formatOptionIds.has(id));
    if (realSelected.length > 0) return realSelected;
    return formatOptionIds.has(action.id) ? [action.id] : selectedOptionIds;
  }

  function toggleOption(id: string) {
    setError(null);
    const group = groupOf(id);
    const groupSingle = group !== null && group.selection !== null && group.selection.max === 1;
    if (decision.interactionType === "single_select" || groupSingle) {
      // 이 옵션이 속한 그룹(max=1)에서는 그 그룹 선택을 이 옵션으로 교체한다.
      // [root cause 2026-10-20] single_select 필터 방향이 뒤집혀 있어 이전 선택이 삭제되지 않고 누적됐다
      // (두 번째 클릭 후 상태가 [A,B]가 되어 max=1 초과 → “선택지를 1개 선택하세요”로 거부,
      // 네이티브 라디오는 React가 A를 다시 체크해 표시가 되돌아가 클릭 무시처럼 보였다).
      // single_select에서는 이전 선택 전부를 버리고 [id]로 교체한다.
      setSelectedOptionIds((current) => [
        ...current.filter((candidate) => {
          const candidateGroup = groupOf(candidate);
          return groupSingle
            ? candidateGroup?.id !== group?.id
            : decision.interactionType !== "single_select";
        }),
        id,
      ]);
      return;
    }
    setSelectedOptionIds((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : [...current, id]);
  }

  // [owner-choice-card] choice 카드는 옵션 클릭 한 번으로 resolve 한다 — 검증·제출·오류 표시를 포함한
  // 기존 submit 흐름을 그대로 재사용하며 선택값만 옵션 하나로 확정한다(새 API 없음).
  function chooseChoiceOption(optionId: string) {
    if (choiceResolveAction === null) return;
    setError(null);
    void submit(choiceResolveAction, [optionId]);
  }

  function localError(action: OperatorDecisionAction, overrideSelection?: string[]): string | null {
    if (action.requiresSelection) {
      const bounds = decision.definition.selection;
      if (!bounds) return L(lang, { en: "This action cannot accept a selection.", ko: "이 조치는 선택지를 받을 수 없습니다." });
      // 그룹별 안내를 먼저 — 무엇을 더 골라야 하는지 구체적이다.
      for (const group of optionGroups ?? []) {
        if (!group.selection) continue;
        const groupSelected = selectedOptionIds.filter((id) => group.optionIds.includes(id)).length;
        if (groupSelected < group.selection.min || groupSelected > group.selection.max) {
          const want = group.selection.min === group.selection.max
            ? `${group.selection.min}`
            : `${group.selection.min}~${group.selection.max}`;
          return L(lang, { en: `${group.label ?? group.id}: Select ${want} option(s).`, ko: `${group.label ?? group.id}: ${want}개를 선택하세요.` });
        }
      }
      const selection = overrideSelection ?? effectiveSelectionFor(action);
      if (selection.length < bounds.min || selection.length > bounds.max) {
        return bounds.min === bounds.max
          ? L(lang, { en: `Select ${bounds.min} option${bounds.min === 1 ? "" : "s"}.`, ko: `선택지를 ${bounds.min}개 선택하세요.` })
          : L(lang, { en: `Select between ${bounds.min} and ${bounds.max} options.`, ko: `선택지를 ${bounds.min}~${bounds.max}개 선택하세요.` });
      }
    }
    const trimmed = comment.trim();
    if (decision.definition.comment.mode === "required" && !trimmed) return L(lang, { en: "A comment is required.", ko: "메모를 입력해야 합니다." });
    if (trimmed.length > decision.definition.comment.maxLength) {
      return L(lang, { en: `Comment must be ${decision.definition.comment.maxLength} characters or fewer.`, ko: `메모는 ${decision.definition.comment.maxLength}자 이하여야 합니다.` });
    }
    return null;
  }

  async function submit(action: OperatorDecisionAction, overrideSelection?: string[]) {
    const validationError = localError(action, overrideSelection);
    if (validationError) {
      setError(validationError);
      return;
    }
    const trimmedComment = comment.trim();
    const input: ResolveOperatorDecisionInput = {
      actionId: action.id,
      selectedOptionIds: overrideSelection ?? (action.requiresSelection ? effectiveSelectionFor(action) : []),
      comment: decision.definition.comment.mode === "disabled" || !trimmedComment ? null : trimmedComment,
    };
    setError(null);
    setSubmittingActionId(action.id);
    try {
      await onResolve(decision.id, input);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : L(lang, { en: "Failed to resolve this Interactive Card.", ko: "결정 카드를 처리하지 못했습니다." }));
    } finally {
      setSubmittingActionId(null);
    }
  }

  // [카드 UX 핫픽스 ①] 카드가 실제 해석 문장을 가질 때만 '쉬운 해석 (AI)' 패널을 숨긴다 —
  //   해석이 없거나 최소 폴백 문장뿐이면 AI 패널을 다시 표시해 해석 경로를 열어 둔다.
  const interpretationText = compactCard && decision.definition.humanReview
    ? formatCompactInterpretation(decision.definition.humanReview, decision.definition.options.map((option) => option.label))
    : "";
  const cardHasRealInterpretation = interpretationText !== "" && interpretationText !== COMPACT_INTERPRETATION_FALLBACK;

  // 초보자 해석(표시 전용 — 원문 유지, 실패 시 자동 숨김). 신형 축소 카드에서는 해석·근거 칩 뒤로 이동한다.
  const summaryNode = (
    <CardHumanSummary
      approvalId={decision.id}
      companyId={decision.companyId}
      summary={(decision as { humanSummary?: import("../api/approvals").HumanSummaryView | null }).humanSummary}
      retranslate={operatorDecisionsApi.retranslateSummary}
      fetchCurrent={async (id) => (await operatorDecisionsApi.get(id) as { humanSummary?: import("../api/approvals").HumanSummaryView | null }).humanSummary}
    />
  );
  return (
    <article className="tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white p-4 text-slate-900 tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.10)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]" aria-labelledby={`operator-decision-${decision.id}-heading`}>
      {(decision.missionTitle || decision.issueIdentifier || decision.issueTitle) && (
        <div data-operator-decision-context className="mb-2 flex flex-col gap-0.5 border-b border-slate-200/80 pb-2 text-xs text-slate-600 dark:border-white/[0.07] dark:text-slate-400">
          {decision.missionTitle && <span className="text-slate-500 dark:text-[#8f9db3]">{L(lang, { en: "Mission:", ko: "미션:" })} {decision.missionTitle}</span>}
          {(decision.issueIdentifier || decision.issueTitle) && (
            <span className="font-medium text-slate-900 dark:text-slate-100">
              {L(lang, { en: "Issue:", ko: "이슈:" })} {decision.issueIdentifier ?? ""}{decision.issueIdentifier && decision.issueTitle ? " — " : ""}{decision.issueTitle ?? ""}
            </span>
          )}
        </div>
      )}
      <div data-operator-decision-meta className="flex flex-wrap items-center gap-2 text-xs tabular-nums text-slate-500 dark:text-[#8f9db3]">
        <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]" title={decision.priority}>{humanLabel(lang, "priority", decision.priority).label}</span>
        {/* [owner-choice-card] choice 카드는 오류·실패 톤이 아닌 결정 요청 배지 + 한국어 결정 지점 라벨로 표시한다. */}
        {choiceCard.isChoiceCard && (
          <span data-operator-choice-badge className="rounded-md border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]">
            {choiceCard.decisionPointLabel === null
              ? L(lang, { en: "Decision request", ko: "결정 요청" })
              : `${L(lang, { en: "Decision request", ko: "결정 요청" })} · ${choiceCard.decisionPointLabel}`}
          </span>
        )}
        <span>{L(lang, { en: "Requested by", ko: "요청:" })} {sourceLabel(decision, lang)}</span>
        <span>{timeAgo(decision.createdAt)}</span>
      </div>
      <p className="mt-3 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8f9db3]">{L(lang, { en: "What needs deciding?", ko: "무엇을 결정해야 하나요?" })}</p>
      <h2
        id={`operator-decision-${decision.id}-heading`}
        data-operator-decision-heading
        tabIndex={-1}
        className="mt-1.5 text-lg font-semibold tracking-[-0.01em] text-slate-950 dark:text-slate-50"
      >
        {subject}
      </h2>
      {/* 신형 축소 카드에서는 제목과 decisionSubject 가 중복되므로 부제목(title) 은 펼치지 않는다. */}
      {subject !== decision.title && !compactCard && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{decision.title}</p>}
      {/* 판단 카드(humanReview)가 있으면 마크다운 description 은 중복 — 표시하지 않는다. */}
      {!decision.definition.humanReview && (
        <p id={descriptionId} className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-600 dark:text-slate-300">{decision.description}</p>
      )}

      {/* [owner-choice-card] choice 옵션 블록 — 요약·추천 표시·(해당 시) 2시간 자동 진행 안내 배너.
          옵션 버튼 클릭이 곧 resolve 라서 이 블록이 렌더될 때 구형 선택지 목록은 이중 나열을 피하려 숨긴다. */}
      {choiceOptionsShown && (
        <section data-operator-choice-options className="mt-3 space-y-2">
          {choiceCard.autoAdvanceNotice && (
            <p data-operator-choice-auto-advance role="status" className="rounded-[10px] border border-blue-500/25 bg-blue-500/10 px-3 py-2 text-xs font-medium text-blue-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              {choiceCard.autoAdvanceNotice}
            </p>
          )}
          {choiceCard.choiceOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              data-operator-choice-option={option.id}
              onClick={() => chooseChoiceOption(option.id)}
              disabled={submittingActionId !== null}
              className="w-full rounded-[10px] border border-slate-200/90 bg-white px-3 py-2 text-left text-sm text-slate-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-[color,background-color,border-color,box-shadow,transform] hover:border-blue-500/35 hover:bg-blue-50/60 disabled:opacity-50 motion-safe:enabled:active:scale-[0.96] dark:border-white/10 dark:bg-[#07090d] dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#101827]"
            >
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {option.label}
                {option.recommended && (
                  <span data-operator-choice-recommended className="rounded border border-lime-600/35 bg-lime-500/10 px-1.5 py-0.5 text-xs font-semibold text-lime-700 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/12 dark:text-[#a3e635]">
                    {L(lang, { en: "Recommended", ko: "추천" })}
                  </span>
                )}
                {option.irreversible && (
                  <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]">{L(lang, { en: "Irreversible", ko: "되돌릴 수 없음" })}</span>
                )}
              </span>
              {option.summary !== "" && <span className="mt-1 block text-xs leading-relaxed text-slate-500 dark:text-slate-400">{option.summary}</span>}
            </button>
          ))}
        </section>
      )}

      {compactCard && decision.definition.humanReview ? (
        <div className="mt-3 space-y-3">
          <HumanReviewSymptomBlock packet={decision.definition.humanReview} />
        </div>
      ) : (
        <HumanReviewPacket packet={decision.definition.humanReview ?? null} variant="compact" />
      )}

      {!compactCard && summaryNode}

      {/* [사람 카드 축소 Stage 4] 신형 카드 고정 순서: 증상 → 선택지(라벨+1줄 요약) → 쉬운 해석 → 상세 근거 링크.
          [핫픽스 ③] 주 선택지에는 실제 행동 옵션만 — 승인/보류/반려 형식 옵션은 액션 버튼이 담당한다. */}
      {compactCard && (
        <OperatorDecisionOptions
          decision={visibleOptionsDecision}
          selectedOptionIds={selectedOptionIds}
          onToggle={toggleOption}
          disabled={submittingActionId !== null}
          descriptionId={descriptionId}
          errorId={errorId}
          commonFacts={commonFacts}
          singleLineDescriptions
        />
      )}
      {/* [사람 카드 UI 중복 정리] 쉬운 해석은 선택지 나열을 반복하지 않는다(선택지 라벨을 판정에 넘긴다).
          신형 축소 카드는 '쉬운 해석 (AI)' 패널을 숨기고 구형 긴 카드(!compactCard)만 유지한다. */}
      {compactCard && decision.definition.humanReview && (
        <div className="mt-3 space-y-3">
          <HumanReviewInterpretationBlock
            packet={decision.definition.humanReview}
            optionLabels={decision.definition.options.map((option) => option.label)}
          />
          <HumanReviewEvidenceChips packet={decision.definition.humanReview} />
        </div>
      )}
      {/* [카드 UX 핫픽스 ①] 카드에 실제 해석이 없으면(폴백 문장뿐) '쉬운 해석 (AI)' 패널을 다시 표시한다. */}
      {compactCard && !cardHasRealInterpretation && summaryNode}

      <div className="mt-3 flex flex-wrap gap-2">
        {decision.issueId && (
          <Button asChild variant="outline" size="sm" className="border-slate-200/90 bg-white text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] hover:border-blue-500/35 hover:bg-blue-50/70 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-[#60a5fa]/35 dark:hover:bg-[#101827]">
            <Link to={`/issues/${decision.issueId}`}>{L(lang, { en: "Open linked work", ko: "연관 업무 열기" })}<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Link>
          </Button>
        )}
        {decision.sourceContext.missionId && (
          <Button asChild variant="outline" size="sm" className="border-slate-200/90 bg-white text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] hover:border-blue-500/35 hover:bg-blue-50/70 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-[#60a5fa]/35 dark:hover:bg-[#101827]">
            <Link to={`/missions/${decision.sourceContext.missionId}`}>{L(lang, { en: "Open mission", ko: "미션 열기" })}<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Link>
          </Button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {decision.sourceContext.artifactRefs.map((ref) => (
          ref.uri.startsWith("http:") || ref.uri.startsWith("https:") || ref.uri.startsWith("/")
            ? (ref.uri.startsWith("/")
                ? <Link key={ref.uri} to={ref.uri}>{ref.label}</Link>
                : <a key={ref.uri} href={ref.uri} target="_blank" rel="noreferrer">{ref.label}</a>)
            : <span key={ref.uri}>{ref.label}</span>
        ))}
      </div>

      {commonFacts.length > 0 && <section className="mt-4"><h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8f9db3]">{L(lang, { en: "Common facts", ko: "공통 사실" })}</h3><OperatorDecisionFacts facts={commonFacts} /></section>}
      {/* 구형 카드는 기존 위치(근거·사실 아래)에 선택지를 표시한다. 신형 축소 카드의 선택지는 위로 올렸다. */}
      {!compactCard && !choiceOptionsShown && (
        <OperatorDecisionOptions
          decision={visibleOptionsDecision}
          selectedOptionIds={selectedOptionIds}
          onToggle={toggleOption}
          disabled={submittingActionId !== null}
          descriptionId={descriptionId}
          errorId={errorId}
          commonFacts={commonFacts}
        />
      )}

      {/* [범위 표시 제거] approvedScope/forbiddenScope는 왜 카드로 승격됐는지 설명하는 표시 전용 메타데이터다.
          운영자가 수정해도 실행을 바꾸는 경로가 없어서(2026-10-20 운영자 요청) 표시하지 않는다. */}

      {decision.definition.comment.mode !== "disabled" && (
        <div className="mt-4">
          <label htmlFor={commentId} className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8f9db3]">{decision.definition.comment.label}</label>
          <textarea
            id={commentId}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={decision.definition.comment.placeholder ?? undefined}
            maxLength={decision.definition.comment.maxLength}
            required={decision.definition.comment.mode === "required"}
            aria-describedby={`${descriptionId} ${errorId}`}
            disabled={submittingActionId !== null || (!decision.definition.humanReview && !choiceOptionsShown)}
            title={!decision.definition.humanReview && !choiceOptionsShown ? L(lang, { en: "Decision information and source locations are required before deciding.", ko: "판단 정보와 원본 위치를 보완해야 결정할 수 있습니다." }) : undefined}
            className="mt-1 min-h-20 w-full rounded-md border border-slate-200 bg-white p-2 text-sm text-slate-800 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] outline-none transition-colors placeholder:text-slate-400 focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/15 disabled:opacity-60 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-100 dark:shadow-none dark:placeholder:text-slate-500 dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/20"
          />
        </div>
      )}

      <div ref={errorRef} id={errorId} role="alert" aria-live="assertive" tabIndex={-1} className="mt-3 text-sm font-medium text-destructive dark:text-red-300">
        {error}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {decision.definition.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => void submit(action)}
            disabled={submittingActionId !== null || (!decision.definition.humanReview && !choiceOptionsShown)}
            title={!decision.definition.humanReview && !choiceOptionsShown ? L(lang, { en: "Decision information and source locations are required before deciding.", ko: "판단 정보와 원본 위치를 보완해야 결정할 수 있습니다." }) : undefined}
            className={cn("rounded-lg border px-3 py-2 text-sm font-semibold transition-[color,background-color,border-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:opacity-50 motion-safe:enabled:active:scale-[0.96] dark:focus-visible:ring-[#60a5fa]/30", toneClass(action.tone))}
          >
            {submittingActionId === action.id ? L(lang, { en: "Submitting…", ko: "제출 중…" }) : action.label}
          </button>
        ))}
      </div>
    </article>
  );
}
