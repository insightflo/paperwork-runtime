/**
 * 제공자 계정 풀 계정 선택(OpenBot pickPoolAccount 알고리즘 이식).
 *
 * 결정론적 선택 규칙:
 * - 짧은 사용량 창(≤24h)은 15% 버퍼(사용 <85% 사용 가능), 긴 창(>24h)은 5% 버퍼(<95%),
 *   기간 미상 창은 10% 버퍼(<90%)를 남긴다.
 * - 재설정 시각이 지난 창은 사용률 0% 로 취급한다(한도가 이미 풀렸다).
 * - earliest_reset 전략은 "여유분이 가장 먼저 재설정되는" 계정을 고르고,
 *   재설정 시각이 10분 이내로 겹치면 현재 계정에 머문다(스틱키).
 * - 전원이 버퍼를 소진했으면 남은 여유(max usedNow 기준)가 가장 큰 계정으로 폴백한다.
 */

export interface AccountUsageWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAtEpochSec: number | null;
}

export interface PoolCandidate {
  accountId: string;
  primary?: AccountUsageWindow | null;
  secondary?: AccountUsageWindow | null;
}

export type PoolStrategy = "earliest_reset" | "round_robin" | "manual";

/** 짧은 창 기준(분). 이하면 15% 버퍼, 초과면 5% 버퍼. */
export const SHORT_WINDOW_MINUTES = 24 * 60;
/** 두 재설정 시각의 차이가 이 값(초) 미만이면 동률로 보고 현재 계정에 머문다. */
export const SAME_RESET_SECONDS = 10 * 60;

export interface PickPoolAccountInput {
  candidates: readonly PoolCandidate[];
  currentAccountId?: string | null;
  nowEpochSec?: number;
  strategy?: PoolStrategy;
}

function windowsOf(candidate: PoolCandidate): AccountUsageWindow[] {
  return [candidate.primary, candidate.secondary].filter((w): w is AccountUsageWindow => w !== null && w !== undefined);
}

/** 창별 버퍼(%). 기간 미상 10%, 짧은 창 15%, 긴 창 5%. */
function bufferPercent(window: AccountUsageWindow): number {
  if (window.windowDurationMins === null) return 10;
  return window.windowDurationMins <= SHORT_WINDOW_MINUTES ? 15 : 5;
}

function isExpired(window: AccountUsageWindow, nowEpochSec: number): boolean {
  return window.resetsAtEpochSec !== null && window.resetsAtEpochSec <= nowEpochSec;
}

/** 재설정이 지난 창은 0% 사용으로 본다. */
function usedNow(window: AccountUsageWindow, nowEpochSec: number): number {
  return isExpired(window, nowEpochSec) ? 0 : window.usedPercent;
}

/** 모든 창이 버퍼 안에 있어야 사용 가능하다(하나라도 소진되면 못 쓴다). */
function isUsable(candidate: PoolCandidate, nowEpochSec: number): boolean {
  return windowsOf(candidate).every((w) => usedNow(w, nowEpochSec) < 100 - bufferPercent(w));
}

function maxUsedNow(candidate: PoolCandidate, nowEpochSec: number): number {
  const windows = windowsOf(candidate);
  return windows.length === 0 ? 0 : Math.max(...windows.map((w) => usedNow(w, nowEpochSec)));
}

/**
 * 재설정 순위값: 활성 창들 중 기간이 가장 긴 창의 재설정 시각.
 * 재설정이 미확인이면 +Infinity(마지막에 고려). 활성 창이 없으면 전체 창 기준.
 */
function longestReset(candidate: PoolCandidate, nowEpochSec: number): number {
  const windows = windowsOf(candidate);
  if (windows.length === 0) return Number.POSITIVE_INFINITY;
  const active = windows.filter((w) => !isExpired(w, nowEpochSec));
  const pool = active.length > 0 ? active : windows;
  const longest = pool.reduce((best, w) =>
    (w.windowDurationMins ?? -1) > (best.windowDurationMins ?? -1) ? w : best, pool[0]);
  return longest.resetsAtEpochSec ?? Number.POSITIVE_INFINITY;
}

function pickEarliestReset(candidates: readonly PoolCandidate[], currentAccountId: string | null, nowEpochSec: number): string {
  const open = candidates.filter((c) => isUsable(c, nowEpochSec));
  if (open.length === 0) {
    // 전원 소진: max usedNow 가 가장 낮은 계정. 동률이면 현재 계정 유지.
    let best = candidates[0];
    for (const candidate of candidates.slice(1)) {
      const diff = maxUsedNow(candidate, nowEpochSec) - maxUsedNow(best, nowEpochSec);
      if (diff < 0 || (diff === 0 && candidate.accountId === currentAccountId)) best = candidate;
    }
    return best.accountId;
  }
  const current = open.find((c) => c.accountId === currentAccountId);
  if (current) {
    const bestReset = Math.min(...open.map((c) => longestReset(c, nowEpochSec)));
    // 재설정 차이가 SAME_RESET_SECONDS 미만이면 동률 → 현재 계정에 머문다.
    if (longestReset(current, nowEpochSec) - bestReset < SAME_RESET_SECONDS) return current.accountId;
  }
  let best = open[0];
  for (const candidate of open.slice(1)) {
    const diff = longestReset(candidate, nowEpochSec) - longestReset(best, nowEpochSec);
    if (diff < 0 || (diff === 0 && candidate.accountId === currentAccountId)) best = candidate;
  }
  return best.accountId;
}

function pickRoundRobin(candidates: readonly PoolCandidate[], currentAccountId: string | null, nowEpochSec: number): string {
  const usable = candidates.filter((c) => isUsable(c, nowEpochSec));
  const pool = usable.length > 0 ? usable : [...candidates];
  const index = currentAccountId === null ? -1 : pool.findIndex((c) => c.accountId === currentAccountId);
  return index === -1 ? pool[0].accountId : pool[(index + 1) % pool.length].accountId;
}

function pickManual(candidates: readonly PoolCandidate[], currentAccountId: string | null): string {
  if (currentAccountId !== null && candidates.some((c) => c.accountId === currentAccountId)) return currentAccountId;
  return candidates[0].accountId;
}

export function pickPoolAccount(input: PickPoolAccountInput): string | null {
  const { candidates, currentAccountId = null, nowEpochSec, strategy = "earliest_reset" } = input;
  if (candidates.length === 0) return null;
  const nowEpoch = nowEpochSec ?? Math.floor(Date.now() / 1000);
  if (strategy === "manual") return pickManual(candidates, currentAccountId);
  if (strategy === "round_robin") return pickRoundRobin(candidates, currentAccountId, nowEpoch);
  return pickEarliestReset(candidates, currentAccountId, nowEpoch);
}

/** 숨김 모델 제외 — trim 후 대소문자 무시 정확 일치. 원본 모델 문자열은 그대로 유지. */
export function filterVisibleModels<T extends string>(models: readonly T[], hiddenModels?: readonly string[]): T[] {
  if (!hiddenModels || hiddenModels.length === 0) return [...models];
  const hidden = new Set(hiddenModels.map((m) => m.trim().toLowerCase()));
  return models.filter((m) => !hidden.has(m.trim().toLowerCase()));
}
