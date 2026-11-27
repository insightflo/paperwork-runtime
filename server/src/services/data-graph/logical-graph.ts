// server/src/services/data-graph/logical-graph.ts
//
// [파일 목적] PostgreSQL 논리 데이터 그래프(s26-two-graph-architecture §2.1~2.2)의 bounded
//   2-hop traversal 질의기. 공개 타입·엣지 카탈로그는 logical-graph-catalog.ts가 소유하고
//   여기서 재노출한다. 기존 테이블의 FK/jsonb/배열 컬럼을 논리
//   관계로 읽는 read-only 순수 서비스다. 새 테이블·물리 엣지 테이블·뷰를 만들지 않는다.
// [불변식] 모든 질의에 eq(table.companyId, companyId)를 강제한다(유일 예외인
//   workflow_step_runs는 companyId 컬럼이 없어 workflow_runs.companyId innerJoin으로 동일
//   강제). maxHops≤2, limit(반환 노드 수, seed 포함)≤100 하드 클램프, 질의별 LIMIT로
//   비용 유한. 엣지는 카탈로그 방향(fromKind→toKind)으로 저장하고 frontier가 어느 쪽이든
//   역방향 질의로 양방향 탐색한다(knowledge_source는 spec 정의상 단방향). 로더 결과는
//   id 정렬 + (kind,id) 중복 제거로 결정론적이다. seed 회사 불일치 시 빈 결과.
// [소비] 워크플로 노드→데이터 그래프 컨텍스트 질의(thin bridge)와 향후 GraphRAG 컨텍스트
//   팩의 2-hop 확장기. 라우트·스키마 변경 없음.

