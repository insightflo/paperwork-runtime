// server/src/routes/harness-rsi.ts
// [파일 목적] RRSI + Harness2 라우트 — Stage 2 진단, Stage 3 제안·무상태 크리틱 스크리닝,
//   Stage 4 장부(ledger): 제안 결정 기록·평가 갱신·조회. DB 쓰기는 harness_rsi_ledger
//   테이블로 한정되며 라이브 에이전트·워크플로·프롬프트는 변경하지 않는다 (dgate soft).

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
import {
  evaluateLedgerEntry,
  listCompanyLedger,
  recordProposalDecision,
  toEditHistoryRecords,
  type RecordProposalDecisionInput,
} from "../services/harness-rsi/ledger-store.js";
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

  // GET approval-gated proposals (?round=1&totalRounds=6, same window clamp).
  // Reads the ledger (newest 100) as Stage-1 history — evaluated rows feed pruneSet/stallFlag.
  router.get("/companies/:companyId/harness-rsi/proposals", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const windowHours = parseWindowHours(req.query.windowHours);
      const round = parseClampedInt(req.query.round, 1, 1, 10_000);
      const totalRounds = parseClampedInt(req.query.totalRounds, 6, 1, 10_000);
      Promise.all([
        loadCompanyHarnessDiagnosis(db, companyId, windowHours),
        listCompanyLedger(db, companyId, 100),
      ])
        .then(([report, ledgerRows]) => res.json({
          companyId,
          windowHours,
          result: proposeHarnessCandidates({
            report,
            history: toEditHistoryRecords(ledgerRows),
            round,
            totalRounds,
          }),
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

  // GET ledger rows (newest first; ?limit=50, clamped 1..200). Read-only.
  router.get("/companies/:companyId/harness-rsi/ledger", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const limit = parseClampedInt(req.query.limit, 50, 1, 200);
      listCompanyLedger(db, companyId, limit)
        .then((entries) => res.json({ companyId, entries }))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  // POST a proposal decision into the ledger (201). Writes harness_rsi_ledger only.
  // baselineJson defaults to the current 24h diagnosis summary when omitted.
  router.post("/companies/:companyId/harness-rsi/proposals/decision", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const baselineJson = body.baselineJson == null
        ? loadCompanyHarnessDiagnosis(db, companyId, DIAGNOSIS_DEFAULT_WINDOW_HOURS)
            .then((r) => ({
              score: r.summary.successRate,
              cost: r.summary.avgDurationMs / 60_000,
            }))
        : Promise.resolve(body.baselineJson);
      baselineJson
        .then((baseline) =>
          recordProposalDecision(db, {
            ...body,
            companyId,
            baselineJson: baseline,
          } as RecordProposalDecisionInput))
        .then((entry) => res.status(201).json({ companyId, entry }))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  // POST evaluate a decided ledger row against the live 24h diagnosis summary.
  // Updates only the evaluation columns on the scoped row.
  router.post("/companies/:companyId/harness-rsi/ledger/:entryId/evaluate", (req, res, next) => {
    try {
      const { companyId, entryId } = req.params;
      assertCompanyAccess(req, companyId);
      loadCompanyHarnessDiagnosis(db, companyId, DIAGNOSIS_DEFAULT_WINDOW_HOURS)
        .then((report) =>
          evaluateLedgerEntry(db, {
            companyId,
            entryId,
            currentSummary: report.summary,
          }))
        .then(({ entry, selection }) => res.json({ companyId, entry, selection }))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
