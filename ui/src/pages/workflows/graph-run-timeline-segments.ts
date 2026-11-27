// Pure segment computation for the workflow run timeline (Pillar 1).
// Reads the existing graph run overlay fields and derives the North Star
// reading order: parallel wave -> join -> human wait (paused) -> resumed
// continuation. No server contract change; presentation lives in
// GraphRunTimeline.tsx.

import { resolveNodeLogicalClass, type WorkflowNodeLogicalClass } from "./graph-editor/node-logical-class.js";
import {
  buildWorkflowGraphModel,
  type WorkflowGraphRunStatus,
  type WorkflowGraphStep,
} from "./workflow-graph.js";

export type GraphRunTimelineSegment =
  | { kind: "step"; layer: number; stepId: string }
  | { kind: "parallel"; layer: number; stepIds: string[] }
  | { kind: "join"; layer: number; stepId: string; inboundStepIds: string[] }
  | {
      kind: "human_wait";
      layer: number;
      stepId: string;
      stepRunId: string;
      decisionId: string | null;
      pausedAt: string | null;
      resolvedAt: string | null;
      outcome: string | null;
    }
  | { kind: "resume"; layer: number; stepIds: string[]; afterStepId: string };

export type GraphRunTimelineStepInfo = {
  stepId: string;
  title: string;
  logicalClass: WorkflowNodeLogicalClass;
  status: WorkflowGraphRunStatus;
  startedAt: string;
  completedAt: string;
};

// Server step-run decision overlay (read-only display metadata; see
// server/src/services/workflow/step-run-decision-overlay.ts). Optional on
// timeline step inputs; mapped into the human_wait segment fields below.
export type GraphRunTimelineHumanWaitDecision = {
  decisionId: string;
  status: string;
  pausedAt: string | null;
  resolvedAt: string | null;
};

export type GraphRunTimelineStepInput<TStep extends WorkflowGraphStep = WorkflowGraphStep> = TStep & {
  humanWaitDecision?: GraphRunTimelineHumanWaitDecision;
};

function readHumanWaitDecisionOverlay(step: unknown): GraphRunTimelineHumanWaitDecision | null {
  if (!step || typeof step !== "object") return null;
  const overlay = (step as Record<string, unknown>).humanWaitDecision;
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return null;
  const record = overlay as Record<string, unknown>;
  const decisionId = typeof record.decisionId === "string" ? record.decisionId.trim() : "";
  const status = typeof record.status === "string" ? record.status.trim() : "";
  const pausedAt = typeof record.pausedAt === "string" ? record.pausedAt.trim() : "";
  const resolvedAt = typeof record.resolvedAt === "string" ? record.resolvedAt.trim() : "";
  if (!decisionId && !status && !pausedAt && !resolvedAt) return null;
  return { decisionId, status, pausedAt: pausedAt || null, resolvedAt: resolvedAt || null };
}

