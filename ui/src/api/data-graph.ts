// ui/src/api/data-graph.ts
//
// [파일 목적] /api/companies/:companyId/data-graph/* 클라이언트 — Two-Graph Pillar 2·3 읽기
//   전용 표면(문제-우선 그래프 모드 추천 + GraphRAG 컨텍스트 팩 빌드).
//   server/src/routes/data-graph.ts와 services/data-graph/graphrag-context-pack.ts·
//   logical-graph.ts의 계약(GraphMode·GraphRagContextPack·LogicalDataGraphResult)을 미러한다.
// [수정 주의] 읽기 전용 GET·POST — 서버 라우트에 쓰기·activity log가 없으므로 클라이언트도
//   상태 변경 계약을 추가하지 않는다. 계약 변경 시 서버 라우트·서비스와 함께 동기화.
import { api } from "./client";

/** Problem-first routing deck decision mirrored from server GraphMode. */
export type DataGraphMode = "single_agent" | "workflow_graph" | "data_graph_rag" | "two_graph";

/** Logical graph node reference mirrored from server GraphRagNodeRef. */
export interface DataGraphNodeRef {
  nodeType: string;
  nodeId: string;
}

/** Traversal node mirrored from server GraphRagNode — hop 0 means seed/root. */
export interface DataGraphNode extends DataGraphNodeRef {
  hop: number;
  label?: string;
  status?: string;
  summary?: string;
}

/** Relation edge mirrored from server GraphRagEdge — viaEdge is the evidence column. */
export interface DataGraphEdge {
  kind: string;
  from: DataGraphNodeRef;
  to: DataGraphNodeRef;
  viaEdge: string;
}

/** POST /data-graph/recommend-mode body mirrored from server RecommendGraphModeInput. */
export interface DataGraphModeRecommendationRequest {
  requiresStructuralPause?: boolean;
  requiresDeterministicBranching?: boolean;
  requiresMultiHopContext?: boolean;
  estimatedHops?: number;
}

/** recommend-mode response — rationale is display text, never execution authority. */
export interface DataGraphModeRecommendation {
  mode: DataGraphMode;
  rationale: string;
}

/** POST /data-graph/context-pack body mirrored from server BuildGraphRagContextPackInput. */
export interface DataGraphContextPackRequest {
  seed: DataGraphNodeRef;
  nodes?: DataGraphNode[];
  edges?: DataGraphEdge[];
  maxFacts?: number;
  maxChars?: number;
}

/** Provenance line mirrored from server GraphRagProvenance. */
export interface DataGraphProvenance extends DataGraphNodeRef {
  hop: number;
  viaEdge: string;
}

/** context-pack response mirrored from server GraphRagContextPack. */
export interface DataGraphContextPackResponse {
  seed: DataGraphNodeRef;
  facts: string[];
  provenance: DataGraphProvenance[];
  truncated: boolean;
  charCount: number;
}

/** GET /data-graph/query params — seed는 서버 카탈로그 어휘의 <kind>:<uuid> 문자열이다. */
export interface DataGraphQueryParams {
  seed: string;
  maxHops?: number;
  limit?: number;
  includeContextPack?: boolean;
}

/** Traversal node mirrored from server LogicalGraphNode — kind/id 어휘, hop은 0..2. */
export interface DataGraphQueryNode {
  kind: string;
  id: string;
  label?: string | null;
  status?: string | null;
  hop: number;
}

/** Traversal edge mirrored from server LogicalGraphEdge — via가 근거 컬럼이다. */
export interface DataGraphQueryEdge {
  kind: string;
  from: { kind: string; id: string };
  to: { kind: string; id: string };
  via: string;
}

/** query response mirrored from server LogicalDataGraphResult + optional context pack. */
export interface DataGraphQueryResponse {
  seed: { kind: string; id: string };
  nodes: DataGraphQueryNode[];
  edges: DataGraphQueryEdge[];
  truncated: boolean;
  contextPack?: DataGraphContextPackResponse;
}

export const dataGraphApi = {
  recommendMode: (companyId: string, payload: DataGraphModeRecommendationRequest) =>
    api.post<DataGraphModeRecommendation>(
      `/companies/${encodeURIComponent(companyId)}/data-graph/recommend-mode`,
      payload,
    ),
  buildContextPack: (companyId: string, payload: DataGraphContextPackRequest) =>
    api.post<DataGraphContextPackResponse>(
      `/companies/${encodeURIComponent(companyId)}/data-graph/context-pack`,
      payload,
    ),
  // GET query — URLSearchParams가 seed·옵션을 폼 인코딩하며 includeContextPack은
  //   서버 z.enum(["true","false"]) 계약에 맞춰 문자열화한다. 읽기 전용.
  queryDataGraph: (companyId: string, params: DataGraphQueryParams) => {
    const searchParams = new URLSearchParams();
    searchParams.set("seed", params.seed);
    if (params.maxHops !== undefined) searchParams.set("maxHops", String(params.maxHops));
    if (params.limit !== undefined) searchParams.set("limit", String(params.limit));
    if (params.includeContextPack !== undefined) {
      searchParams.set("includeContextPack", String(params.includeContextPack));
    }
    return api.get<DataGraphQueryResponse>(
      `/companies/${encodeURIComponent(companyId)}/data-graph/query?${searchParams.toString()}`,
    );
  },
};