import { and, arrayContains, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  heartbeatRuns, issueWorkProducts, issues, knowledgeNodes, missions,
  operatorDecisions, workflowRuns, workflowStepRuns,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

import {
  LOGICAL_DATA_GRAPH_EDGES,
  type LogicalDataGraphResult, type LogicalGraphEdge, type LogicalGraphEdgeMeta,
  type LogicalGraphNode, type LogicalGraphNodeKind, type QueryLogicalDataGraphParams,
} from "./logical-graph-catalog.js";

// 공개 타입·엣지 카탈로그는 logical-graph-catalog.ts가 소유한다. 여기서 재노출해
// 기존 import 경로(../services/data-graph/logical-graph.js)를 그대로 유지한다.
export * from "./logical-graph-catalog.js";

export const LOGICAL_GRAPH_MAX_HOPS = 2;
export const LOGICAL_GRAPH_DEFAULT_LIMIT = 50;
export const LOGICAL_GRAPH_MAX_LIMIT = 100;

/** 반드시 1..2로 고정한다(undefined·비정수·범위 밖 입력 포함). */
export function clampLogicalGraphMaxHops(value?: number): 1 | 2 {
  if (value === undefined || !Number.isFinite(value)) return LOGICAL_GRAPH_MAX_HOPS as 1 | 2;
  return Math.min(LOGICAL_GRAPH_MAX_HOPS, Math.max(1, Math.trunc(value))) as 1 | 2;
}

/** 기본 50, 하한 1, 상한 100 — 반환 노드 수(seed 포함) 상한. */
export function clampLogicalGraphLimit(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) return LOGICAL_GRAPH_DEFAULT_LIMIT;
  return Math.min(LOGICAL_GRAPH_MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

type MissionRow = { id: string; companyId: string; title: string; status: string };
type IssueRow = { id: string; companyId: string; title: string; status: string; missionId: string | null; parentId: string | null; checkoutRunId: string | null; executionRunId: string | null };
type WorkProductRow = { id: string; companyId: string; issueId: string; title: string; status: string; createdByRunId: string | null };
type DecisionRow = { id: string; companyId: string; title: string; status: string; issueId: string | null; sourceContext: { workflowRunId?: string | null } };
type RunRow = { id: string; companyId: string; status: string; workflowStepRunId: string | null; retryOfRunId: string | null };
type WorkflowRunRow = { id: string; companyId: string; status: string; missionId: string | null; parentRunId: string | null };
type StepRunRow = { id: string; workflowRunId: string; issueId: string | null; status: string };
type KnowledgeRow = { id: string; companyId: string; title: string; status: string; linkedNodeIds: string[]; sourceRefs: ReadonlyArray<{ type: string; id?: string | null }> };

type AnyRow = MissionRow | IssueRow | WorkProductRow | DecisionRow | RunRow | WorkflowRunRow | StepRunRow | KnowledgeRow;
type NodeRef = { kind: LogicalGraphNodeKind; id: string };
type FrontierEntry = { ref: NodeRef; row: AnyRow };
type Discovered = { meta: LogicalGraphEdgeMeta; from: NodeRef; to: NodeRef; row: AnyRow };
type Ctx = { db: Db; companyId: string; perQueryCap: number; nodes: Map<string, LogicalGraphNode>; edges: Map<string, LogicalGraphEdge> };

const nodeKey = (ref: NodeRef) => `${ref.kind}:${ref.id}`;
const edgeKey = (d: Discovered) => `${d.meta.kind}:${d.from.id}:${d.to.id}`;
const toNode = (kind: LogicalGraphNodeKind, row: AnyRow, hop: 0 | 1 | 2): LogicalGraphNode =>
  ({ kind, id: row.id, label: "title" in row ? row.title : null, status: "status" in row ? row.status : null, hop });

const fetchRows = async <T extends { id: string }>(ctx: Ctx, query: Promise<T[]>): Promise<T[]> =>
  (await query).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const fetchMissions = (ctx: Ctx, extra: SQL | undefined) => fetchRows(ctx, ctx.db
  .select({ id: missions.id, companyId: missions.companyId, title: missions.title, status: missions.status })
  .from(missions).where(and(eq(missions.companyId, ctx.companyId), extra)).limit(ctx.perQueryCap));

const fetchIssues = (ctx: Ctx, extra: SQL | undefined) => fetchRows(ctx, ctx.db
  .select({ id: issues.id, companyId: issues.companyId, title: issues.title, status: issues.status, missionId: issues.missionId, parentId: issues.parentId, checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
  .from(issues).where(and(eq(issues.companyId, ctx.companyId), extra)).limit(ctx.perQueryCap));

const fetchWorkProducts = (ctx: Ctx, extra: SQL | undefined) => fetchRows(ctx, ctx.db
  .select({ id: issueWorkProducts.id, companyId: issueWorkProducts.companyId, issueId: issueWorkProducts.issueId, title: issueWorkProducts.title, status: issueWorkProducts.status, createdByRunId: issueWorkProducts.createdByRunId })
  .from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, ctx.companyId), extra)).limit(ctx.perQueryCap));

const fetchDecisions = (ctx: Ctx, extra: SQL | undefined) => fetchRows(ctx, ctx.db
  .select({ id: operatorDecisions.id, companyId: operatorDecisions.companyId, title: operatorDecisions.title, status: operatorDecisions.status, issueId: operatorDecisions.issueId, sourceContext: operatorDecisions.sourceContext })
  .from(operatorDecisions).where(and(eq(operatorDecisions.companyId, ctx.companyId), extra)).limit(ctx.perQueryCap));

const fetchRuns = (ctx: Ctx, extra: SQL | undefined) => fetchRows(ctx, ctx.db
  .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, status: heartbeatRuns.status, workflowStepRunId: heartbeatRuns.workflowStepRunId, retryOfRunId: heartbeatRuns.retryOfRunId })
  .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, ctx.companyId), extra)).limit(ctx.perQueryCap));

const fetchWorkflowRuns = (ctx: Ctx, extra: SQL | undefined) => fetchRows(ctx, ctx.db
  .select({ id: workflowRuns.id, companyId: workflowRuns.companyId, status: workflowRuns.status, missionId: workflowRuns.missionId, parentRunId: workflowRuns.parentRunId })
  .from(workflowRuns).where(and(eq(workflowRuns.companyId, ctx.companyId), extra)).limit(ctx.perQueryCap));

