/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { OperatorDecisionCard } from "./OperatorDecisionCard";
import { buildOwnerChoiceCardView } from "../lib/owner-choice-card-view";
import { CompanyLanguageProvider } from "../lib/companyLanguage";

vi.mock("../lib/router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
}));

// [owner-choice-card] normal-flow choice payload — 스키마 워커(fe-owner-choice-card-payload) 계약.
// shared 타입에는 아직 decisionKind 등이 없으므로 런타임 방어 파싱 대상으로만 캐스팅한다.
const choiceSourceContext = {
  missionId: "mission-1", workflowId: null, workflowRunId: null, artifactRefs: [],
  decisionKind: "choice",
  decisionPoint: "topic_selection",
  safeAutoAdvance: true,
  ttlMs: 7_200_000,
  suggestedDecision: "topics-b",
  irreversible: false,
  choiceOptions: [
    { id: "topics-a", label: "A안: 리서치", summary: "고객 리서치를 먼저 진행한다", recommended: false, irreversible: false },
    { id: "topics-b", label: "B안: 출시 준비", summary: "다음 주 출시 준비를 착수한다", recommended: true, irreversible: false },
  ],
} as OperatorDecisionView["sourceContext"];

const choiceDefinition = {
  options: [
    { id: "topics-a", label: "A안: 리서치", description: null, facts: [], evidenceRefs: [] },
    { id: "topics-b", label: "B안: 출시 준비", description: null, facts: [], evidenceRefs: [] },
  ],
  actions: [{ id: "choose-topic", label: "선택 제출", outcome: "submit", tone: "primary", requiresSelection: true }],
  selection: { min: 1, max: 1 },
  comment: { mode: "optional", label: null, placeholder: null, maxLength: 200 },
  approvedScope: [], forbiddenScope: [], humanReview: null,
} as OperatorDecisionView["definition"];

function decisionBase(id: string, overrides: Partial<OperatorDecisionView> = {}): OperatorDecisionView {
  return {
    id,
    companyId: "company-1",
    schemaVersion: 1,
    requestKey: `moi2:${id}`,
    status: "pending",
    priority: "medium",
    interactionType: "single_select",
    title: "Owner asks to pick",
    description: "Pick the next mission topic.",
    sourceType: "mission_owner_human_input",
    sourceId: `event-${id}`,
    sourceContext: { missionId: "mission-1", workflowId: null, workflowRunId: null, artifactRefs: [] },
    definition: {
      options: [],
      actions: [{ id: "choose", label: "제출", outcome: "submit", tone: "primary", requiresSelection: true }],
      selection: { min: 1, max: 1 },
      comment: { mode: "optional", label: null, placeholder: null, maxLength: 200 },
      approvedScope: [], forbiddenScope: [], humanReview: null,
    },
    result: null,
    issueId: null,
    issueIdentifier: null,
    issueTitle: null,
    missionTitle: "화요 미션",
    continuationMode: "issue_current_assignee",
    requestedBy: { type: "agent", id: "agent-1" },
    resolvedByUserId: null,
    resolvedAt: null,
    cancelledAt: null,
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z",
    continuation: null,
    ...overrides,
  };
}

const choiceDecision = decisionBase("decision-choice", {
  sourceContext: choiceSourceContext,
  definition: choiceDefinition,
});

const irreversibleDecision = decisionBase("decision-irrev", {
  sourceContext: {
    ...choiceSourceContext,
    decisionPoint: "publish_approval",
    suggestedDecision: "topics-a",
    irreversible: true,
  } as OperatorDecisionView["sourceContext"],
});

const legacyDecision = decisionBase("decision-legacy", {
  definition: {
    options: [
      { id: "approve", label: "Approve", description: null, facts: [], evidenceRefs: [] },
      { id: "hold", label: "Hold", description: null, facts: [], evidenceRefs: [] },
    ],
    actions: [{ id: "approve", label: "Approve", outcome: "approve", tone: "primary", requiresSelection: true }],
    selection: { min: 1, max: 1 },
    comment: { mode: "optional", label: null, placeholder: null, maxLength: 200 },
    approvedScope: [], forbiddenScope: [], humanReview: null,
  },
});

let host: HTMLDivElement;
let root: Root;

