// server/src/routes/agent-governance-learning.ts
// [파일 목적] 회사 범위의 에이전트 거버넌스 학습 API — 메모리 리뷰(제안·결정)와
//   로컬 스킬 초안(추출·승격·폐기). 모든 판독·기록은 구조화 스토어로만 수행하며
//   자연어 파싱으로 실행 권한을 얻지 않는다. company-scoped 접근 검사 필수.

import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { globalMemoryReviewStore } from "../services/agent-memory-review.js";
import { globalLocalSkillLearnerStore } from "../services/local-skill-learner.js";

const memoryReviewCreateSchema = z.object({
  agentId: z.string().min(1),
  targetPath: z.string().min(1),
  beforeContent: z.string(),
  afterContent: z.string(),
  summary: z.string().min(1),
});

const memoryReviewDecideSchema = z.object({
  decision: z.enum(["approve", "reject", "hold"]),
  userId: z.string().min(1),
  note: z.string().optional(),
  holdMs: z.number().int().positive().optional(),
});

const skillDraftCreateSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  sourceRunId: z.string().min(1),
});

// 동기 서비스 호출용 래퍼. 서비스가 던진 HttpError를 errorHandler로 전달한다.
function handle(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (err) {
      next(err);
    }
  };
}

// Express 5는 반복 파라미터를 위해 params를 string | string[]로 타핑한다.
// 이 라우트들은 named 단일 파라미터만 쓰므로 저장소 기존 관례(access.ts)처럼
// 단일 문자열로 좁혀 사용한다.
function param(params: Request["params"], name: string): string {
  const value = params[name];
  return Array.isArray(value) ? value[0] : value;
}

export function agentGovernanceLearningRoutes() {
  const router = Router();

  router.get(
    "/companies/:companyId/memory-reviews",
    handle((req, res) => {
      const companyId = param(req.params, "companyId");
      assertCompanyAccess(req, companyId);
      res.json(globalMemoryReviewStore.list(companyId));
    }),
  );

  router.post(
    "/companies/:companyId/memory-reviews",
    validate(memoryReviewCreateSchema),
    handle((req, res) => {
      const companyId = param(req.params, "companyId");
      assertCompanyAccess(req, companyId);
      const proposal = globalMemoryReviewStore.propose({ companyId, ...req.body });
      res.status(201).json(proposal);
    }),
  );

  router.post(
    "/companies/:companyId/memory-reviews/:id/decide",
    validate(memoryReviewDecideSchema),
    handle((req, res) => {
      const companyId = param(req.params, "companyId");
      assertCompanyAccess(req, companyId);
      res.json(globalMemoryReviewStore.decide(companyId, param(req.params, "id"), req.body));
    }),
  );

  router.get(
    "/companies/:companyId/skill-drafts",
    handle((req, res) => {
      const companyId = param(req.params, "companyId");
      assertCompanyAccess(req, companyId);
      res.json(globalLocalSkillLearnerStore.list(companyId));
    }),
  );

  router.post(
    "/companies/:companyId/skill-drafts",
    validate(skillDraftCreateSchema),
    handle((req, res) => {
      const companyId = param(req.params, "companyId");
      assertCompanyAccess(req, companyId);
      const draft = globalLocalSkillLearnerStore.extractDraft({ companyId, ...req.body });
      res.status(201).json(draft);
    }),
  );

  router.post(
    "/companies/:companyId/skill-drafts/:id/promote",
    handle((req, res) => {
      const companyId = param(req.params, "companyId");
      assertCompanyAccess(req, companyId);
      res.json(globalLocalSkillLearnerStore.promote(companyId, param(req.params, "id")));
    }),
  );

  router.post(
    "/companies/:companyId/skill-drafts/:id/discard",
    handle((req, res) => {
      const companyId = param(req.params, "companyId");
      assertCompanyAccess(req, companyId);
      res.json(globalLocalSkillLearnerStore.discard(companyId, param(req.params, "id")));
    }),
  );

  return router;
}
