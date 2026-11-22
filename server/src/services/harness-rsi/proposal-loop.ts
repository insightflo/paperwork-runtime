// server/src/services/harness-rsi/proposal-loop.ts
//
// [파일 목적] RRSI + Harness2 Stage 3 — 승인 게이트 제안 루프 + 무상태 크리틱 스크리닝.
//   Stage 2 진단 리포트의 병목을 HarnessProposal 후보로 변환하고 Stage 1 크리틱으로
//   사전 스크리닝한다. 모든 함수는 순수 — DB·파일·네트워크 쓰기와 auto-apply 없음.

import {
  editBudget,
  relativeCostChange,
  selectAdmissibleCandidate,
  type RrsiCandidate,
  type SelectionConfig,
} from "./rrsi-selection.js";
import { summarizeEditHistory, type EditHistoryRecord } from "./rrsi-history.js";
import { screenCandidateDiff, type CriticResult } from "./rrsi-critic.js";
import type {
  HarnessBottleneck,
  HarnessDiagnosisReport,
} from "./telemetry-diagnose.js";

export const PROPOSAL_TOTAL_ROUNDS_DEFAULT = 6;
const STALL_WINDOW = 3;
const PRUNE_WINDOW = 3;
const STALL_DELTA = 0.05;
const BUDGET_MIN = 1;
const BUDGET_MAX = 3;

/** Approval-gated proposal: literal types pin the no-auto-apply invariant. */
export interface HarnessProposal {
  id: string;
  component: HarnessBottleneck["component"];
  severity: HarnessBottleneck["severity"];
  targetMetric: string;
  hypothesis: string;
  recommendedAction: string;
  critic: CriticResult;
  requiresApproval: true;
  autoApply: false;
}

export interface ProposalLoopResult {
  round: number;
  totalRounds: number;
  budget: number;
  stallFlag: boolean;
  prunedComponents: string[];
  proposals: HarnessProposal[];
}

/** Caller-appendable ledger record (Stage 1 shape; this module never writes it). */
export type EditLedgerEntry = EditHistoryRecord;

export interface ProposalBaseline {
  score: number;
  cost: number;
}

export interface ProposalPolicy {
  delta?: number;
  bestScore?: number;
  config?: SelectionConfig;
}

export interface ProposalMeta {
  round?: number;
  variant?: string;
  component?: string;
  hypothesis?: string;
  diffRef?: string;
}

const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
  beta0: 0.1,
  beta1: 0.5,
  wScore: 1,
  wCost: 1,
  wNovelty: 2,
};

/**
 * Rebuild the cumulative accepted-score series S_t from the ledger so the
 * stall detector gets real inputs when callers only persist edit records.
 */
function roundScoresFromHistory(
  records: EditHistoryRecord[],
  currentRound: number,
): number[] {
  const scores = new Array<number>(Math.max(currentRound, 0) + 1).fill(0);
  for (const rec of records) {
    if (rec.accepted && rec.round >= 0 && rec.round <= currentRound) {
      scores[rec.round] += rec.deltaScore;
    }
  }
  for (let i = 1; i < scores.length; i += 1) scores[i] += scores[i - 1];
  return scores;
}

/**
 * Convert a diagnosis report into approval-gated proposals. Bottlenecks on
 * components in the history pruneSet are skipped unless severity === "high";
 * survivors are capped by the annealed edit budget (then maxCandidates).
 * Each proposal's combined hypothesis + recommendedAction text is screened
 * by the stateless critic as added (+) diff lines, so hardcoded secrets,
 * tenant paths/hosts and UUIDs flag critic.pass = false before any human
 * ever sees the suggestion. Nothing is applied — every proposal is
 * requiresApproval: true / autoApply: false.
 */
