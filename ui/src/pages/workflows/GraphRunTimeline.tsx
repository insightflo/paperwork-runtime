// Vertical segmented execution timeline for a workflow run overlay (Pillar 1).
// Renders segments computed by graph-run-timeline-segments.ts in the North
// Star reading order: parallel wave -> join -> human wait (paused, awaiting
// approval) -> resumed continuation, with logical class badges and durations.
// Styling uses Paperwork semantic tokens only — zero raw hex literals.

import { useMemo, type CSSProperties, type JSX } from "react";
import {
  nodeLogicalClassBadgeLabel,
  nodeLogicalClassBadgeStyle,
} from "./graph-editor/node-logical-class.js";
import {
  buildGraphRunTimelineSegments,
  buildGraphRunTimelineStepInfo,
  formatGraphRunStepDuration,
  segmentStepIds,
  type GraphRunTimelineSegment,
} from "./graph-run-timeline-segments.js";
import { type WorkflowGraphStep } from "./workflow-graph.js";
import { mutedTextStyle, statusBadgeStyle } from "./workflow-page-styles.js";

const SEGMENT_KIND_LABELS: Record<GraphRunTimelineSegment["kind"], string> = {
  step: "Step",
  parallel: "Parallel wave",
  join: "Join",
  human_wait: "Human wait",
  resume: "Resumed continuation",
};

// Paperwork semantic tokens only — zero raw hex literals (brief standard).
const SEGMENT_ACCENTS: Record<GraphRunTimelineSegment["kind"], { dot: string; soft?: string }> = {
  step: { dot: "var(--pw-hairline-strong)" },
  parallel: { dot: "var(--pw-cobalt)" },
  join: { dot: "var(--pw-muted)" },
  human_wait: { dot: "var(--pw-amber)", soft: "var(--pw-amber-soft)" },
  resume: { dot: "var(--pw-lime)", soft: "var(--pw-lime-soft)" },
};

// Human wait decision display state. Derived only from the read-only decision
// overlay outcome for display; the human-wait gate remains the execution
// authority (fail-closed server side).
type HumanWaitDecisionState = "pending" | "approved" | "rejected" | "expired";

type HumanWaitTimelineSegment = Extract<GraphRunTimelineSegment, { kind: "human_wait" }>;

function humanWaitDecisionStateOf(segment: HumanWaitTimelineSegment): HumanWaitDecisionState {
  const outcome = (segment.outcome ?? "").trim().toLowerCase();
  if (outcome === "approved") return "approved";
  if (outcome === "rejected") return "rejected";
  if (outcome === "expired") return "expired";
  return "pending";
}

const HUMAN_WAIT_STATE_ACCENTS: Record<HumanWaitDecisionState, { dot: string; soft: string; text: string; label: string }> = {
  pending: { dot: "var(--pw-amber)", soft: "var(--pw-amber-soft)", text: "var(--pw-amber)", label: "Paused · awaiting approval" },
  approved: { dot: "var(--pw-emerald)", soft: "var(--pw-lime-soft)", text: "var(--pw-emerald)", label: "Approved · resumed" },
  rejected: { dot: "var(--pw-crimson)", soft: "var(--pw-crimson-soft)", text: "var(--pw-crimson)", label: "Rejected · halted" },
  expired: { dot: "var(--pw-crimson)", soft: "var(--pw-crimson-soft)", text: "var(--pw-crimson)", label: "Expired · halted" },
};

function humanWaitIndicatorText(segment: HumanWaitTimelineSegment, state: HumanWaitDecisionState): string {
  if (state !== "pending") return HUMAN_WAIT_STATE_ACCENTS[state].label;
  if (segment.resolvedAt && segment.outcome) return `Resolved · ${segment.outcome}`;
  return HUMAN_WAIT_STATE_ACCENTS.pending.label;
}

function shortDecisionId(decisionId: string): string {
  return decisionId.length > 12 ? `${decisionId.slice(0, 12)}…` : decisionId;
}

function segmentMetaText(segment: GraphRunTimelineSegment, titleOf: (stepId: string) => string): string {
  switch (segment.kind) {
    case "parallel":
      return `${segment.stepIds.length} steps`;
    case "join":
      return `merges ${segment.inboundStepIds.map(titleOf).join(", ")}`;
    case "human_wait":
      return segment.decisionId ? "" : "decision pending";
    case "resume":
      return `after ${titleOf(segment.afterStepId)}`;
    default:
      return "";
  }
}

