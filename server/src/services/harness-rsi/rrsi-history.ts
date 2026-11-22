// server/src/services/harness-rsi/rrsi-history.ts
//
// [파일 목적] RRSI 편집 이력 원장 L_t (Stage 1, 순수 함수 — 파일 I/O는 호출자 책임).
//   컴포넌트 분류 상수, JSONL 파싱·직렬화, summarizeEditHistory(tried/untried,
//   recentYield, stallFlag(S_t - S_{t-w} <= delta), pruneSet, 구조적 참신성).

/** Harness component taxonomy absorbed from RRSI/Harness2 (universal runtime set). */
export const HARNESS_COMPONENTS = [
  "system_prompt",
  "guardrails",
  "memory",
  "tool_guidance",
  "subagents",
  "skills",
  "scripts",
  "plugins",
  "workflow_dag",
  "adapter_config",
] as const;

export type HarnessComponent = (typeof HARNESS_COMPONENTS)[number];

/** Structural subset: touching these counts toward structural novelty. */
export const STRUCTURAL_NOVELTY_COMPONENTS = [
  "tool_guidance",
  "skills",
  "memory",
  "subagents",
  "plugins",
] as const;

export interface EditHistoryRecord {
  round: number;
  variant: string;
  component: string;
  hypothesis: string;
  diffRef: string;
  deltaScore: number;
  deltaCost: number;
  accepted: boolean;
  verdict: string;
}

export interface EditHistorySummary {
  triedComponents: string[];
  untriedComponents: string[];
  recentYieldByComponent: Record<string, number>;
  stallFlag: boolean;
  pruneSet: string[];
  computeStructuralNovelty: (candidateComponents: string[]) => number;
}

/**
 * Count of structural component types in candidateComponents that never appeared
 * in an accepted winning edit (record.accepted === true). Duplicate mentions of
 * the same component count once.
 */
export function computeStructuralNovelty(
  candidateComponents: string[],
  records: EditHistoryRecord[],
): number {
  const acceptedComponents = new Set(
    records.filter((r) => r.accepted).map((r) => r.component),
  );
  const structural = new Set<string>(STRUCTURAL_NOVELTY_COMPONENTS);
  let novelty = 0;
  for (const component of new Set(candidateComponents)) {
    if (structural.has(component) && !acceptedComponents.has(component)) {
      novelty += 1;
    }
  }
  return novelty;
}

/**
 * Summarize the edit ledger for the current round.
 * - recentYield: sum of deltaScore over records with
 *   currentRound - pruneWindow + 1 <= round <= currentRound (all attempts count).
 * - pruneSet: tried components whose recentYield is <= 0 — includes components
 *   tried only outside the window (no recent yield evidence).
 * - stallFlag: S_t - S_{t-w} <= delta over options.roundScores indexed by round;
 *   false when the window does not fit inside recorded history.
 */
export function summarizeEditHistory(
  records: EditHistoryRecord[],
  options: {
    currentRound: number;
    stallWindow: number;
    pruneWindow: number;
    delta: number;
    roundScores: number[];
  },
): EditHistorySummary {
  const { currentRound, stallWindow, pruneWindow, delta, roundScores } = options;

  const knownOrder = new Set<string>(HARNESS_COMPONENTS);
  const triedSeen = new Set<string>();
  const triedUnknown: string[] = [];
  for (const rec of records) {
    if (triedSeen.has(rec.component)) continue;
    triedSeen.add(rec.component);
    if (!knownOrder.has(rec.component)) triedUnknown.push(rec.component);
  }
  const triedComponents = [
    ...HARNESS_COMPONENTS.filter((c) => triedSeen.has(c)),
    ...triedUnknown,
  ];
  const untriedComponents = HARNESS_COMPONENTS.filter((c) => !triedSeen.has(c));

  const windowStart = currentRound - pruneWindow + 1;
  const recentYieldByComponent: Record<string, number> = {};
  for (const rec of records) {
    if (rec.round < windowStart || rec.round > currentRound) continue;
    recentYieldByComponent[rec.component] =
      (recentYieldByComponent[rec.component] ?? 0) + rec.deltaScore;
  }
  const pruneSet = triedComponents.filter(
    (c) => (recentYieldByComponent[c] ?? 0) <= 0,
  );

  const now: number | undefined = roundScores[currentRound];
  const pastIndex = currentRound - stallWindow;
  const past: number | undefined =
    pastIndex >= 0 ? roundScores[pastIndex] : undefined;
  const stallFlag =
    stallWindow >= 1 && now !== undefined && past !== undefined && now - past <= delta;

  return {
    triedComponents,
    untriedComponents,
    recentYieldByComponent,
    stallFlag,
    pruneSet,
    computeStructuralNovelty: (candidateComponents) =>
      computeStructuralNovelty(candidateComponents, records),
  };
}

function isEditHistoryRecord(v: unknown): v is EditHistoryRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.round === "number" &&
    typeof r.variant === "string" &&
    typeof r.component === "string" &&
    typeof r.hypothesis === "string" &&
    typeof r.diffRef === "string" &&
    typeof r.deltaScore === "number" &&
    typeof r.deltaCost === "number" &&
    typeof r.accepted === "boolean" &&
    typeof r.verdict === "string"
  );
}

/**
 * Parse a JSONL ledger. Blank lines are skipped; lines that fail to parse or
 * lack the record shape are dropped — a corrupt line must not kill the loop.
 */
export function parseEditHistoryJsonl(raw: string): EditHistoryRecord[] {
  const out: EditHistoryRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isEditHistoryRecord(parsed)) out.push(parsed);
    } catch {
      // malformed ledger line — skip
    }
  }
  return out;
}

/** Serialize one ledger record to a single JSONL line. */
export function serializeEditHistoryRecord(rec: EditHistoryRecord): string {
  return JSON.stringify(rec);
}
