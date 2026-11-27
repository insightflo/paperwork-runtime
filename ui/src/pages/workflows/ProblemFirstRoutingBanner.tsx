// ui/src/pages/workflows/ProblemFirstRoutingBanner.tsx
//
// [파일 목적] 문제-우선 라우팅 가드(s26-two-graph-architecture §3, Pillar 3): 판단 질문 Q1(구조적 제어 —
//   사람 승인·분기·순서 보장이 앱 구조로 강제돼야 하는가)과 Q2(다중 홉 맥락 — 필요한 정보가 2 hop 이상
//   떨어진 여러 기록에 흩어져 있는가)로 단일 에이전트·워크플로 그래프·Data Graph 질의·두 그래프 조합
//   중 적합한 형태를 평가하고, 비차단(권고) 안내 카드를 렌더링한다.
//   결과는 표시 전용이며 실행 제어(재시도·wakeup·승인 등)의 근거로 읽히지 않는다.
// [연결] 워크플로 생성·편집 UI의 마법사 첫 화면 표시 예정(마운트 지점은 후속 wave). 평가기는 순수 함수라
//   단위 테스트 대상이며, 카드는 jsdom 렌더 테스트로 검증한다.

import { type CSSProperties, type JSX } from "react";

export type WorkflowRoutingMode = "single_agent" | "workflow_graph" | "data_graph_rag" | "two_graph";

export type WorkflowRoutingAdvisoryLevel = "none" | "hint" | "caution";

export type WorkflowRoutingGuardInput = {
  stepCount: number;
  hasHumanWaitOrApproval: boolean;
  hasBranchingOrParallel: boolean;
  needsMultiHopDataContext: boolean;
};

export type WorkflowRoutingGuardResult = {
  mode: WorkflowRoutingMode;
  advisoryLevel: WorkflowRoutingAdvisoryLevel;
  headlineKo: string;
  detailKo: string;
  q1StructuralControl: boolean;
  q2MultiHopContext: boolean;
};

const MODE_LABEL_KO: Record<WorkflowRoutingMode, string> = {
  single_agent: "단일 에이전트",
  workflow_graph: "워크플로 그래프",
  data_graph_rag: "Data Graph 질의",
  two_graph: "두 그래프 조합",
};

/**
 * 라우팅 가드 평가기(순수 함수). 아래 규칙을 순서대로 적용한다(앞 규칙이 우선):
 *  1) 스텝 ≤ 1 + Q1·Q2 모두 아니오 → single_agent 힌트(그래프를 만들지 않는 편이 단순).
 *  2) 스텝 ≥ 2 + Q1 아니오 → 현재 구성물인 워크플로 그래프에 대한 caution. Q2가 참이어도 이 규칙이 우선.
 *  3) Q1·Q2 모두 예 → two_graph (none).
 *  4) Q1만 예 → workflow_graph (none).
 *  5) Q2만 예 → data_graph_rag 힌트(Data Graph 질의 권장).
 * advisoryLevel은 표시 강도일 뿐이며 어떤 결과도 저장·생성·실행을 차단하지 않는다.
 */
export function evaluateWorkflowRoutingGuard(input: WorkflowRoutingGuardInput): WorkflowRoutingGuardResult {
  const q1StructuralControl = input.hasHumanWaitOrApproval || input.hasBranchingOrParallel;
  const q2MultiHopContext = input.needsMultiHopDataContext;
  const echo = { q1StructuralControl, q2MultiHopContext };

  if (input.stepCount <= 1 && !q1StructuralControl && !q2MultiHopContext) {
    return {
      mode: "single_agent",
      advisoryLevel: "hint",
      headlineKo: "단일 에이전트 실행을 권장합니다",
      detailKo: "구조적 멈춤·분기·다중 홉 관계가 없으면 그래프를 만들지 않는 편이 단순합니다.",
      ...echo,
    };
  }
  if (input.stepCount >= 2 && !q1StructuralControl) {
    return {
      mode: "workflow_graph",
      advisoryLevel: "caution",
      headlineKo: "구조적 승인(human_wait)이나 분기 없이 다단계 그래프가 구성되었습니다",
      detailKo: "단순 순차 작업이라면 단일 에이전트로 충분할 수 있습니다.",
      ...echo,
    };
  }
  if (q1StructuralControl && q2MultiHopContext) {
    return {
      mode: "two_graph",
      advisoryLevel: "none",
      headlineKo: "워크플로 그래프와 Data Graph 질의를 함께 사용합니다",
      detailKo: "구조적 제어(멈춤·분기·순서 보장)와 관계 탐색(2-hop Data Graph)이 모두 필요한 구성입니다.",
      ...echo,
    };
  }
  if (q1StructuralControl) {
    return {
      mode: "workflow_graph",
      advisoryLevel: "none",
      headlineKo: "워크플로 그래프가 적합합니다",
      detailKo: "구조적 제어(멈춤·분기·순서 보장)가 앱 구조로 강제되어야 하므로 그래프 구성이 맞습니다.",
      ...echo,
    };
  }
  return {
    mode: "data_graph_rag",
    advisoryLevel: "hint",
    headlineKo: "관계 탐색(2-hop Data Graph)이 핵심이라면",
    detailKo: "워크플로 대신 Data Graph 질의를 권장합니다.",
    ...echo,
  };
}

