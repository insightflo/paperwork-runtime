// North Star 3-type logical class overlay for workflow graph nodes (Pillar 1).
// Maps the existing 5 draft step types plus the distributed human-wait approval
// flag onto three capability classes: deterministic function, AI agent, human
// wait. Read-time logical promotion only: existing graphApprovalRequired steps
// render as human_wait without changing the stored step shape (backward compat).

import type { CSSProperties } from "react";

export type WorkflowNodeLogicalClass = "function" | "ai_agent" | "human_wait";

export type WorkflowNodeLogicalClassInput = {
  type?: unknown;
  graphApprovalRequired?: unknown;
  [key: string]: unknown;
};

const LOGICAL_CLASS_BY_STEP_TYPE: Record<string, WorkflowNodeLogicalClass> = {
  tool: "function",
  if: "function",
  complete: "function",
  agent: "ai_agent",
  workflow: "ai_agent",
  human_wait: "human_wait",
};

export const workflowNodeLogicalClassOrder: WorkflowNodeLogicalClass[] = [
  "function",
  "ai_agent",
  "human_wait",
];

export const nodeLogicalClassLabels: Record<WorkflowNodeLogicalClass, { en: string; ko: string }> = {
  function: { en: "Function", ko: "코드 · 결정론 규칙/도구" },
  ai_agent: { en: "AI Agent", ko: "AI 에이전트 · 판단/작성" },
  human_wait: { en: "Human Wait", ko: "사람 대기 · 구조적 멈춤/승인" },
};

export function nodeLogicalClassBadgeLabel(logicalClass: WorkflowNodeLogicalClass): string {
  return nodeLogicalClassLabels[logicalClass].en;
}

export function resolveNodeLogicalClass(
  step: WorkflowNodeLogicalClassInput | null | undefined,
): WorkflowNodeLogicalClass {
  const type = typeof step?.type === "string" ? step.type.trim().toLowerCase() : "";
  if (type === "human_wait") return "human_wait";
  if (readApprovalRequiredFlag(step?.graphApprovalRequired)) return "human_wait";
  return LOGICAL_CLASS_BY_STEP_TYPE[type] ?? "ai_agent";
}

// Paperwork semantic tokens only — zero raw hex literals (brief standard).
export const nodeLogicalClassBadgeStyle: Record<WorkflowNodeLogicalClass, CSSProperties> = {
  function: buildLogicalClassBadgeStyle("var(--pw-cobalt)", "var(--pw-cobalt-soft)"),
  ai_agent: buildLogicalClassBadgeStyle("var(--pw-lime)", "var(--pw-lime-soft)"),
  human_wait: buildLogicalClassBadgeStyle("var(--pw-amber)", "var(--pw-amber-soft)"),
};

function buildLogicalClassBadgeStyle(color: string, background: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    color,
    background,
    border: "var(--pw-hairline-width, 1px) solid var(--pw-hairline)",
    borderRadius: "999px",
    padding: "1px 8px",
    fontSize: "10px",
    fontWeight: 700,
    lineHeight: 1.4,
    whiteSpace: "nowrap",
  };
}

function readApprovalRequiredFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}
