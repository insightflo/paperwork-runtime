// server/src/services/harness-rsi/rrsi-selection.ts
//
// [파일 목적] RRSI 선택-측 정규화 코어 (Stage 1, 순수 함수 — I/O·시간·외부 상태 없음).
//   코사인 어니일링 편집 예산, 상대 비용 변화, 비용 규칙(명확 개선 시 비용 상한,
//   노이즈 밴드 내 형성 점수), 노이즈 하한 + 비보상 가드 + 비용 규칙을 통과한
//   admissible 후보의 argmax 선택.

/** Non-compensatory domain guard: candidate.metrics[metric] must satisfy `op value`. */
export interface DomainGuard {
  metric: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  value: number;
  name?: string;
}

export interface SelectionConfig {
  beta0: number;
  beta1: number;
  wScore: number;
  wCost: number;
  wNovelty: number;
  guards?: DomainGuard[];
}

export interface RrsiCandidate {
  id: string;
  score: number;
  cost: number;
  components: string[];
  novelty?: number;
  metrics?: Record<string, number>;
}

export interface SelectionDecision {
  candidateId: string;
  admissible: boolean;
  reason: string;
}

/**
 * b_t = ceil(bMin + (bMax - bMin) * 0.5 * (1 + cos(pi * clampedT / T))).
 * The inner 1e9 rounding absorbs cos(pi/2) float noise; T <= 0 resolves to
 * bMax (matching RRSI schedule.py), while t >= T resolves to bMin.
 */
export function editBudget(
  round: number,
  totalRounds: number,
  bMin: number,
  bMax: number,
): number {
  if (totalRounds <= 0) return Math.trunc(bMax);
  const clampedT = Math.min(Math.max(round, 0), totalRounds);
  const T = totalRounds;
  return Math.ceil(
    Math.round(
      (bMin + (bMax - bMin) * 0.5 * (1 + Math.cos(Math.PI * clampedT / T))) * 1e9,
    ) / 1e9,
  );
}

/**
 * (candidateCost - incumbentCost) / incumbentCost. incumbentCost <= 0 cannot
 * anchor a ratio: 0 when the candidate is also non-positive, +Infinity when
 * cost materializes from a free baseline.
 */
export function relativeCostChange(
  incumbentCost: number,
  candidateCost: number,
): number {
  if (incumbentCost <= 0) {
    return candidateCost <= 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return (candidateCost - incumbentCost) / incumbentCost;
}

/** Deterministic cost gate evaluated after the noise floor and domain guards. */
export function evaluateCostRule(input: {
  deltaScore: number;
  deltaCost: number;
  novelty: number;
  delta: number;
  config: SelectionConfig;
}): { ok: boolean; reason: string } {
  const { deltaScore, deltaCost, novelty, delta, config } = input;
  if (deltaScore > delta) {
    const bound = config.beta0 + config.beta1 * deltaScore;
    return deltaCost <= bound
      ? { ok: true, reason: "clear-improvement-within-cost-bound" }
      : { ok: false, reason: `clear-improvement-cost-exceeded:${deltaCost}>${bound}` };
  }
  const shaped =
    config.wScore * deltaScore -
    config.wCost * deltaCost +
    config.wNovelty * novelty;
  return shaped > 0
    ? { ok: true, reason: "within-band-shaped-score-positive" }
    : { ok: false, reason: `within-band-shaped-score-nonpositive:${shaped}` };
}

const GUARD_OPS: Record<DomainGuard["op"], (m: number, v: number) => boolean> = {
  eq: (m, v) => m === v,
  neq: (m, v) => m !== v,
  gt: (m, v) => m > v,
  gte: (m, v) => m >= v,
  lt: (m, v) => m < v,
  lte: (m, v) => m <= v,
};

/** Fail-closed: a candidate missing the guarded metric never satisfies it. */
function guardPasses(
  guard: DomainGuard,
  metrics: Record<string, number> | undefined,
): boolean {
  const m = metrics?.[guard.metric];
  return m !== undefined && GUARD_OPS[guard.op](m, guard.value);
}

export function selectAdmissibleCandidate(input: {
  incumbentScore: number;
  bestScore: number;
  incumbentCost: number;
  delta: number;
  config: SelectionConfig;
  candidates: RrsiCandidate[];
}): {
  winner: RrsiCandidate | null;
  decisions: SelectionDecision[];
  nextBestScore: number;
} {
  const { incumbentScore, bestScore, incumbentCost, delta, config, candidates } =
    input;
  const floor = bestScore - delta;
  const guards = config.guards ?? [];
  const decisions: SelectionDecision[] = [];
  let winner: RrsiCandidate | null = null;

  for (const c of candidates) {
    const failedGuard = guards.find((g) => !guardPasses(g, c.metrics));
    const rule =
      c.score < floor
        ? { ok: false, reason: `below-noise-floor:${c.score}<${floor}` }
        : failedGuard
          ? {
              ok: false,
              reason: `guard-failed:${failedGuard.name ?? failedGuard.metric}`,
            }
          : evaluateCostRule({
              deltaScore: c.score - incumbentScore,
              deltaCost: relativeCostChange(incumbentCost, c.cost),
              novelty: c.novelty ?? 0,
              delta,
              config,
            });
    decisions.push({ candidateId: c.id, admissible: rule.ok, reason: rule.reason });
    if (
      rule.ok &&
      (winner === null ||
        c.score > winner.score ||
        (c.score === winner.score && c.cost < winner.cost))
    ) {
      winner = c;
    }
  }

  return {
    winner,
    decisions,
    nextBestScore: winner ? Math.max(bestScore, winner.score) : bestScore,
  };
}
