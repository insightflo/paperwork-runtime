// server/src/routes/harness-rsi.ts
//
// [파일 목적] RRSI + Harness2 Stage 2 읽기 전용 진단 라우트 (dgate soft mode).
//   회사별 최근 텔레메트리 스냅샷의 병목 리포트를 반환한다 — 쓰기·뮤테이션 없음.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  DIAGNOSIS_DEFAULT_WINDOW_HOURS,
  DIAGNOSIS_MAX_WINDOW_HOURS,
  loadCompanyHarnessDiagnosis,
} from "../services/harness-rsi/telemetry-diagnose.js";
import { assertCompanyAccess } from "./authz.js";

function parseWindowHours(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return DIAGNOSIS_DEFAULT_WINDOW_HOURS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DIAGNOSIS_DEFAULT_WINDOW_HOURS;
  return Math.min(Math.max(Math.floor(parsed), 1), DIAGNOSIS_MAX_WINDOW_HOURS);
}

export function harnessRsiRoutes(db: Db) {
  const router = Router();

  // GET company telemetry diagnosis report (read-only; ?windowHours=24 default, 1..168 clamp).
  router.get("/companies/:companyId/harness-rsi/diagnose", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const windowHours = parseWindowHours(req.query.windowHours);
      loadCompanyHarnessDiagnosis(db, companyId, windowHours)
        .then((report) => res.json({ companyId, windowHours, report }))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
