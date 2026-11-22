// server/src/routes/harness-rsi.ts
// [파일 목적] RRSI + Harness2 읽기 전용 라우트 — Stage 2 진단, Stage 3 제안·무상태 크리틱 스크리닝 (쓰기 없음).

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  DIAGNOSIS_DEFAULT_WINDOW_HOURS,
  DIAGNOSIS_MAX_WINDOW_HOURS,
  loadCompanyHarnessDiagnosis,
} from "../services/harness-rsi/telemetry-diagnose.js";
import {
  evaluateProposalCandidate,
  proposeHarnessCandidates,
  type ProposalBaseline,
  type ProposalPolicy,
} from "../services/harness-rsi/proposal-loop.js";
import type { RrsiCandidate } from "../services/harness-rsi/rrsi-selection.js";
import { screenCandidateDiff } from "../services/harness-rsi/rrsi-critic.js";
import { badRequest } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

function parseClampedInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function validateOptionalSelection(
  baseline: unknown,
  candidate: unknown,
  policy: unknown,
): { baseline: ProposalBaseline; candidate: RrsiCandidate; policy?: ProposalPolicy } | null {
  if (baseline == null && candidate == null) return null;
  if (!isRecord(baseline) || typeof baseline.score !== "number" || !Number.isFinite(baseline.score)
    || typeof baseline.cost !== "number" || !Number.isFinite(baseline.cost)) {
    throw badRequest("baseline must be an object with finite numeric score and cost");
  }
  if (candidate == null) return null;
  if (!isRecord(candidate) || typeof candidate.id !== "string"
    || typeof candidate.score !== "number" || !Number.isFinite(candidate.score)
    || typeof candidate.cost !== "number" || !Number.isFinite(candidate.cost)
    || !Array.isArray(candidate.components)) {
    throw badRequest("candidate must be an object with id, finite score/cost, and components array");
  }
  if (policy != null) {
    if (!isRecord(policy)) throw badRequest("policy must be an object");
    if (policy.config != null) {
      if (!isRecord(policy.config) || (policy.config.guards !== undefined && !Array.isArray(policy.config.guards))) {
        throw badRequest("policy.config.guards must be an array");
      }
    }
  }
  return {
    baseline: baseline as unknown as ProposalBaseline,
    candidate: candidate as unknown as RrsiCandidate,
    policy: policy as ProposalPolicy | undefined,
  };
}

const parseWindowHours = (raw: unknown) =>
  parseClampedInt(raw, DIAGNOSIS_DEFAULT_WINDOW_HOURS, 1, DIAGNOSIS_MAX_WINDOW_HOURS);

interface ScreenBody {
  diffText?: unknown;
  baseline?: ProposalBaseline;
  candidate?: RrsiCandidate;
  policy?: ProposalPolicy;
}

export function harnessRsiRoutes(db: Db) {
  const router = Router();

  // GET telemetry diagnosis report (read-only; ?windowHours=24 default, 1..168 clamp).
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

  // GET approval-gated proposals (read-only; ?round=1&totalRounds=6, same window clamp).
  router.get("/companies/:companyId/harness-rsi/proposals", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const windowHours = parseWindowHours(req.query.windowHours);
      const round = parseClampedInt(req.query.round, 1, 1, 10_000);
      const totalRounds = parseClampedInt(req.query.totalRounds, 6, 1, 10_000);
      loadCompanyHarnessDiagnosis(db, companyId, windowHours)
        .then((report) => res.json({
          companyId,
          windowHours,
          result: proposeHarnessCandidates({ report, round, totalRounds }),
        }))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  // POST stateless critic screen — ZERO DB/activity writes ({ diffText, baseline?, candidate?, policy? }).
  router.post("/companies/:companyId/harness-rsi/screen", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const { diffText, baseline, candidate, policy } = (req.body ?? {}) as ScreenBody;
      if (typeof diffText !== "string") throw badRequest("diffText must be a string");
      const critic = screenCandidateDiff({ diff: diffText, edits: [] });
      const validated = validateOptionalSelection(baseline, candidate, policy);
      const selection = validated ? evaluateProposalCandidate(validated).selection : null;
      res.json({ companyId, critic, selection });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
