// [파일 목적] human_wait(사람 대기) 승인 스텝의 decisionTemplate 승인 카드 초안 편집 섹션.
// GraphInspectorEditStep이 승인 게이트(graphApprovalRequired) 또는 human_wait 논리 클래스일 때 렌더.
// [외부 연결] ./shared-controls.tsx, ./workflow-page-styles.ts, ./step-draft.js, react.
// [주의] 초안(draft) 필드 편집 UI만 담당 — 직렬화는 저장 경로, 유효성 판정은 공유 검증기가 한다.
// decisionTemplate 초안 필드는 optional(jsonToSteps가 아직 채우지 않음)이라 값은 ?? 기본값으로 읽는다.
import type { JSX } from "react";
import type { StepDraft } from "./step-draft.js";
import { inputStyle, mutedTextStyle, textareaStyle } from "./workflow-page-styles.js";
import { FieldLabel, HelpIcon } from "./shared-controls.js";

// [목적] 승인 카드 프리셋(title/prompt/requiredRole/timeoutMinutes/allowReject) 편집 <details> 섹션 렌더.
// [입력] selectedStep(사람 대기 스텝 초안) + updateSelected(초안 patch).
// [연결] GraphInspectorEditStep이 조건부 렌더. 표시 조건은 호출부 resolveNodeLogicalClass가 판정.
export function StepDecisionTemplateCardFields({
  selectedStep,
  updateSelected,
}: {
  selectedStep: StepDraft;
  updateSelected: (patch: Partial<StepDraft>) => void;
}): JSX.Element {
  const timeoutDraft = selectedStep.decisionTemplateTimeoutMinutes;
  return (
    <details
      key="decision-template-card"
      style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--pw-hairline)" }}
    >
      <summary style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px", fontWeight: 700 }}>
        Human Wait · 승인 카드 설정 (decisionTemplate)
        <HelpIcon label="Approval card preset for the structured human wait. Approvers see the title, prompt, allowed role, timeout, and whether reject is allowed." />
      </summary>
      <div style={{ display: "grid", gap: "6px", paddingTop: "6px" }}>
        <div style={{ display: "grid", gap: "4px" }}>
          <FieldLabel help="Approval card title shown to approvers when the workflow pauses on this step.">Card title</FieldLabel>
          <input
            style={inputStyle}
            aria-label="Card title"
            placeholder="Card title"
            value={selectedStep.decisionTemplateTitle ?? ""}
            onChange={(event) => updateSelected({ decisionTemplateTitle: event.target.value })}
          />
        </div>
        <div style={{ display: "grid", gap: "4px" }}>
          <FieldLabel help="Question or instruction the approver answers when resolving this human wait card.">Card prompt</FieldLabel>
          <textarea
            style={{ ...textareaStyle, minHeight: "58px" }}
            aria-label="Card prompt"
            placeholder="Card prompt"
            value={selectedStep.decisionTemplatePrompt ?? ""}
            onChange={(event) => updateSelected({ decisionTemplatePrompt: event.target.value })}
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
          <div style={{ display: "grid", gap: "4px" }}>
            <FieldLabel help="Role expected to resolve this card. Recorded as a preset on the approval card.">Required role</FieldLabel>
            <input
              style={inputStyle}
              aria-label="Required role"
              placeholder="reviewer"
              value={selectedStep.decisionTemplateRequiredRole ?? ""}
              onChange={(event) => updateSelected({ decisionTemplateRequiredRole: event.target.value })}
            />
          </div>
          <div style={{ display: "grid", gap: "4px" }}>
            <FieldLabel help="Minutes to wait before the card times out. Fractional minutes allowed; blank means no preset.">Timeout minutes</FieldLabel>
            <input
              style={inputStyle}
              aria-label="Timeout minutes"
              type="number"
              min={0}
              step={0.5}
              placeholder="minutes"
              value={timeoutDraft === undefined ? "" : String(timeoutDraft)}
              onChange={(event) => updateSelected({ decisionTemplateTimeoutMinutes: event.target.value })}
            />
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", ...mutedTextStyle, fontSize: "12px" }}>
          <input
            type="checkbox"
            aria-label="Allow reject"
            checked={selectedStep.decisionTemplateAllowReject ?? false}
            onChange={(event) => updateSelected({ decisionTemplateAllowReject: event.target.checked })}
          />
          Allow reject
          <HelpIcon label="When enabled, approvers may reject this card and stop the step instead of approving." />
        </label>
      </div>
    </details>
  );
}
