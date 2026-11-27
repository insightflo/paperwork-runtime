// server/src/routes/data-graph.ts
//
// [파일 목적] Two-Graph Pillar 2·3 읽기 전용 HTTP 표면 — 문제-우선 그래프 모드 추천과
//   GraphRAG 컨텍스트 팩 빌드를 회사 스코프로 노출한다. 상태 변경·activity log가 없다.
// [외부 연결] services/data-graph/graphrag-context-pack.ts(순수 함수, DB 접근 없음)과
//   services/data-graph/logical-graph.ts(queryLogicalDataGraph, 읽기 전용 DB 질의)를 호출.
//   소비처: 보드 UI·워크플로 노드가 그래프 모드를 고르거나 출처 포함 맥락 팩·연결 컨텍스트를 얻을 때.
// [수정 주의] 읽기 전용 계약 유지 — GET·POST 모두 쓰기·activity log를 추가하지 않는다. 팩 응답은
//   서비스의 결정론·출처 인용·비밀 가림 불변식을 그대로 신뢰하며 라우트가 재가공하지 않는다.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  buildGraphRagContextPack,
  recommendGraphMode,
  type BuildGraphRagContextPackInput,
} from "../services/data-graph/graphrag-context-pack.js";
import {
  LOGICAL_DATA_GRAPH_EDGES,
  queryLogicalDataGraph,
  type LogicalDataGraphResult,
  type LogicalGraphNodeKind,
} from "../services/data-graph/logical-graph.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/index.js";

const graphNodeRefSchema = z.object({
  nodeType: z.string().trim().min(1),
  nodeId: z.string().trim().min(1),
});

const recommendModeSchema = z.object({
  requiresStructuralPause: z.boolean().optional(),
  requiresDeterministicBranching: z.boolean().optional(),
  requiresMultiHopContext: z.boolean().optional(),
  estimatedHops: z.number().optional(),
});

// [입력 검증] 서비스의 BuildGraphRagContextPackInput 계약을 그대로 반영 — seed는 필수이고
//   nodes·edges는 빈 배열 허용. hop 없는 노드는 서비스 클램프 규칙(0)과 같게 0 기본값.
const contextPackSchema = z.object({
  seed: graphNodeRefSchema,
  nodes: z
    .array(
      z.object({
        nodeType: z.string().trim().min(1),
        nodeId: z.string().trim().min(1),
        hop: z.number().default(0),
        label: z.string().optional(),
        status: z.string().optional(),
        summary: z.string().optional(),
      }),
    )
    .default([]),
  edges: z
    .array(
      z.object({
        kind: z.string(),
        from: graphNodeRefSchema,
        to: graphNodeRefSchema,
        viaEdge: z.string(),
      }),
    )
    .default([]),
  maxFacts: z.number().optional(),
  maxChars: z.number().optional(),
});

// [입력 검증] GET 쿼리 파라미터 — seed는 카탈로그 노드 어휘의 <kind>:<uuid>, maxHops는
//   1|2(기본 2는 서비스 클램프), limit 1..100, includeContextPack은 "true"|"false" 문자열.
//   노드 어휘는 엣지 카탈로그에서 유도해 어휘 중복을 만들지 않는다.
const DATA_GRAPH_NODE_KINDS = [...new Set(LOGICAL_DATA_GRAPH_EDGES.flatMap((edge) => [edge.fromKind, edge.toKind]))];
const DATA_GRAPH_SEED_PATTERN = new RegExp(
  `^(${DATA_GRAPH_NODE_KINDS.join("|")}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
  "i",
);
const queryDataGraphSchema = z.object({
  seed: z.string().regex(DATA_GRAPH_SEED_PATTERN),
  maxHops: z.coerce.number().int().pipe(z.union([z.literal(1), z.literal(2)])).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  includeContextPack: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
});

/** traversal 결과를 팩 빌더 입력 어휘(nodeType/nodeId/viaEdge)로 매핑한다 — 라우트 재가공 없음. */
const toContextPackInput = (result: LogicalDataGraphResult): BuildGraphRagContextPackInput => ({
  seed: { nodeType: result.seed.kind, nodeId: result.seed.id },
  nodes: result.nodes.map((node) => ({
    nodeType: node.kind,
    nodeId: node.id,
    hop: node.hop,
    label: node.label ?? undefined,
    status: node.status ?? undefined,
  })),
  edges: result.edges.map((edge) => ({
    kind: edge.kind,
    from: { nodeType: edge.from.kind, nodeId: edge.from.id },
    to: { nodeType: edge.to.kind, nodeId: edge.to.id },
    viaEdge: edge.via,
  })),
});

export function dataGraphRoutes(db?: Db): Router {
  const router = Router();

  // POST /api/companies/:companyId/data-graph/recommend-mode — 덱 결정 표(단일/워크플로/데이터/투그래프).
  router.post("/companies/:companyId/data-graph/recommend-mode", validate(recommendModeSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(recommendGraphMode(req.body));
  });

  // POST /api/companies/:companyId/data-graph/context-pack — 결정론 팩(출처 인용 + 비밀 가림).
  router.post("/companies/:companyId/data-graph/context-pack", validate(contextPackSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(buildGraphRagContextPack(req.body));
  });

  // GET /api/companies/:companyId/data-graph/query — 논리 데이터 그래프 bounded traversal.
  //   질의기는 DB 필수이므로 db가 주어질 때만 등록한다(app.ts는 항상 전달). 접근 검사 먼저,
  //   그다음 쿼리 파라미터 검증(400). includeContextPack=true면 팩을 그대로 첨부한다.
  if (db) {
    router.get("/companies/:companyId/data-graph/query", async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        const parsed = queryDataGraphSchema.safeParse(req.query);
        if (!parsed.success) {
          res.status(400).json({ error: "Validation error", details: parsed.error.errors });
          return;
        }
        const { seed, maxHops, limit, includeContextPack = false } = parsed.data;
        const colon = seed.indexOf(":");
        const result = await queryLogicalDataGraph(db, {
          companyId,
          seedKind: seed.slice(0, colon) as LogicalGraphNodeKind,
          seedId: seed.slice(colon + 1),
          maxHops,
          limit,
        });
        res.json(includeContextPack
          ? { ...result, contextPack: buildGraphRagContextPack(toContextPackInput(result)) }
          : result);
      } catch (error) {
        next(error);
      }
    });
  }

  return router;
}
