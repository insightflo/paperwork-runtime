// [파일 목적] Quality RSI 라우트 — 실전 QA 성적표·미탐률 조회, 자동 RSI 동기화, 원클릭 표준 규약 승격.
// [외부 연결] server/src/services/quality-rsi.ts, server/src/app.ts, ui/src/api/quality.ts.
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import {
  getQualityRsiOverview,
  promoteQualityPatternToCanon,
  syncQualityRsi,
} from "../services/quality-rsi.js";

export function qualityRsiRoutes(db: Db) {
  const router = Router();

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

  router.post("/companies/:companyId/quality/rsi-sync", (req, res, next) => {
    try {
      assertBoard(req);
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      syncQualityRsi(db, companyId).then((result) => res.json(result)).catch(next);
    } catch (err) {
      next(err);
    }
  });

  router.post("/companies/:companyId/quality/rsi-promote-canon", (req, res, next) => {
    try {
      assertBoard(req);
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const signature = typeof req.body?.signature === "string" ? req.body.signature.trim() : "";
      if (!signature || !signature.startsWith("quality-rsi:")) {
        throw badRequest("signature must be a non-empty quality-rsi:* identifier");
      }
      promoteQualityPatternToCanon(db, companyId, signature)
        .then((result) => res.status(result.alreadyCanon ? 200 : 201).json(result))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