/** workflow_step_runs는 companyId 컬럼이 없다 → workflow_runs.companyId innerJoin으로 강제. */
const fetchStepRuns = (ctx: Ctx, extra: SQL | undefined) => fetchRows(ctx, ctx.db
  .select({ id: workflowStepRuns.id, workflowRunId: workflowStepRuns.workflowRunId, issueId: workflowStepRuns.issueId, status: workflowStepRuns.status })
  .from(workflowStepRuns)
  .innerJoin(workflowRuns, and(eq(workflowStepRuns.workflowRunId, workflowRuns.id), eq(workflowRuns.companyId, ctx.companyId)))
  .where(extra).limit(ctx.perQueryCap));

const fetchKnowledge = (ctx: Ctx, extra: SQL | undefined) => fetchRows(ctx, ctx.db
  .select({ id: knowledgeNodes.id, companyId: knowledgeNodes.companyId, title: knowledgeNodes.title, status: knowledgeNodes.status, linkedNodeIds: knowledgeNodes.linkedNodeIds, sourceRefs: knowledgeNodes.sourceRefs })
  .from(knowledgeNodes).where(and(eq(knowledgeNodes.companyId, ctx.companyId), extra)).limit(ctx.perQueryCap));

// ── 단일 FK/jsonb 엣지의 양방향 확장 ──────────────────────────────────────────

/** FK 컬럼을 직접 갖는 테이블(T) 행과 피참조 테이블(O) 행을 잇는 질의 스펙(jsonb/배열 근거도 동일 인터페이스). */
type FkEdgeSpec = {
  fkOf: (row: AnyRow) => string | null;
  fetchTByFk: (otherIds: string[]) => Promise<AnyRow[]>;
  fetchOByIds: (ids: string[]) => Promise<AnyRow[]>;
  /** FK 테이블이 카탈로그 fromKind인지(대부분 true; mission_issue·issue_work_product는 false). */
  fkOnFrom: boolean;
};

function groupByFk<T>(entries: T[], keyOf: (entry: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (key === null) continue;
    map.set(key, [...(map.get(key) ?? []), entry]);
  }
  return map;
}

async function expandFkEdge(ctx: Ctx, meta: LogicalGraphEdgeMeta, spec: FkEdgeSpec, entries: FrontierEntry[]): Promise<Discovered[]> {
  const out: Discovered[] = [];
  const fromE = entries.filter((entry) => entry.ref.kind === meta.fromKind);
  const toE = entries.filter((entry) => entry.ref.kind === meta.toKind);
  const tE = spec.fkOnFrom ? fromE : toE;
  const oE = spec.fkOnFrom ? toE : fromE;
  const owner = groupByFk(tE, (entry) => spec.fkOf(entry.row));
  const oById = new Map(oE.map((entry) => [entry.ref.id, entry]));
  // (a) 피참조 id로 FK 테이블을 질의: fetched.fk ↔ frontier 피참조 행
  const viaFkFetch = async () => {
    const fetchedKind = spec.fkOnFrom ? meta.fromKind : meta.toKind;
    if (!oE.length) return;
    for (const row of await spec.fetchTByFk(oE.map((entry) => entry.ref.id))) {
      const fk = spec.fkOf(row);
      const target = fk === null ? undefined : oById.get(fk);
      if (!target) continue;
      out.push({ meta, from: spec.fkOnFrom ? { kind: fetchedKind, id: row.id } : target.ref, to: spec.fkOnFrom ? target.ref : { kind: fetchedKind, id: row.id }, row });
    }
  };
  // (b) FK 값으로 피참조 테이블을 질의: fetched.id ↔ frontier FK 소유 행
  const viaIdFetch = async () => {
    const fetchedKind = spec.fkOnFrom ? meta.toKind : meta.fromKind;
    const ids = [...owner.keys()];
    if (!ids.length) return;
    for (const row of await spec.fetchOByIds(ids)) {
      for (const tEntry of owner.get(row.id) ?? []) {
        out.push({ meta, from: spec.fkOnFrom ? tEntry.ref : { kind: fetchedKind, id: row.id }, to: spec.fkOnFrom ? { kind: fetchedKind, id: row.id } : tEntry.ref, row });
      }
    }
  };
  if (fromE.length) await (spec.fkOnFrom ? viaIdFetch() : viaFkFetch());
  if (meta.bidirectional && toE.length) await (spec.fkOnFrom ? viaFkFetch() : viaIdFetch());
  return out;
}