const timelineContainerStyle: CSSProperties = {
  border: "var(--pw-hairline-width, 1px) solid var(--pw-hairline)",
  borderRadius: "10px",
  background: "var(--pw-card)",
  padding: "12px",
  display: "grid",
  gap: "10px",
};

const timelineListStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "2px",
};

const segmentKindLabelStyle: CSSProperties = {
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--pw-muted)",
};

const stepRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  flexWrap: "wrap",
  marginTop: "4px",
};

const stepTitleStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 700,
  color: "var(--pw-ink)",
  overflowWrap: "anywhere",
};

const durationStyle: CSSProperties = {
  ...mutedTextStyle,
  fontSize: "11px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const decisionPillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  color: "var(--pw-muted)",
  background: "var(--pw-panel)",
  border: "var(--pw-hairline-width, 1px) solid var(--pw-hairline)",
  borderRadius: "999px",
  padding: "1px 8px",
  fontSize: "10px",
  fontWeight: 700,
  lineHeight: 1.4,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  whiteSpace: "nowrap",
};

export function GraphRunTimeline({ steps }: { steps: WorkflowGraphStep[] }): JSX.Element | null {
  const segments = useMemo(() => buildGraphRunTimelineSegments(steps), [steps]);
  const infoByStepId = useMemo(() => buildGraphRunTimelineStepInfo(steps), [steps]);
  if (steps.length === 0 || segments.length === 0) return null;
  const titleOf = (stepId: string): string => infoByStepId.get(stepId)?.title || stepId;

  return (
    <div data-graph-run-timeline="true" style={timelineContainerStyle}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px" }}>
        <span style={{ ...mutedTextStyle, fontWeight: 600 }}>Run timeline</span>
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{segments.length} segments</span>
      </div>
      <ol style={timelineListStyle}>
        {segments.map((segment, index) => {
          const waitState = segment.kind === "human_wait" ? humanWaitDecisionStateOf(segment) : null;
          const waitText = waitState && segment.kind === "human_wait" ? humanWaitIndicatorText(segment, waitState) : "";
          const accent = waitState ? HUMAN_WAIT_STATE_ACCENTS[waitState] : SEGMENT_ACCENTS[segment.kind];
          const meta = segmentMetaText(segment, titleOf);
          return (
            <li
              key={`${segment.kind}:${index}`}
              data-timeline-segment={segment.kind}
              style={{ display: "grid", gridTemplateColumns: "12px 1fr", gap: "10px", alignItems: "stretch" }}
            >
              <span aria-hidden="true" style={{ display: "flex", justifyContent: "center", paddingTop: "5px" }}>
                <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: accent.dot }} />
              </span>
              <div
                style={{
                  borderLeft: "2px solid var(--pw-hairline)",
                  paddingLeft: "12px",
                  paddingBottom: index === segments.length - 1 ? 0 : "10px",
                }}
              >
                <div style={accent.soft ? { background: accent.soft, borderRadius: "8px", padding: "8px 10px" } : undefined}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" }}>
                    <span style={segmentKindLabelStyle}>{SEGMENT_KIND_LABELS[segment.kind]}</span>
                    {segment.kind === "human_wait" && segment.decisionId ? (
                      <span data-decision-id-pill="true" style={decisionPillStyle}>#{shortDecisionId(segment.decisionId)}</span>
                    ) : meta ? <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{meta}</span> : null}
                  </div>
                  {segmentStepIds(segment).map((stepId) => {
                    const info = infoByStepId.get(stepId);
                    const badgeLabel = nodeLogicalClassBadgeLabel(info?.logicalClass ?? "ai_agent");
                    const duration = info ? formatGraphRunStepDuration(info.startedAt, info.completedAt) : "";
                    return (
                      <div key={stepId} data-timeline-step={stepId} style={stepRowStyle}>
                        <span style={stepTitleStyle}>{info?.title || stepId}</span>
                        <span
                          data-node-logical-class={info?.logicalClass ?? "ai_agent"}
                          style={nodeLogicalClassBadgeStyle[info?.logicalClass ?? "ai_agent"]}
                        >
                          {badgeLabel}
                        </span>
                        {info ? (
                          <span style={{ ...statusBadgeStyle(info.status), fontSize: "10px" }}>{info.status}</span>
                        ) : null}
                        {duration ? <span style={durationStyle}>{duration}</span> : null}
                      </div>
                    );
                  })}
                  {waitState ? (
                    <div style={stepRowStyle}>
                      <span
                        data-pause-indicator="true"
                        data-wait-state={waitState}
                        style={{ fontSize: "11px", fontWeight: 700, color: HUMAN_WAIT_STATE_ACCENTS[waitState].text }}
                      >
                        {waitText}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
