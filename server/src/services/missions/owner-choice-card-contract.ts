// server/src/services/missions/owner-choice-card-contract.ts
//
// [owner-choice-card Stage 1] 정상 흐름(normal-flow) 사람 선택 카드의 payload 계약.
//   배경: 지금까지 사람 카드는 C08 복구/에스컬레이션(request_input/escalate)만 표현했다.
//   이 계약은 주제·방향·예산·게시 승인처럼 진행 중에 사람에게 선택지를 제시하는 카드
//   (decisionKind: "choice")와 2시간 무응답 자동 진행 제안(autoAdvanceProposal)을 정의한다.
// [하위 호환] C08 복구 카드 계약(owner-human-request-contract)은 이 Stage 에서 전혀
//   수정하지 않는다 — 기존 카드와 100% 호환을 유지하기 위해서다. 선택 카드는 별도
//   sourceType/sourceContext 를 쓰며 기존 SQL 판독 경로(sourceContext->>'missionId' 등)는
//   base 키를 유지해 계속 동작한다.
// [실행 권위] Stage 1 TTL 엔진(owner-human-card-ttl)은 카드 본문 자연어를 읽지 않고
//   sourceContext 의 구조화 힌트만 읽는다(구조화 권위 규칙 9). 이 모듈은 그 힌트의
//   생산자 쪽 계약이며, 파싱은 fail-closed 로만 수행한다.
// [수정시 주의] safe 제안의 re한정(defaultOptionId 존재 + 비가역 금지)을 완화하면
//   TTL 엔진의 auto_advance 가 비가역 선택을 사람 대신 제출할 수 있다.

import { z } from "zod";

/** 선택 카드 기본 무응답 대기 시간 — 2시간. autoAdvanceProposal.afterMs 의 기본값. */
export const OWNER_CHOICE_CARD_DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

/** 선택 카드의 결정 지점 — 정상 흐름에서 사람 판단이 필요한 4종. */
export type OwnerChoiceDecisionPoint =
  | "topic_selection"
  | "direction_choice"
  | "budget_threshold"
  | "publish_approval";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const optionId = z.string().trim().min(1).max(80);

/** 선택지 1행. id 는 카드 안에서 유일해야 하고(superRefine), label/summary 는 사람 표시용. */
export const ownerChoiceOptionSchema = z.object({
  id: optionId,
  label: boundedText(200),
  summary: boundedText(2000),
  recommended: z.boolean().optional(),
  irreversible: z.boolean().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type OwnerChoiceOption = z.infer<typeof ownerChoiceOptionSchema>;

/**
 * 2시간 무응답 자동 진행 제안. safe=true 는 "만료 시 제안 선택지를 그대로 자동 제출해도
 * 안전하다"는 생산자의 구조화 선언이며, TTL 엔진의 safeAutoAdvance 힌트로 전달된다.
 * afterMs 기본값은 OWNER_CHOICE_CARD_DEFAULT_TTL_MS(2시간).
 */
export const ownerChoiceAutoAdvanceProposalSchema = z.object({
  afterMs: z.number().int().positive().default(OWNER_CHOICE_CARD_DEFAULT_TTL_MS),
  defaultOptionId: optionId,
  safe: z.boolean(),
  rationale: boundedText(2000),
}).strict();
export type OwnerChoiceAutoAdvanceProposalInput =
  z.input<typeof ownerChoiceAutoAdvanceProposalSchema>;
export type OwnerChoiceAutoAdvanceProposal =
  z.infer<typeof ownerChoiceAutoAdvanceProposalSchema>;

/**
 * 선택 카드 payload 전체. sourceContext 에 심기 전 이 계약으로 fail-closed 검증한다.
 * re한정: ① 옵션 id 중복 금지 ② safe 제안의 defaultOptionId 는 options 안에 존재하고
 * irreversible 이 아니어야 한다(safe=false 제안에는 이 제약이 없다 — 어차피 자동 제출 안 함).
 */
export const ownerChoiceCardPayloadSchema = z.object({
  decisionKind: z.literal("choice"),
  decisionPoint: z.enum(["topic_selection", "direction_choice", "budget_threshold", "publish_approval"]),
  prompt: boundedText(2000),
  options: z.array(ownerChoiceOptionSchema).min(2).max(8),
  autoAdvanceProposal: ownerChoiceAutoAdvanceProposalSchema.optional(),
  contextLinks: z.array(boundedText(1000)).max(20).optional(),
}).strict().superRefine((payload, ctx) => {
  const seen = new Set<string>();
  for (const [index, option] of payload.options.entries()) {
    if (seen.has(option.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options", index, "id"],
        message: `duplicate option id: ${option.id}` });
      continue;
    }
    seen.add(option.id);
  }
  const proposal = payload.autoAdvanceProposal;
  if (proposal?.safe !== true) return;
  const target = payload.options.find((option) => option.id === proposal.defaultOptionId);
  if (target === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["autoAdvanceProposal", "defaultOptionId"],
      message: `safe auto-advance defaultOptionId not in options: ${proposal.defaultOptionId}` });
    return;
  }
  if (target.irreversible === true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["autoAdvanceProposal"],
      message: `safe auto-advance cannot target an irreversible option: ${target.id}` });
  }
});
export type OwnerChoiceCardPayload = z.infer<typeof ownerChoiceCardPayloadSchema>;
export type OwnerChoiceCardPayloadInput = z.input<typeof ownerChoiceCardPayloadSchema>;