/** 카탈로그 엔트리 → 질의 스펙. 모든 분기가 위 로더의 eq(companyId)/join 스코프를 통한다. */
function edgeSpec(ctx: Ctx, meta: LogicalGraphEdgeMeta): FkEdgeSpec | null {
  switch (meta.kind) {
    case "mission_issue": return { fkOnFrom: false, fkOf: (row) => (row as IssueRow).missionId, fetchTByFk: (ids) => fetchIssues(ctx, inArray(issues.missionId, ids)), fetchOByIds: (ids) => fetchMissions(ctx, inArray(missions.id, ids)) };
    case "issue_parent": return { fkOnFrom: true, fkOf: (row) => (row as IssueRow).parentId, fetchTByFk: (ids) => fetchIssues(ctx, inArray(issues.parentId, ids)), fetchOByIds: (ids) => fetchIssues(ctx, inArray(issues.id, ids)) };
    case "issue_work_product": return { fkOnFrom: false, fkOf: (row) => (row as WorkProductRow).issueId, fetchTByFk: (ids) => fetchWorkProducts(ctx, inArray(issueWorkProducts.issueId, ids)), fetchOByIds: (ids) => fetchIssues(ctx, inArray(issues.id, ids)) };
    case "issue_run": return { fkOnFrom: true, fkOf: (row) => (row as IssueRow).checkoutRunId ?? (row as IssueRow).executionRunId, fetchTByFk: (ids) => fetchIssues(ctx, or(inArray(issues.checkoutRunId, ids), inArray(issues.executionRunId, ids))), fetchOByIds: (ids) => fetchRuns(ctx, inArray(heartbeatRuns.id, ids)) };
    case "work_product_run": return { fkOnFrom: true, fkOf: (row) => (row as WorkProductRow).createdByRunId, fetchTByFk: (ids) => fetchWorkProducts(ctx, inArray(issueWorkProducts.createdByRunId, ids)), fetchOByIds: (ids) => fetchRuns(ctx, inArray(heartbeatRuns.id, ids)) };
    case "run_retry": return { fkOnFrom: true, fkOf: (row) => (row as RunRow).retryOfRunId, fetchTByFk: (ids) => fetchRuns(ctx, inArray(heartbeatRuns.retryOfRunId, ids)), fetchOByIds: (ids) => fetchRuns(ctx, inArray(heartbeatRuns.id, ids)) };
    case "run_step_run": return { fkOnFrom: true, fkOf: (row) => (row as RunRow).workflowStepRunId, fetchTByFk: (ids) => fetchRuns(ctx, inArray(heartbeatRuns.workflowStepRunId, ids)), fetchOByIds: (ids) => fetchStepRuns(ctx, inArray(workflowStepRuns.id, ids)) };
    case "workflow_run_mission": return { fkOnFrom: true, fkOf: (row) => (row as WorkflowRunRow).missionId, fetchTByFk: (ids) => fetchWorkflowRuns(ctx, inArray(workflowRuns.missionId, ids)), fetchOByIds: (ids) => fetchMissions(ctx, inArray(missions.id, ids)) };
    case "workflow_run_parent": return { fkOnFrom: true, fkOf: (row) => (row as WorkflowRunRow).parentRunId, fetchTByFk: (ids) => fetchWorkflowRuns(ctx, inArray(workflowRuns.parentRunId, ids)), fetchOByIds: (ids) => fetchWorkflowRuns(ctx, inArray(workflowRuns.id, ids)) };
    case "step_run_issue": return { fkOnFrom: true, fkOf: (row) => (row as StepRunRow).issueId, fetchTByFk: (ids) => fetchStepRuns(ctx, inArray(workflowStepRuns.issueId, ids)), fetchOByIds: (ids) => fetchIssues(ctx, inArray(issues.id, ids)) };
    case "step_run_workflow_run": return { fkOnFrom: true, fkOf: (row) => (row as StepRunRow).workflowRunId, fetchTByFk: (ids) => fetchStepRuns(ctx, inArray(workflowStepRuns.workflowRunId, ids)), fetchOByIds: (ids) => fetchWorkflowRuns(ctx, inArray(workflowRuns.id, ids)) };
    case "decision_issue": return { fkOnFrom: true, fkOf: (row) => (row as DecisionRow).issueId, fetchTByFk: (ids) => fetchDecisions(ctx, inArray(operatorDecisions.issueId, ids)), fetchOByIds: (ids) => fetchIssues(ctx, inArray(issues.id, ids)) };
    case "decision_workflow_run": return { fkOnFrom: true, fkOf: (row) => (row as DecisionRow).sourceContext?.workflowRunId ?? null, fetchTByFk: (ids) => fetchDecisions(ctx, or(...ids.map((id) => sql`${operatorDecisions.sourceContext} ->> 'workflowRunId' = ${id}`))), fetchOByIds: (ids) => fetchWorkflowRuns(ctx, inArray(workflowRuns.id, ids)) };
    case "knowledge_source": return { fkOnFrom: true, fkOf: (row) => (row as KnowledgeRow).sourceRefs.find((ref) => ref.type === meta.toKind)?.id ?? null, fetchTByFk: () => Promise.resolve([]), fetchOByIds: (ids) => meta.toKind === "mission" ? fetchMissions(ctx, inArray(missions.id, ids)) : fetchIssues(ctx, inArray(issues.id, ids)) };
    default: return null;
  }
}

