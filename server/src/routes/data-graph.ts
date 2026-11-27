// server/src/routes/data-graph.ts
//
// [파일 목적] Two-Graph Pillar 2·3 읽기 전용 HTTP 표면 — 문제-우선 그래프 모드 추천과
//   GraphRAG 컨텍스트 팩 빌드를 회사 스코프로 노출한다. 상태 변경·activity log가 없다.
// [외부 연결] services/data-graph/graphrag-context-pack.ts(순수 함수, DB 접근 없음)만 호출.
//   소비처: 보드 UI·워크플로 노드가 그래프 모드를 고르거나 출처 포함 맥락 팩을 얻을 때.
// [수정 주의] 읽기 전용 계약 유지 — POST라도 쓰기·로깅을 추가하지 않는다. 팩 응답은
//   서비스의 결정론·출처 인용·비밀 가림 불변식을 그대로 신뢰하며 라우트가 재가공하지 않는다.

import { Router } from "express";
import { z } from "zod";
import {
  buildGraphRagContextPack,
  recommendGraphMode,
} from "../services/data-graph/graphrag-context-pack.js";
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

export function dataGraphRoutes(): Router {
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

  return router;
}
