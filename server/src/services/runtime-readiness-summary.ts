// Pure company-level runtime readiness rollup for ops dashboards.
// Display text only; callers must not use the headline as execution authority.

export type RuntimeReadinessGrade = "ready" | "degraded" | "blocked";

export interface RuntimeReadinessInput {
  companyId: string;
  readyAdapters: readonly string[];
  missingAdapters?: readonly string[];
  totalSlots: number;
  totalRunning: number;
  totalQueued: number;
  criticalAlertCount: number;
  budgetExhaustedMissions?: number;
}

export interface RuntimeReadinessSummary {
  companyId: string;
  grade: RuntimeReadinessGrade;
  readyAdapters: string[];
  missingAdapters: string[];
  totalSlots: number;
  totalRunning: number;
  totalQueued: number;
  criticalAlertCount: number;
  budgetExhaustedMissions: number;
  headline: string;
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return Array.from(new Set(values ?? [])).sort();
}

function clampCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function deriveGrade(input: {
  readyAdapterCount: number;
  missingAdapterCount: number;
  totalSlots: number;
  criticalAlertCount: number;
  budgetExhaustedMissions: number;
}): RuntimeReadinessGrade {
  if (input.readyAdapterCount === 0 || input.totalSlots === 0 || input.criticalAlertCount > 0) {
    return "blocked";
  }
  if (input.missingAdapterCount > 0 || input.budgetExhaustedMissions > 0) {
    return "degraded";
  }
  return "ready";
}

function buildHeadline(input: {
  grade: RuntimeReadinessGrade;
  readyAdapterCount: number;
  missingAdapterCount: number;
  totalSlots: number;
  totalRunning: number;
  totalQueued: number;
  criticalAlertCount: number;
  budgetExhaustedMissions: number;
}): string {
  const label = input.grade === "ready" ? "준비 완료" : input.grade === "degraded" ? "저하" : "차단";
  return `${label}: 준비 어댑터 ${input.readyAdapterCount}개, 미준비 ${input.missingAdapterCount}개, 실행 ${input.totalRunning}/${input.totalSlots} 슬롯, 대기 ${input.totalQueued}개, 치명 알림 ${input.criticalAlertCount}개, 예산 소진 미션 ${input.budgetExhaustedMissions}개`;
}

export function buildRuntimeReadinessSummary(input: RuntimeReadinessInput): RuntimeReadinessSummary {
  const readyAdapters = uniqueSorted(input.readyAdapters);
  const missingAdapters = uniqueSorted(input.missingAdapters);
  const totalSlots = clampCount(input.totalSlots);
  const totalRunning = clampCount(input.totalRunning);
  const totalQueued = clampCount(input.totalQueued);
  const criticalAlertCount = clampCount(input.criticalAlertCount);
  const budgetExhaustedMissions = clampCount(input.budgetExhaustedMissions);
  const grade = deriveGrade({
    readyAdapterCount: readyAdapters.length,
    missingAdapterCount: missingAdapters.length,
    totalSlots,
    criticalAlertCount,
    budgetExhaustedMissions,
  });

  return {
    companyId: input.companyId,
    grade,
    readyAdapters,
    missingAdapters,
    totalSlots,
    totalRunning,
    totalQueued,
    criticalAlertCount,
    budgetExhaustedMissions,
    headline: buildHeadline({
      grade,
      readyAdapterCount: readyAdapters.length,
      missingAdapterCount: missingAdapters.length,
      totalSlots,
      totalRunning,
      totalQueued,
      criticalAlertCount,
      budgetExhaustedMissions,
    }),
  };
}