/** knowledge_link(linked_node_ids 배열)은 다중 링크라 제네릭 FK 엔진 밖에서 직접 확장한다. */
async function expandKnowledgeLink(ctx: Ctx, meta: LogicalGraphEdgeMeta, entries: FrontierEntry[]): Promise<Discovered[]> {
  const out: Discovered[] = [];
  const kn = entries.filter((entry) => entry.ref.kind === "knowledge_node");
  if (!kn.length) return out;
  const byLinked = new Map<string, FrontierEntry[]>();
  for (const entry of kn) for (const linkedId of (entry.row as KnowledgeRow).linkedNodeIds) {
    byLinked.set(linkedId, [...(byLinked.get(linkedId) ?? []), entry]);
  }
  const forwardIds = [...new Set(kn.flatMap((entry) => (entry.row as KnowledgeRow).linkedNodeIds))];
  for (const row of forwardIds.length ? await fetchKnowledge(ctx, inArray(knowledgeNodes.id, forwardIds)) : []) {
    for (const entry of byLinked.get(row.id) ?? []) {
      out.push({ meta, from: entry.ref, to: { kind: "knowledge_node", id: row.id }, row });
    }
  }
  const back = await fetchKnowledge(ctx, or(...kn.map((entry) => arrayContains(knowledgeNodes.linkedNodeIds, [entry.ref.id]))));
  for (const row of back) {
    for (const entry of kn) {
      if ((row as KnowledgeRow).linkedNodeIds.includes(entry.ref.id)) {
        out.push({ meta, from: { kind: "knowledge_node", id: row.id }, to: entry.ref, row });
      }
    }
  }
  return out;
}

async function expandEdge(ctx: Ctx, meta: LogicalGraphEdgeMeta, entries: FrontierEntry[]): Promise<Discovered[]> {
  if (meta.kind === "knowledge_link") return expandKnowledgeLink(ctx, meta, entries);
  const spec = edgeSpec(ctx, meta);
  return spec ? expandFkEdge(ctx, meta, spec, entries) : [];
}

