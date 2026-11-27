import type { WorkflowHumanWaitDecisionTemplate } from "@paperclipai/shared/types/workflow";

export function parseOptionalNonNegativeInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseOptionalPositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseOptionalGraphPosition(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

/**
 * [stage26 human_wait] decisionTemplate.timeoutMinutes 파서 — 분 단위 양수(소수 허용, 초→분
 * 무손실 환산용). 문자열 초안 입력과 직렬화된 숫자 양쪽을 받는다. 0·음수·비수치는 미설정.
 */
export function parseDecisionTemplateTimeoutMinutes(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * [stage26 human_wait] 임포트된 스텝의 decisionTemplate 객체를 초안 프리셋으로 파싱한다.
 * 빈 문자열/무효 값은 침묵 제거 대신 미설정(undefined)으로 남겨 공유 검증기가 유효성을 판정한다.
 * 의미 있는 필드가 하나도 없으면 undefined — 빈 프리셋을 만들지 않는다.
 */
export function parseOptionalDecisionTemplate(value: unknown): WorkflowHumanWaitDecisionTemplate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const template: WorkflowHumanWaitDecisionTemplate = {};
  const text = (key: string): string | undefined => {
    const v = raw[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const title = text("title");
  if (title) template.title = title;
  const prompt = text("prompt");
  if (prompt) template.prompt = prompt;
  const requiredRole = text("requiredRole");
  if (requiredRole) template.requiredRole = requiredRole;
  const approvalLabel = text("approvalLabel");
  if (approvalLabel) template.approvalLabel = approvalLabel;
  const rejectLabel = text("rejectLabel");
  if (rejectLabel) template.rejectLabel = rejectLabel;
  const timeoutMinutes = parseDecisionTemplateTimeoutMinutes(raw.timeoutMinutes);
  if (timeoutMinutes !== undefined) template.timeoutMinutes = timeoutMinutes;
  if (raw.allowReject === true || raw.allowReject === false) template.allowReject = raw.allowReject;
  return Object.keys(template).length > 0 ? template : undefined;
}

/**
 * [stage26 human_wait] 레거시 graphApprovalRequired 플래그 스텝의 논리 승격용 프리셋 도출.
 * 저장 직렬화는 기존 플래그를 유지한다(역호환) — 이 도출값은 읽기/편집 UI 프리필용이다.
 * timeoutSeconds 는 분으로 무손실 환산한다(90초 → 1.5분). 승인/거절 라벨은 레거시에 없어 미설정.
 */
export function decisionTemplateFromLegacyApprovalFlags(raw: {
  graphApprovalRequired?: unknown;
  graphApprovalPrompt?: unknown;
  graphApprovalTimeoutSeconds?: unknown;
}): WorkflowHumanWaitDecisionTemplate | undefined {
  if (raw.graphApprovalRequired !== true && raw.graphApprovalRequired !== "true") return undefined;
  const template: WorkflowHumanWaitDecisionTemplate = {};
  if (typeof raw.graphApprovalPrompt === "string" && raw.graphApprovalPrompt.trim()) {
    template.prompt = raw.graphApprovalPrompt.trim();
  }
  const timeoutSeconds = typeof raw.graphApprovalTimeoutSeconds === "number"
    ? raw.graphApprovalTimeoutSeconds
    : parseOptionalPositiveInteger(String(raw.graphApprovalTimeoutSeconds ?? ""));
  if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
    template.timeoutMinutes = timeoutSeconds / 60;
  }
  return Object.keys(template).length > 0 ? template : undefined;
}
