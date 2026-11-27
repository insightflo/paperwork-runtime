// server/src/services/data-graph/data-graph-tool.ts
//
// [파일 목적] 논리 데이터 그래프 탐색(logical-graph.ts) + GraphRAG 컨텍스트 팩
//   (graphrag-context-pack.ts)을 에이전트 도구 호출 표면으로 노출하는 읽기 전용 tool 정의.
//   도구 스펙 디스크립터·인자 Zod 스키마·실행기를 한 파일에 모으고 결과를 ok/error
//   판별 유니언으로 감싸 호출자가 예외 대신 구조화된 실패를 받게 한다.
// [외부 연결] queryLogicalDataGraph(PG Drizzle 읽기 질의), buildGraphRagContextPack(순수 함수).
//   소비처: 에이전트 도구 실행기가 DATA_GRAPH_QUERY_TOOL_SPEC을 모델에 노출하고
//   executeDataGraphQueryTool로 호출한다. 라우트·activity log·쓰기는 없다.
// [수정 주의] 읽기 전용 계약 유지 — 쓰기·로깅을 추가하지 않는다. 회사 스코핑의 유일한
//   근거는 실행자가 전달하는 companyId고 rawArgs로는 주입되지 않는다. seedKind 어휘는
//   logical-graph-catalog의 LogicalGraphNodeKind와 satisfies로 정렬한다(어휘 중복 금지).

import { z } from "zod";
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