async function loadSeedRow(ctx: Ctx, kind: LogicalGraphNodeKind, id: string): Promise<AnyRow | null> {
  const rows = await (async () => {
    switch (kind) {
      case "mission": return fetchMissions(ctx, eq(missions.id, id));
      case "issue": return fetchIssues(ctx, eq(issues.id, id));
      case "work_product": return fetchWorkProducts(ctx, eq(issueWorkProducts.id, id));
      case "decision": return fetchDecisions(ctx, eq(operatorDecisions.id, id));
      case "run": return fetchRuns(ctx, eq(heartbeatRuns.id, id));
      case "workflow_run": return fetchWorkflowRuns(ctx, eq(workflowRuns.id, id));
      case "step_run": return fetchStepRuns(ctx, eq(workflowStepRuns.id, id));
      case "knowledge_node": return fetchKnowledge(ctx, eq(knowledgeNodes.id, id));
    }
  })();
  return rows.length ? rows[0] : null;
}

/** seed에서 hop별(최대 2) 카탈로그 순서 확장. 노드 예산 초과 시 중단 + truncated. */
export async function queryLogicalDataGraph(db: Db, params: QueryLogicalDataGraphParams): Promise<LogicalDataGraphResult> {
  const maxHops = clampLogicalGraphMaxHops(params.maxHops);
  const limit = clampLogicalGraphLimit(params.limit);
  const seedMeta = { kind: params.seedKind, id: params.seedId };
  const seedCtx: Ctx = { db, companyId: params.companyId, perQueryCap: limit + 1, nodes: new Map(), edges: new Map() };
  const seedRow = await loadSeedRow(seedCtx, params.seedKind, params.seedId);
  if (!seedRow) return { seed: seedMeta, nodes: [], edges: [], truncated: false };
  const ctx: Ctx = { db, companyId: params.companyId, perQueryCap: limit + 1, nodes: new Map(), edges: new Map() };
  const seedRef: NodeRef = { kind: params.seedKind, id: seedRow.id };
  ctx.nodes.set(nodeKey(seedRef), toNode(params.seedKind, seedRow, 0));
  let frontier: FrontierEntry[] = [{ ref: seedRef, row: seedRow }];
  let truncated = false;
  for (let hop = 1; hop <= maxHops && frontier.length; hop += 1) {
    const discovered: Discovered[] = [];
    for (const meta of LOGICAL_DATA_GRAPH_EDGES) {
      const relevant = frontier.filter((entry) => entry.ref.kind === meta.fromKind || (meta.bidirectional && entry.ref.kind === meta.toKind));
      if (relevant.length) discovered.push(...await expandEdge(ctx, meta, relevant));
    }
    const next: FrontierEntry[] = [];
    // discovered의 fetched 행은 to 쪽(순방향) 또는 from 쪽(역방향) 어느 쪽이든 될 수 있다.
    // frontier 쪽 엔드포인트는 항상 이미 노드로 존재하므로, 없는 쪽이 fetched 행이다.
    for (const d of discovered) {
      const fromMissing = !ctx.nodes.has(nodeKey(d.from));
      const toMissing = !ctx.nodes.has(nodeKey(d.to));
      if (fromMissing) {
        if (ctx.nodes.size >= limit) { truncated = true; break; }
        ctx.nodes.set(nodeKey(d.from), toNode(d.from.kind, d.row, hop as 0 | 1 | 2));
        next.push({ ref: d.from, row: d.row });
      }
      if (toMissing) {
        if (ctx.nodes.size >= limit) { truncated = true; break; }
        ctx.nodes.set(nodeKey(d.to), toNode(d.to.kind, d.row, hop as 0 | 1 | 2));
        next.push({ ref: d.to, row: d.row });
      }
      ctx.edges.set(edgeKey(d), { kind: d.meta.kind, from: { ...d.from }, to: { ...d.to }, via: d.meta.viaColumn });
    }
    if (truncated) break;
    frontier = next;
  }
  return { seed: seedMeta, nodes: [...ctx.nodes.values()], edges: [...ctx.edges.values()], truncated };
}