export function buildGraphRunTimelineSegments<TStep extends WorkflowGraphStep>(
  steps: GraphRunTimelineStepInput<TStep>[],
): GraphRunTimelineSegment[] {
  const graph = buildWorkflowGraphModel(steps);
  const inboundByStepId = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const inbound = inboundByStepId.get(edge.target) ?? [];
    inbound.push(edge.source);
    inboundByStepId.set(edge.target, inbound);
  }
  const nodesByLayer = new Map<number, typeof graph.nodes>();
  for (const node of graph.nodes) {
    const bucket = nodesByLayer.get(node.layer) ?? [];
    bucket.push(node);
    nodesByLayer.set(node.layer, bucket);
  }

  const segments: GraphRunTimelineSegment[] = [];
  for (const layer of Array.from(nodesByLayer.keys()).sort((a, b) => a - b)) {
    const layerNodes = nodesByLayer.get(layer) ?? [];
    if (layerNodes.length > 1) {
      segments.push({ kind: "parallel", layer, stepIds: layerNodes.map((node) => node.step.id.trim()) });
      continue;
    }
    const node = layerNodes[0];
    if (!node) continue;
    const stepId = node.step.id.trim();
    if (resolveNodeLogicalClass(node.step) === "human_wait") {
      const record = node.step as Record<string, unknown>;
      const overlay = readHumanWaitDecisionOverlay(node.step);
      const legacyDecisionId = typeof record.graphRunDecisionId === "string" ? record.graphRunDecisionId.trim() : "";
      segments.push({
        kind: "human_wait",
        layer,
        stepId,
        stepRunId: node.runStatus.stepRunId,
        decisionId: overlay?.decisionId || legacyDecisionId || null,
        pausedAt: overlay?.pausedAt || node.runStatus.startedAt || node.runStatus.updatedAt || null,
        resolvedAt: overlay?.resolvedAt || node.runStatus.completedAt || null,
        outcome: overlay?.status || node.runStatus.controlOutcome || null,
      });
      continue;
    }
    const inboundStepIds = inboundByStepId.get(stepId) ?? [];
    if (inboundStepIds.length >= 2) {
      segments.push({ kind: "join", layer, stepId, inboundStepIds });
      continue;
    }
    segments.push({ kind: "step", layer, stepId });
  }

  const result: GraphRunTimelineSegment[] = [];
  let afterWaitStepId = "";
  let waitDownstream = new Set<string>();
  for (const segment of segments) {
    if (segment.kind === "human_wait") {
      afterWaitStepId = segment.stepId;
      waitDownstream = collectDownstreamStepIds(graph.edges, segment.stepId);
      result.push(segment);
      continue;
    }
    if ((segment.kind === "step" || segment.kind === "parallel") && afterWaitStepId && waitDownstream.size > 0) {
      const memberIds = segment.kind === "step" ? [segment.stepId] : segment.stepIds;
      if (memberIds.length > 0 && memberIds.every((id) => waitDownstream.has(id))) {
        result.push({ kind: "resume", layer: segment.layer, stepIds: memberIds, afterStepId: afterWaitStepId });
        continue;
      }
    }
    result.push(segment);
  }
  return result;
}

export function buildGraphRunTimelineStepInfo<TStep extends WorkflowGraphStep>(
  steps: TStep[],
): Map<string, GraphRunTimelineStepInfo> {
  const graph = buildWorkflowGraphModel(steps);
  const infoByStepId = new Map<string, GraphRunTimelineStepInfo>();
  for (const node of graph.nodes) {
    const stepId = node.step.id.trim();
    if (!stepId || infoByStepId.has(stepId)) continue;
    infoByStepId.set(stepId, {
      stepId,
      title: node.label,
      logicalClass: resolveNodeLogicalClass(node.step),
      status: node.runStatus.status,
      startedAt: node.runStatus.startedAt,
      completedAt: node.runStatus.completedAt,
    });
  }
  return infoByStepId;
}

export function formatGraphRunStepDuration(startedAt: string, completedAt: string): string {
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) return "";
  const totalSeconds = (completedMs - startedMs) / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function segmentStepIds(segment: GraphRunTimelineSegment): string[] {
  switch (segment.kind) {
    case "step":
    case "join":
    case "human_wait":
      return [segment.stepId];
    case "parallel":
    case "resume":
      return segment.stepIds;
  }
}

function collectDownstreamStepIds(edges: Array<{ source: string; target: string }>, stepId: string): Set<string> {
  const outgoingByStepId = new Map<string, string[]>();
  for (const edge of edges) {
    const outgoing = outgoingByStepId.get(edge.source) ?? [];
    outgoing.push(edge.target);
    outgoingByStepId.set(edge.source, outgoing);
  }
  const downstream = new Set<string>();
  const queue = [...(outgoingByStepId.get(stepId) ?? [])];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || downstream.has(current)) continue;
    downstream.add(current);
    queue.push(...(outgoingByStepId.get(current) ?? []));
  }
  return downstream;
}