export type OwnerChoiceCardParseResult =
  | { ok: true; data: OwnerChoiceCardPayload }
  | { ok: false; error: string };

/** fail-closed 파서 — 댓글·stdout·본문 자연어는 권위가 아니며 이 계약만 선택지의 권위다. */
export function parseOwnerChoiceCardPayload(raw: unknown): OwnerChoiceCardParseResult {
  const parsed = ownerChoiceCardPayloadSchema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: parsed.error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ") };
}

/**
 * 카드 생성자(Stage 2 빌더)가 operator decision 의 기존 sourceContext 키를 선택 힌트와
 * 함께 채울 수 있게 하는 기본 식별자. 키 이름은 기존 operatorDecisionSourceContextSchema
 * (missionId/workflowId/workflowRunId/artifactRefs)와 같다.
 */
export interface OwnerChoiceCardBaseContext {
  missionId: string;
  workflowId?: string | null;
  workflowRunId?: string | null;
}

/**
 * 선택 카드 sourceContext 를 만든다. Stage 1 TTL 엔진(owner-human-card-ttl)의 판독 키와
 * 1:1 대응한다:
 *   - decisionKind "choice" → TTL 엔진의 2시간 기본 정책 트리거,
 *   - ttlMs → 이 카드만의 만료 재정의(제안 afterMs, 없으면 기본 2시간),
 *   - suggestedDecision → 만료 시 auto_advance 의 decision 값(제안 선택지 id, 없으면 null),
 *   - safeAutoAdvance → 안전 어휘 목록 밖 제안도 자동 진행 허용(safe 제안일 때만 true),
 *   - irreversible → 옵션 하나라도 비가역이면 절대 자동 진행 금지(만료 시 회수 경로),
 *   - choiceOptions/decisionPoint → 카드 어드미션·렌더링용 선택지 스냅샷.
 * base 를 넣으면 기존 키(missionId/workflowId/workflowRunId/artifactRefs)를 그대로 유지해
 * 기존 판독 경로와 하위 호환을 유지한다.
 */
export function buildOwnerChoiceCardSourceContext(
  payload: OwnerChoiceCardPayload,
  base?: OwnerChoiceCardBaseContext,
): Record<string, unknown> {
  const proposal = payload.autoAdvanceProposal;
  return {
    ...(base ? {
      missionId: base.missionId,
      workflowId: base.workflowId ?? null,
      workflowRunId: base.workflowRunId ?? null,
      artifactRefs: [] as unknown[],
    } : {}),
    decisionKind: "choice" as const,
    decisionPoint: payload.decisionPoint,
    ttlMs: proposal?.afterMs ?? OWNER_CHOICE_CARD_DEFAULT_TTL_MS,
    suggestedDecision: proposal?.defaultOptionId ?? null,
    safeAutoAdvance: proposal?.safe === true,
    irreversible: payload.options.some((option) => option.irreversible === true),
    choiceOptions: payload.options.map((option) => ({
      id: option.id,
      label: option.label,
      summary: option.summary,
      recommended: option.recommended === true,
      irreversible: option.irreversible === true,
    })),
  };
}
