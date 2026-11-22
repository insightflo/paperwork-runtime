// server/src/services/harness-rsi/ledger-store.ts
//
// [파일 목적] RRSI + Harness2 Stage 4A-store/4B — harness_rsi_ledger 내구 장부 서비스:
//   회사 스코프 조회, 장부 행→Stage1 EditHistoryRecord 변환, 제안 결정 기록
//   (critic 실패 승인은 overrideReason>=10자 필수), 평가 갱신(평가 5열만 — 결정은 write-once).
// [불변식] 쓰기는 harness_rsi_ledger 단일 테이블로 한정 (라이브 에이전트·워크플로·프롬프트 무변경).

import { and, desc, eq } from "drizzle-orm";
import { harnessRsiLedger, type Db } from "@paperclipai/db";
import { badRequest, notFound } from "../../errors.js";
import { evaluateProposalCandidate, type ProposalBaseline } from "./proposal-loop.js";
import type { EditHistoryRecord } from "./rrsi-history.js";
import type { HarnessDiagnosisSummary } from "./telemetry-diagnose.js";

export type HarnessRsiLedgerRow = typeof harnessRsiLedger.$inferSelect;
export type LedgerSelection = ReturnType<typeof evaluateProposalCandidate>["selection"];
export const LEDGER_DECISIONS = ["approved", "rejected", "deferred"] as const;
const OVERRIDE_REASON_MIN = 10;
const LIST_LIMIT_MAX = 200;
const MS_PER_COST_UNIT = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/** Newest-first ledger rows for one company; limit clamped to 1..200. */
export async function listCompanyLedger(
  db: Db,
  companyId: string,
  limit = 50,
): Promise<HarnessRsiLedgerRow[]> {
  const clamped = Number.isFinite(limit)
    ? Math.min(Math.max(Math.floor(limit), 1), LIST_LIMIT_MAX)
    : 50;
  return db.select().from(harnessRsiLedger)
    .where(eq(harnessRsiLedger.companyId, companyId))
    .orderBy(desc(harnessRsiLedger.createdAt), desc(harnessRsiLedger.id))
    .limit(clamped);
}

/** Persisted rows → Stage-1 records; only evaluated rows (verdict+deltas) count as tried. */
export function toEditHistoryRecords(rows: HarnessRsiLedgerRow[]): EditHistoryRecord[] {
  const records: EditHistoryRecord[] = [];
  for (const row of rows) {
    if (row.verdict == null || row.deltaScore == null || row.deltaCost == null) continue;
    records.push({
      round: row.round, variant: row.variant, component: row.component,
      hypothesis: row.hypothesis, diffRef: row.diffRef,
      deltaScore: row.deltaScore, deltaCost: row.deltaCost,
      accepted: row.accepted ?? false, verdict: row.verdict,
    });
  }
  return records;
}

export interface RecordProposalDecisionInput {
  companyId: string;
  decision: unknown;
  variant: unknown;
  component: unknown;
  decidedBy: unknown;
  hypothesis?: unknown;
  diffRef?: unknown;
  round?: unknown;
  criticPassed?: unknown;
  overrideReason?: unknown;
  baselineJson?: unknown;
}

/**
 * Persist a proposal decision (write-once fields; evaluation columns stay
 * null until evaluateLedgerEntry). Guard: approving a critic-failed proposal
 * (criticPassed === false) requires an overrideReason of >=10 trimmed chars.
 */