type BannerTone = {
  background: string;
  border: string;
  edgeColor: string;
  headlineColor: string;
  showAdvisoryTag: boolean;
};

function advisoryTone(level: WorkflowRoutingAdvisoryLevel): BannerTone {
  if (level === "caution") {
    return {
      background: "var(--pw-token-warning-soft)",
      border: "1px solid var(--pw-token-border)",
      edgeColor: "var(--pw-token-warning)",
      headlineColor: "var(--pw-token-warning-text)",
      showAdvisoryTag: true,
    };
  }
  if (level === "hint") {
    return {
      background: "var(--pw-token-info-soft)",
      border: "1px solid var(--pw-token-border)",
      edgeColor: "var(--pw-token-info-text)",
      headlineColor: "var(--pw-token-info-text)",
      showAdvisoryTag: true,
    };
  }
  return {
    background: "var(--pw-token-bg-surface-raised)",
    border: "1px solid var(--pw-token-border-strong)",
    edgeColor: "var(--pw-token-success)",
    headlineColor: "var(--pw-token-text-primary)",
    showAdvisoryTag: false,
  };
}

const cardStyle: CSSProperties = { display: "grid", gap: "8px", padding: "12px 14px", borderRadius: "10px" };
const headerStyle: CSSProperties = { display: "flex", alignItems: "center", gap: "8px" };
const modeBadgeStyle: CSSProperties = {
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "11px",
  fontWeight: 700,
  background: "var(--pw-token-nav-active-bg)",
  color: "var(--pw-token-accent-text)",
  border: "1px solid var(--pw-token-nav-active-border)",
};
const advisoryTagStyle: CSSProperties = {
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--pw-token-text-muted)",
  border: "1px solid var(--pw-token-border)",
};
const dismissStyle: CSSProperties = {
  marginLeft: "auto",
  padding: "2px 8px",
  fontSize: "12px",
  background: "transparent",
  border: "none",
  color: "var(--pw-token-drag-handle-fg)",
  cursor: "pointer",
};
const headlineStyle: CSSProperties = { margin: 0, fontSize: "14px", lineHeight: 1.4, fontWeight: 700 };
const detailStyle: CSSProperties = { margin: 0, fontSize: "12px", lineHeight: 1.5, color: "var(--pw-token-text-secondary)" };
const pillRowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };

function qPillStyle(active: boolean): CSSProperties {
  return {
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "11px",
    fontWeight: 600,
    background: active ? "var(--pw-token-success-soft)" : "var(--pw-token-bg-surface)",
    color: active ? "var(--pw-token-success-text)" : "var(--pw-token-text-muted)",
    border: "1px solid var(--pw-token-border)",
  };
}

/**
 * 문제-우선 라우팅 가드 안내 카드. 입력으로 가드를 평가해 모드·권고 수준·Q1/Q2 판정을 표시한다.
 * 비차단: 어떤 수준의 권고도 저장·생성·실행을 막지 않으며, onDismiss가 주어지면 카드를 숨길 수 있다.
 */
export function ProblemFirstRoutingBanner({
  stepCount,
  hasHumanWaitOrApproval,
  hasBranchingOrParallel,
  needsMultiHopDataContext,
  onDismiss,
}: WorkflowRoutingGuardInput & { onDismiss?: () => void }): JSX.Element {
  const evaluation = evaluateWorkflowRoutingGuard({
    stepCount,
    hasHumanWaitOrApproval,
    hasBranchingOrParallel,
    needsMultiHopDataContext,
  });
  const tone = advisoryTone(evaluation.advisoryLevel);
  return (
    <section
      data-testid="problem-first-routing-banner"
      data-mode={evaluation.mode}
      data-advisory-level={evaluation.advisoryLevel}
      style={{ ...cardStyle, background: tone.background, border: tone.border, borderLeft: `3px solid ${tone.edgeColor}` }}
    >
      <div style={headerStyle}>
        <span style={modeBadgeStyle}>{MODE_LABEL_KO[evaluation.mode]}</span>
        {tone.showAdvisoryTag ? <span style={advisoryTagStyle}>비차단 권고</span> : null}
        {onDismiss ? (
          <button type="button" style={dismissStyle} aria-label="라우팅 가드 안내 숨기기" onClick={onDismiss}>
            숨기기
          </button>
        ) : null}
      </div>
      <strong style={{ ...headlineStyle, color: tone.headlineColor }}>{evaluation.headlineKo}</strong>
      <p style={detailStyle}>{evaluation.detailKo}</p>
      <div style={pillRowStyle}>
        <span style={qPillStyle(evaluation.q1StructuralControl)}>
          {`Q1 · 구조적 제어: ${evaluation.q1StructuralControl ? "예" : "아니오"}`}
        </span>
        <span style={qPillStyle(evaluation.q2MultiHopContext)}>
          {`Q2 · 다중 홉 맥락: ${evaluation.q2MultiHopContext ? "예" : "아니오"}`}
        </span>
      </div>
    </section>
  );
}