export function proposeHarnessCandidates(input: {
  report: HarnessDiagnosisReport;
  history?: EditHistoryRecord[];
  round?: number;
  totalRounds?: number;
  maxCandidates?: number;
}): ProposalLoopResult {
  const {
    report,
    history = [],
    round = 1,
    totalRounds = PROPOSAL_TOTAL_ROUNDS_DEFAULT,
    maxCandidates,
  } = input;

  const summary = summarizeEditHistory(history, {
    currentRound: round,
    stallWindow: STALL_WINDOW,
    pruneWindow: PRUNE_WINDOW,
    delta: STALL_DELTA,
    roundScores: roundScoresFromHistory(history, round),
  });
  const pruned = new Set(summary.pruneSet);

  let budget = editBudget(round, totalRounds, BUDGET_MIN, BUDGET_MAX);
  if (typeof maxCandidates === "number" && Number.isFinite(maxCandidates)) {
    budget = Math.min(budget, Math.max(0, Math.floor(maxCandidates)));
  }

  const seqByComponent = new Map<string, number>();
  const proposals: HarnessProposal[] = [];
  for (const bottleneck of report.bottlenecks) {
    if (proposals.length >= budget) break;
    if (pruned.has(bottleneck.component) && bottleneck.severity !== "high") {
      continue;
    }
    const seq = (seqByComponent.get(bottleneck.component) ?? 0) + 1;
    seqByComponent.set(bottleneck.component, seq);
    const critic = screenCandidateDiff({
      diff: `${bottleneck.hypothesis}\n${bottleneck.recommendedAction}`
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n"),
      edits: [
        { component: bottleneck.component, hypothesis: bottleneck.hypothesis },
      ],
    });
    proposals.push({
      id: `rrsi-r${round}-${bottleneck.component}-${seq}`,
      component: bottleneck.component,
      severity: bottleneck.severity,
      targetMetric: bottleneck.metric,
      hypothesis: bottleneck.hypothesis,
      recommendedAction: bottleneck.recommendedAction,
      critic,
      requiresApproval: true,
      autoApply: false,
    });
  }

  return {
    round,
    totalRounds,
    budget,
    stallFlag: summary.stallFlag,
    prunedComponents: summary.pruneSet,
    proposals,
  };
}

/**
 * Stateless admissibility check for one candidate against its baseline.
 * Pure wrapper over selectAdmissibleCandidate; also returns a ready-to-append
 * EditLedgerEntry — persistence is the caller's decision, never this module's.
 */
export function evaluateProposalCandidate(input: {
  baseline: ProposalBaseline;
  candidate: RrsiCandidate;
  policy?: ProposalPolicy;
  meta?: ProposalMeta;
}): {
  selection: ReturnType<typeof selectAdmissibleCandidate>;
  ledgerEntry: EditLedgerEntry;
} {
  const { baseline, candidate, policy = {}, meta = {} } = input;
  const cfg = policy.config
    ? { ...DEFAULT_SELECTION_CONFIG, ...policy.config, guards: Array.isArray(policy.config.guards) ? policy.config.guards : DEFAULT_SELECTION_CONFIG.guards }
    : DEFAULT_SELECTION_CONFIG;
  const selection = selectAdmissibleCandidate({
    incumbentScore: baseline.score,
    bestScore: policy.bestScore ?? baseline.score,
    incumbentCost: baseline.cost,
    delta: policy.delta ?? STALL_DELTA,
    config: cfg,
    candidates: [candidate],
  });
  const accepted = selection.winner?.id === candidate.id;
  return {
    selection,
    ledgerEntry: {
      round: meta.round ?? 0,
      variant: meta.variant ?? candidate.id,
      component: meta.component ?? (Array.isArray(candidate.components) ? candidate.components[0] : undefined) ?? "unknown",
      hypothesis: meta.hypothesis ?? "",
      diffRef: meta.diffRef ?? candidate.id,
      deltaScore: candidate.score - baseline.score,
      deltaCost: relativeCostChange(baseline.cost, candidate.cost),
      accepted,
      verdict: accepted ? "winner" : "rejected",
    },
  };
}
