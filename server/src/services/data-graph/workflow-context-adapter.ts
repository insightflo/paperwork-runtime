// server/src/services/data-graph/workflow-context-adapter.ts
//
// [파일 목적] Two-Graph thin bridge(§2.3) — queryLogicalDataGraph(Pillar 2 traversal) 결과를
//   buildGraphRagContextPack(출처 인용 팩)에 연결해 워크플로 스텝 프롬프트에 주입 가능한
//   bounded 마크다운 블록으로 직렬화한다. 읽기 전용이며 라우트·스키마·실행 제어를 바꾸지 않는다.
// [불변식] zero prompt bloat: 그래프 노드가 0이거나 팩 fact가 0이면 markdown="" 반환. bounded:
//   fact는 팩 불변식(maxChars 안의 온전한 라인, 부분 절단 없음)을 따르고 헤더·불릿 여유를
//   예산에서 미리 뺀다. Sources 출처 행은 남은 예산 안에서만 통째로 추가한다. 비밀 가림은 팩의
//   sanitize를 통과한 결과만 렌더링하며 어댑터가 원문을 재노출하지 않는다.
// [소비] 워크플로 스텝 프롬프트 컨텍스트 주입(호출부는 반환 마크다운을 표시용으로만 사용).

import { buildGraphRagContextPack, DEFAULT_MAX_CHARS, DEFAULT_MAX_FACTS,
  type GraphRagEdge, type GraphRagNode, type GraphRagProvenance } from "./graphrag-context-pack.js";
import { queryLogicalDataGraph, type LogicalGraphNodeKind } from "./logical-graph.js";
import type { Db } from "@paperclipai/db";

export type WorkflowStepGraphContextOptions = {
  companyId: string;
  seedKind: LogicalGraphNodeKind;
  seedId: string;
  maxHops?: number;
  maxFacts?: number;
  maxChars?: number;
};

export type WorkflowStepGraphContext = {
  markdown: string;
  factCount: number;
  truncated: boolean;
  provenanceCount: number;
};

const CONTEXT_HEADER = "### Related Context (Data Graph · 2-hop)\n\n";
/** fact당 불릿+개행 마크업 오버헤드("- " 접두, 줄바꿈). */
const PER_FACT_MARKUP_CHARS = 3;
const SOURCES_LABEL = "\n\nSources: ";
const SOURCES_SEPARATOR = "; ";

const EMPTY_CONTEXT: WorkflowStepGraphContext = { markdown: "", factCount: 0, truncated: false, provenanceCount: 0 };

const renderSource = (entry: GraphRagProvenance): string =>
  `${entry.nodeType}:${entry.nodeId} (hop ${entry.hop}, via ${entry.viaEdge})`;

/**
 * 워크플로 스텝용 데이터 그래프 컨텍스트 블록을 만든다. seed 행이 없어 그래프가 비거나
 * 예산 때문에 fact가 하나도 못 들면 빈 계약을 반환해 프롬프트를 늘리지 않는다.
 */
export async function buildWorkflowStepGraphContext(
  db: Db,
  options: WorkflowStepGraphContextOptions,
): Promise<WorkflowStepGraphContext> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxFacts = options.maxFacts ?? DEFAULT_MAX_FACTS;
  // 헤더와 불릿 마크업까지 포함해 최종 마크다운이 maxChars 안에 머물도록 fact 예산을 줄인다.
  const factsBudget = Math.max(1, maxChars - CONTEXT_HEADER.length - PER_FACT_MARKUP_CHARS * maxFacts);

  const graph = await queryLogicalDataGraph(db, {
    companyId: options.companyId,
    seedKind: options.seedKind,
    seedId: options.seedId,
    maxHops: options.maxHops,
  });
  if (graph.nodes.length === 0) return EMPTY_CONTEXT;

  const nodes: GraphRagNode[] = graph.nodes.map((node) => ({
    nodeType: node.kind,
    nodeId: node.id,
    hop: node.hop,
    label: node.label ?? undefined,
    status: node.status ?? undefined,
  }));
  const edges: GraphRagEdge[] = graph.edges.map((edge) => ({
    kind: edge.kind,
    from: { nodeType: edge.from.kind, nodeId: edge.from.id },
    to: { nodeType: edge.to.kind, nodeId: edge.to.id },
    viaEdge: edge.via,
  }));
  const pack = buildGraphRagContextPack({
    seed: { nodeType: graph.seed.kind, nodeId: graph.seed.id },
    nodes,
    edges,
    maxFacts,
    maxChars: factsBudget,
  });
  if (pack.facts.length === 0) return EMPTY_CONTEXT;

  const body = pack.facts.map((fact) => `- ${fact}`).join("\n");
  let markdown = CONTEXT_HEADER + body;
  // Sources는 남은 예산 안에서만 온전한 항목 단위로 추가한다(부분 절단 금지).
  const sources: string[] = [];
  for (const entry of pack.provenance) {
    const part = renderSource(entry);
    const candidate = sources.length === 0 ? markdown + SOURCES_LABEL + part : markdown + SOURCES_SEPARATOR + part;
    if (candidate.length > maxChars) break;
    sources.push(part);
    markdown = candidate;
  }
  return {
    markdown,
    factCount: pack.facts.length,
    truncated: pack.truncated || sources.length < pack.provenance.length,
    provenanceCount: sources.length,
  };
}
