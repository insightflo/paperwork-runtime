// server/src/services/data-graph/logical-graph-catalog.ts
//
// [파일 목적] PostgreSQL 논리 데이터 그래프(s26-two-graph-architecture §2.1~2.2)의 공개
//   타입 어휘와 엣지 카탈로그. 기존 테이블의 FK/jsonb/배열 컬럼에만 근거를 두며 새
//   테이블·물리 엣지 테이블·뷰를 만들지 않는다. traversal 엔진(logical-graph.ts)이 이
//   카탈로그를 선언 순서대로 읽어 hop별로 확장한다.
// [수정 주의] 엣지 엔트리의 kind는 logical-graph.ts edgeSpec의 질의 분기와 1:1로 연결되고
//   fromKind/toKind/bidirectional은 양방향 탐색 방향을 결정한다. 엔트리를 추가·삭제하면
//   edgeSpec 분기와 카탈로그 정렬 단위 테스트(logical-graph.test.ts)를 함께 갱신한다.

export type LogicalGraphNodeKind =
  | "mission" | "issue" | "work_product" | "decision"
  | "run" | "workflow_run" | "step_run" | "knowledge_node";

export type LogicalGraphEdgeKind =
  | "mission_issue" | "issue_parent" | "issue_work_product" | "issue_run"
  | "work_product_run" | "run_retry" | "run_step_run" | "workflow_run_mission"
  | "workflow_run_parent" | "step_run_issue" | "step_run_workflow_run"
  | "decision_issue" | "decision_workflow_run" | "knowledge_source" | "knowledge_link";

export type LogicalGraphEdgeMeta = {
  readonly kind: LogicalGraphEdgeKind;
  readonly fromKind: LogicalGraphNodeKind;
  readonly toKind: LogicalGraphNodeKind;
  /** 관계의 근거 컬럼(§2.1) — jsonb/배열 근거는 읽는 경로를 그대로 표기한다. */
  readonly viaColumn: string;
  /** toKind 쪽 frontier에서 fromKind를 역방향 탐색 가능한지(knowledge_source는 단방향). */
  readonly bidirectional: boolean;
};

/** 기존 컬럼에만 근거를 둔 논리 엣지 카탈로그 — 새 물리 관계 없음(SPEC §2.1). */
export const LOGICAL_DATA_GRAPH_EDGES: readonly LogicalGraphEdgeMeta[] = [
  { kind: "mission_issue", fromKind: "mission", toKind: "issue", viaColumn: "issues.mission_id", bidirectional: true },
  { kind: "issue_parent", fromKind: "issue", toKind: "issue", viaColumn: "issues.parent_id", bidirectional: true },
  { kind: "issue_work_product", fromKind: "issue", toKind: "work_product", viaColumn: "issue_work_products.issue_id", bidirectional: true },
  { kind: "issue_run", fromKind: "issue", toKind: "run", viaColumn: "issues.checkout_run_id,issues.execution_run_id", bidirectional: true },
  { kind: "work_product_run", fromKind: "work_product", toKind: "run", viaColumn: "issue_work_products.created_by_run_id", bidirectional: true },
  { kind: "run_retry", fromKind: "run", toKind: "run", viaColumn: "heartbeat_runs.retry_of_run_id", bidirectional: true },
  { kind: "run_step_run", fromKind: "run", toKind: "step_run", viaColumn: "heartbeat_runs.workflow_step_run_id", bidirectional: true },
  { kind: "workflow_run_mission", fromKind: "workflow_run", toKind: "mission", viaColumn: "workflow_runs.mission_id", bidirectional: true },
  { kind: "workflow_run_parent", fromKind: "workflow_run", toKind: "workflow_run", viaColumn: "workflow_runs.parent_run_id", bidirectional: true },
  { kind: "step_run_issue", fromKind: "step_run", toKind: "issue", viaColumn: "workflow_step_runs.issue_id", bidirectional: true },
  { kind: "step_run_workflow_run", fromKind: "step_run", toKind: "workflow_run", viaColumn: "workflow_step_runs.workflow_run_id", bidirectional: true },
  { kind: "decision_issue", fromKind: "decision", toKind: "issue", viaColumn: "operator_decisions.issue_id", bidirectional: true },
  { kind: "decision_workflow_run", fromKind: "decision", toKind: "workflow_run", viaColumn: "operator_decisions.source_context->>'workflowRunId'", bidirectional: true },
  { kind: "knowledge_source", fromKind: "knowledge_node", toKind: "mission", viaColumn: "knowledge_nodes.source_refs(type=mission,id)", bidirectional: false },
  { kind: "knowledge_source", fromKind: "knowledge_node", toKind: "issue", viaColumn: "knowledge_nodes.source_refs(type=issue,id)", bidirectional: false },
  { kind: "knowledge_link", fromKind: "knowledge_node", toKind: "knowledge_node", viaColumn: "knowledge_nodes.linked_node_ids", bidirectional: true },
];

export type LogicalGraphNode = { kind: LogicalGraphNodeKind; id: string; label: string | null; status: string | null; hop: 0 | 1 | 2 };
export type LogicalGraphEdge = { kind: LogicalGraphEdgeKind; from: { kind: LogicalGraphNodeKind; id: string }; to: { kind: LogicalGraphNodeKind; id: string }; via: string };
export type LogicalDataGraphResult = { seed: { kind: LogicalGraphNodeKind; id: string }; nodes: LogicalGraphNode[]; edges: LogicalGraphEdge[]; truncated: boolean };
export type QueryLogicalDataGraphParams = { companyId: string; seedKind: LogicalGraphNodeKind; seedId: string; maxHops?: number; limit?: number };
