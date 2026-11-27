// [파일 목적] Quality RSI 라우트 — 실전 QA 성적표·미탐률 조회, 자동 RSI 동기화, 원클릭 표준 규약 승격.
// [외부 연결] server/src/services/quality-rsi.ts, server/src/app.ts, ui/src/api/quality.ts.
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { accessService } from "../services/access.js";
import { assertBoard, assertCompanyAccess, assertCompanyAdminAccess } from "./authz.js";
import { assertCompanyWriteAccess } from "./authz-write.js";
import {
  getQualityRsiOverview,
  promoteQualityPatternToCanon,
  syncQualityRsi,
} from "../services/quality-rsi.js";

export function qualityRsiRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);

  router.get("/companies/:companyId/quality/rsi-overview", (req, res, next) => {
    try {
      assertBoard(req);
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      getQualityRsiOverview(db, companyId).then((data) => res.json(data)).catch(next);
    } catch (err) {
      next(err);
    }
  });

  router.post("/companies/:companyId/quality/rsi-sync", async (req, res, next) => {
    try {
      assertBoard(req);
      const { companyId } = req.params;
      await assertCompanyWriteAccess(access, req, companyId);
      const result = await syncQualityRsi(db, companyId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/companies/:companyId/quality/rsi-promote-canon", async (req, res, next) => {
    try {
      const { companyId } = req.params;
      await assertCompanyAdminAccess(access, req, companyId);
      const signature = typeof req.body?.signature === "string" ? req.body.signature.trim() : "";
      if (!signature || !signature.startsWith("quality-rsi:")) {
        throw badRequest("signature must be a non-empty quality-rsi:* identifier");
      }
      const result = await promoteQualityPatternToCanon(db, companyId, signature);
      res.status(result.alreadyCanon ? 200 : 201).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
