// server/src/services/data-graph/data-graph-tool.ts
//
// [파일 목적] 논리 데이터 그래프 탐색(logical-graph.ts) + GraphRAG 컨텍스트 팩
//   (graphrag-context-pack.ts)을 에이전트 도구 호출 표면으로 노출하는 읽기 전용 tool 정의.
//   도구 스펙 디스크립터·인자 Zod 스키마·실행기를 한 파일에 모으고 결과를 ok/error
//   판별 유니언으로 감싸 호출자가 예외 대신 구조화된 실패를 받게 한다.
// [외부 연결] queryLogicalDataGraph(PG Drizzle 읽기 질의), buildGraphRagContextPack(순수 함수).
//   소비처: 에이전트 도구 실행기가 DATA_GRAPH_QUERY_TOOL_SPEC을 모델에 노출하고
//   executeDataGraphQueryTool로 호출한다. 라우트·activity log·비즈니스 쓰기는 없다.
//   seedDataGraphQueryTool은 각 회사에 tool_definitions 시드 행(kind: "data-graph-query",
//   core-tool-executor의 builtin 분기 계약과 일치)을 멱등 등록하는 유일한 쓰기 경로다.
// [수정 주의] 읽기 전용 계약 유지 — 쓰기·로깅을 추가하지 않는다. 회사 스코핑의 유일한
//   근거는 실행자가 전달하는 companyId고 rawArgs로는 주입되지 않는다. seedKind 어휘는
//   logical-graph-catalog의 LogicalGraphNodeKind와 satisfies로 정렬한다(어휘 중복 금지).

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { companies, toolDefinitions } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  queryLogicalDataGraph,
  type LogicalDataGraphResult,
  type LogicalGraphNodeKind,
} from "./logical-graph.js";
import {
  buildGraphRagContextPack,
  type GraphRagContextPack,
} from "./graphrag-context-pack.js";

/** 카탈로그 어휘와 1:1 정렬된 seed 종류 — 새 kind는 카탈로그 먼저, 여기는 satisfies로 추적. */
const SEED_KINDS = [
  "mission", "issue", "work_product", "decision", "run", "workflow_run", "step_run", "knowledge_node",
] as const satisfies readonly LogicalGraphNodeKind[];

export const dataGraphQueryToolArgsSchema = z.object({
  seedKind: z.enum(SEED_KINDS),
  seedId: z.string().trim().min(1, "seedId must be a non-empty string"),
  maxHops: z.union([z.literal(1), z.literal(2)]).default(2),
  limit: z.number().int().min(1).max(100).default(50),
  maxChars: z.number().int().min(200).max(16000).default(4000),
});

export type DataGraphQueryToolArgs = z.infer<typeof dataGraphQueryToolArgsSchema>;

export type DataGraphQueryToolResult =
  | { ok: true; graph: LogicalDataGraphResult; contextPack: GraphRagContextPack }
  | { ok: false; error: string };

/** 모델에 노출되는 구조화 도구 정의 — 설명은 읽기 전용 계약과 경계를 그대로 기술한다. */
export const DATA_GRAPH_QUERY_TOOL_SPEC = {
  name: "data_graph_query",
  description:
    "Read-only traversal of the company's logical data graph (missions, issues, work products, " +
    "decisions, runs, workflow runs, step runs, knowledge nodes) starting from a seed node. " +
    "Returns the bounded 2-hop graph plus a provenance-cited context pack with secret redaction. " +
    "Never writes or modifies data.",
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["seedKind", "seedId"],
    properties: {
      seedKind: {
        type: "string",
        enum: [...SEED_KINDS],
        description: "Node kind of the traversal seed.",
      },
      seedId: {
        type: "string",
        minLength: 1,
        description: "Id of the seed node within the calling company.",
      },
      maxHops: {
        type: "integer",
        enum: [1, 2],
        default: 2,
        description: "Maximum traversal depth from the seed (hard cap 2).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 50,
        description: "Maximum number of returned nodes, seed included (hard cap 100).",
      },
      maxChars: {
        type: "integer",
        minimum: 200,
        maximum: 16000,
        default: 4000,
        description: "Character budget of the returned context pack (prefix-preserving truncation).",
      },
    },
  },
} as const;