export async function recordProposalDecision(
  db: Db,
  input: RecordProposalDecisionInput,
): Promise<HarnessRsiLedgerRow> {
  const need = (v: unknown, name: string): string => {
    if (!nonEmpty(v)) throw badRequest(`${name} must be a non-empty string`);
    return v.trim();
  };
  if (
    typeof input.decision !== "string" ||
    !(LEDGER_DECISIONS as readonly string[]).includes(input.decision)
  ) {
    throw badRequest(`decision must be one of ${LEDGER_DECISIONS.join("/")}`);
  }
  const variant = need(input.variant, "variant");
  const component = need(input.component, "component");
  const decidedBy = need(input.decidedBy, "decidedBy");
  for (const [v, name] of [
    [input.hypothesis, "hypothesis"],
    [input.diffRef, "diffRef"],
    [input.overrideReason, "overrideReason"],
  ] as const) {
    if (v !== undefined && typeof v !== "string") {
      throw badRequest(`${name} must be a string`);
    }
  }
  if (
    input.round !== undefined &&
    (typeof input.round !== "number" || !Number.isFinite(input.round))
  ) {
    throw badRequest("round must be a finite number");
  }
  if (input.baselineJson !== undefined && !isRecord(input.baselineJson)) {
    throw badRequest("baselineJson must be an object");
  }
  if (
    input.decision === "approved" && input.criticPassed === false &&
    (typeof input.overrideReason !== "string" ||
      input.overrideReason.trim().length < OVERRIDE_REASON_MIN)
  ) {
    throw badRequest(
      `approving a critic-failed proposal requires overrideReason of at least ${OVERRIDE_REASON_MIN} characters`,
    );
  }
  const [entry] = await db.insert(harnessRsiLedger).values({
    companyId: input.companyId,
    round: input.round === undefined ? 0 : Math.floor(input.round),
    variant,
    component,
    decidedBy,
    hypothesis: typeof input.hypothesis === "string" ? input.hypothesis : "",
    diffRef: typeof input.diffRef === "string" ? input.diffRef : "",
    decision: input.decision,
    overrideReason:
      typeof input.overrideReason === "string" ? input.overrideReason : null,
    baselineJson: isRecord(input.baselineJson) ? input.baselineJson : null,
  }).returning();
  return entry!;
}

function readBaseline(baselineJson: unknown): ProposalBaseline {
  const { score, cost } = isRecord(baselineJson) ? baselineJson : {};
  if (
    typeof score !== "number" || !Number.isFinite(score) ||
    typeof cost !== "number" || !Number.isFinite(cost)
  ) {
    throw badRequest(
      "ledger entry baselineJson must contain finite numeric score and cost",
    );
  }
  return { score, cost };
}

/**
 * Evaluate a decided row against the live diagnosis summary — candidate scored
 * as { variant, successRate, avgDurationMs/60_000, [row.component] } via the
 * pure selection logic; updates only the five evaluation columns on the
 * (entryId, companyId)-scoped row.
 */
export async function evaluateLedgerEntry(
  db: Db,
  input: {
    companyId: string;
    entryId: string;
    currentSummary: HarnessDiagnosisSummary;
  },
): Promise<{ entry: HarnessRsiLedgerRow; selection: LedgerSelection }> {
  const { companyId, entryId, currentSummary } = input;
  if (typeof entryId !== "string" || !UUID_RE.test(entryId)) {
    throw badRequest("entryId must be a UUID");
  }
  const [row] = await db.select().from(harnessRsiLedger)
    .where(
      and(
        eq(harnessRsiLedger.id, entryId),
        eq(harnessRsiLedger.companyId, companyId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("harness_rsi_ledger entry not found");
  const { selection, ledgerEntry } = evaluateProposalCandidate({
    baseline: readBaseline(row.baselineJson),
    candidate: {
      id: row.variant,
      score: currentSummary.successRate,
      cost: currentSummary.avgDurationMs / MS_PER_COST_UNIT,
      components: [row.component],
    },
  });
  const [entry] = await db.update(harnessRsiLedger).set({
    deltaScore: ledgerEntry.deltaScore,
    deltaCost: ledgerEntry.deltaCost,
    accepted: ledgerEntry.accepted,
    verdict: ledgerEntry.verdict,
    evaluatedAt: new Date(),
  }).where(
    and(
      eq(harnessRsiLedger.id, row.id),
      eq(harnessRsiLedger.companyId, companyId),
    ),
  ).returning();
  return { entry: entry!, selection };
}