async function renderCard(decision: OperatorDecisionView, onResolve = vi.fn().mockResolvedValue(undefined)) {
  await act(async () => {
    root.render(<CompanyLanguageProvider language="ko"><OperatorDecisionCard decision={decision} onResolve={onResolve} /></CompanyLanguageProvider>);
  });
  return onResolve;
}

function click(element: Element) {
  act(() => (element as HTMLElement).click());
}

describe("buildOwnerChoiceCardView", () => {
  it("returns isChoiceCard:false for cards without decisionKind choice", () => {
    const view = buildOwnerChoiceCardView(legacyDecision);
    expect(view.isChoiceCard).toBe(false);
    expect(view.decisionPointLabel).toBeNull();
    expect(view.choiceOptions).toEqual([]);
    expect(view.autoAdvanceNotice).toBeNull();
  });

  it("normalizes the decision point label, options and 2h auto-advance notice", () => {
    const view = buildOwnerChoiceCardView(choiceDecision);
    expect(view.isChoiceCard).toBe(true);
    expect(view.decisionPointLabel).toBe("주제 선택");
    expect(view.choiceOptions.map((option) => option.id)).toEqual(["topics-a", "topics-b"]);
    expect(view.choiceOptions[1]).toMatchObject({ label: "B안: 출시 준비", recommended: true, irreversible: false });
    expect(view.autoAdvanceNotice).toBe("2시간 무응답 시 추천 선택지로 자동 진행 예정");
    expect(view.submitActionId).toBe("choose-topic");
  });

  it("drops the auto-advance notice when safeAutoAdvance is false", () => {
    const view = buildOwnerChoiceCardView(decisionBase("x", {
      sourceContext: { ...choiceSourceContext, safeAutoAdvance: false } as OperatorDecisionView["sourceContext"],
    }));
    expect(view.isChoiceCard).toBe(true);
    expect(view.autoAdvanceNotice).toBeNull();
  });
});

describe("OperatorDecisionCard choice card (owner-choice-card)", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("renders the 결정 요청 badge, decision point label, options, recommended tag and 2h notice", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko"><OperatorDecisionCard decision={choiceDecision} onResolve={vi.fn()} /></CompanyLanguageProvider>,
    );
    expect(html).toContain('data-operator-choice-badge');
    expect(html).toContain("결정 요청 · 주제 선택");
    expect(html).toContain('data-operator-choice-option="topics-a"');
    expect(html).toContain('data-operator-choice-option="topics-b"');
    expect(html).toContain("다음 주 출시 준비를 착수한다");
    expect(html).toContain('data-operator-choice-recommended');
    expect(html).toContain("추천");
    expect(html).toContain('data-operator-choice-auto-advance');
    expect(html).toContain("2시간 무응답 시 추천 선택지로 자동 진행 예정");
    // 선택지 이중 나열 금지 — choice 블록이 렌더됐으면 구형 옵션 목록은 숨긴다.
    expect(html).not.toContain('data-operator-decision-option="topics-b"');
  });

  it("resolves the decision through the existing submit handler when an option is clicked", async () => {
    const onResolve = await renderCard(choiceDecision);
    click(host.querySelector('[data-operator-choice-option="topics-b"]')!);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith("decision-choice", {
      actionId: "choose-topic",
      selectedOptionIds: ["topics-b"],
      comment: null,
    });
  });

  it("never shows the auto-advance notice on an irreversible publish_approval card", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko"><OperatorDecisionCard decision={irreversibleDecision} onResolve={vi.fn()} /></CompanyLanguageProvider>,
    );
    expect(html).toContain('data-operator-choice-badge');
    expect(html).toContain("발행 승인");
    expect(html).not.toContain('data-operator-choice-auto-advance');
    expect(html).not.toContain("자동 진행");
    expect(html).toContain('data-operator-choice-option="topics-a"');
  });

  it("keeps legacy non-choice cards free of choice decoration", async () => {
    const onResolve = await renderCard(legacyDecision);
    const html = host.innerHTML;
    expect(html).not.toContain('data-operator-choice-badge');
    expect(html).not.toContain('data-operator-choice-auto-advance');
    expect(html).toContain('data-operator-decision-option="approve"');
    click(host.querySelector('[data-operator-decision-option="approve"]')!);
    expect(onResolve).not.toHaveBeenCalled();
  });
});