/** rawArgs 검증 → companyId 스코프 탐색 → 출처 인용·비밀 가림 팩. 예외 대신 ok/error 반환. */
export async function executeDataGraphQueryTool(
  db: Db,
  companyId: string,
  rawArgs: unknown,
): Promise<DataGraphQueryToolResult> {
  const parsed = dataGraphQueryToolArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `Invalid data_graph_query arguments: ${issue?.path.join(".") || "args"} — ${issue?.message ?? "validation failed"}` };
  }
  const { seedKind, seedId, maxHops, limit, maxChars } = parsed.data;
  const graph = await queryLogicalDataGraph(db, { companyId, seedKind, seedId, maxHops, limit });
  const contextPack = buildGraphRagContextPack({
    seed: { nodeType: graph.seed.kind, nodeId: graph.seed.id },
    nodes: graph.nodes.map((node) => ({
      nodeType: node.kind,
      nodeId: node.id,
      hop: node.hop,
      label: node.label ?? undefined,
      status: node.status ?? undefined,
    })),
    edges: graph.edges.map((edge) => ({
      kind: edge.kind,
      from: { nodeType: edge.from.kind, nodeId: edge.from.id },
      to: { nodeType: edge.to.kind, nodeId: edge.to.id },
      viaEdge: edge.via,
    })),
    maxChars,
  });
  return { ok: true, graph, contextPack };
}

/**
 * [목적] 한 회사에 data_graph_query 시드 행이 없으면 builtin 정의로 등록하고, 있으면
 *   건드리지 않는다(운영자가 이름을 바꿔 저장한 정의를 보존). 이름·설명·입력 스키마는
 *   DATA_GRAPH_QUERY_TOOL_SPEC에서만 가져오며, adapterConfig.kind는 core-tool-executor의
 *   "data-graph-query" 분기와 정확히 일치해야 도구가 실행된다. 이 값이 어긋나면 시드는
 *   성공해도 dispatch가 실패하므로 두 파일을 함께 수정할 것.
 * [입출력] db와 companyId를 받아 새로 등록했으면 true, 이미 있으면 false를 반환한다.
 */
async function ensureDataGraphQueryTool(db: Db, companyId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: toolDefinitions.id })
    .from(toolDefinitions)
    .where(and(
      eq(toolDefinitions.companyId, companyId),
      eq(toolDefinitions.name, DATA_GRAPH_QUERY_TOOL_SPEC.name),
    ))
    .limit(1);
  if (existing) return false;

  const inserted = await db
    .insert(toolDefinitions)
    .values({
      companyId,
      name: DATA_GRAPH_QUERY_TOOL_SPEC.name,
      description: DATA_GRAPH_QUERY_TOOL_SPEC.description,
      inputSchema: DATA_GRAPH_QUERY_TOOL_SPEC.parametersJsonSchema,
      adapterType: "builtin",
      adapterConfig: { kind: "data-graph-query" },
      enabled: true,
    })
    .onConflictDoNothing({
      target: [toolDefinitions.companyId, toolDefinitions.name],
    })
    .returning({ id: toolDefinitions.id });
  return inserted.length > 0;
}

/**
 * [목적] 모든 회사(또는 companyId 옵션으로 지정한 한 회사)에 읽기 전용 data_graph_query
 *   내장 도구 정의를 멱등 등록한다. html-preflight·judgment 시드와 같은 런타임 시드 계약이다.
 * [입출력] { companies: 대상 회사 수, toolsSeeded: 이번 호출에서 새로 등록된 행 수 }.
 * [주의] 한 회사의 일시 DB 오류가 다른 회사 시딩을 막지 않게 루프 오류를 격리한다.
 */
export async function seedDataGraphQueryTool(
  db: Db,
  options: { companyId?: string } = {},
): Promise<{ companies: number; toolsSeeded: number }> {
  const rows = options.companyId
    ? [{ id: options.companyId }]
    : await db.select({ id: companies.id }).from(companies);
  let toolsSeeded = 0;
  for (const row of rows) {
    try {
      if (await ensureDataGraphQueryTool(db, row.id)) toolsSeeded += 1;
    } catch (error) {
      console.error("data-graph-query seed failed for company", row.id, (error as Error).message);
    }
  }
  return { companies: rows.length, toolsSeeded };
}
