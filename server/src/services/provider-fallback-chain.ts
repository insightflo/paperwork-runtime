/**
 * 프로바이더 폴백 체인 선택기.
 * 실행(run)을 기본 어댑터/모델로 보낼 수 없을 때(쿨다운·인증 차단·서킷 브레이커 오픈),
 * 체인 순서대로 다음 건강한 후보를 고르는 순수 결정적 모듈.
 * DB·런타임 부수효과 없음 — 판정에 필요한 상태는 모두 인자로 받는다.
 */

export interface FallbackCandidate {
  adapterType: string;
  model: string;
  provider: string;
}

export interface ProviderHealthState {
  provider: string;
  coolingDown?: boolean;
  authFatal?: boolean;
  circuitOpen?: boolean;
}

export type FallbackSkipReason = "auth_fatal" | "circuit_open" | "cooling_down";

export interface FallbackSelectionResult {
  selected: FallbackCandidate | null;
  usedFallback: boolean;
  skipped: Array<{ candidate: FallbackCandidate; reason: FallbackSkipReason }>;
}

/**
 * 체인을 순서대로 순회하며 첫 건강한 후보를 반환한다.
 * 건너뛰기 사유 우선순위는 auth_fatal → circuit_open → cooling_down 고정:
 * 인증 치명 오류는 자격 증명 자체가 무효라 재시도 의미가 없고,
 * 서킷 오픈은 공급자가 호출 자체를 거부 중이며,
 * 쿨다운은 일시적 속도 제한이라 가장 덜 치명적이기 때문이다.
 * 한 프로바이더에 여러 플래그가 켜져 있으면 더 치명적인 사유 하나만 기록한다.
 */
export function selectHealthyFallbackCandidate(
  chain: readonly FallbackCandidate[],
  healthStates: readonly ProviderHealthState[],
): FallbackSelectionResult {
  const healthByProvider = new Map<string, ProviderHealthState>();
  for (const state of healthStates) {
    healthByProvider.set(state.provider, state);
  }

  const skipped: FallbackSelectionResult["skipped"] = [];

  for (let index = 0; index < chain.length; index += 1) {
    const candidate = chain[index];
    const health = healthByProvider.get(candidate.provider);

    const reason = health ? skipReasonFor(health) : null;
    if (reason === null) {
      return {
        selected: candidate,
        usedFallback: index > 0,
        skipped,
      };
    }
    skipped.push({ candidate, reason });
  }

  return { selected: null, usedFallback: false, skipped };
}

function skipReasonFor(health: ProviderHealthState): FallbackSkipReason | null {
  if (health.authFatal) return "auth_fatal";
  if (health.circuitOpen) return "circuit_open";
  if (health.coolingDown) return "cooling_down";
  return null;
}
