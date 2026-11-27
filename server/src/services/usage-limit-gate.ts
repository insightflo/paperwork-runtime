// [usage-limit-gate] 어댑터/프로바이더/모델 단위 사용량 제한·실패 홀드 게이트.
// OpenBot UsageLimitGate 를 본떠 만든 deterministic in-memory 게이트다.
// - 키는 정규화된 (adapterType, provider, model) 튜플이다(trim, 빈 값 → null).
// - 홀드는 절대 만료 시각(ms) 하나로 관리하고, 더 긴 기존 홀드를 짧게 줄이지 않는다.
// - 조회(isBlocked/getSnapshot) 시 만료된 항목을 즉시 정리한다.
// 실행기(heartbeat) 밖 상태를 전혀 공유하지 않으므로 테스트 격리는 clear() 로 한다.

export const DEFAULT_PROVIDER_FAILURE_HOLD_MS = 10 * 60_000; // 10분
export const DEFAULT_QUOTA_RESET_GRACE_MS = 30_000; // 30초
export const DEFAULT_QUOTA_FALLBACK_HOLD_MS = 15 * 60_000; // resetsAt 을 모를 때의 기본 홀드 15분

export type UsageLimitKey = {
  adapterType?: string | null;
  provider?: string | null;
  model?: string | null;
};

export type UsageLimitBlockStatus = {
  blocked: boolean;
  kind: "ready" | "limit" | "failed";
  resetsAtMs: number | null;
  reason?: string;
};

export type UsageLimitEntrySnapshot = {
  adapterType: string | null;
  provider: string | null;
  model: string | null;
  kind: "limit" | "failed";
  resetsAtMs: number;
  reason: string | null;
};

export type UsageLimitGateSnapshot = {
  limitedModels: UsageLimitEntrySnapshot[];
  failedModels: UsageLimitEntrySnapshot[];
};

type UsageLimitEntry = {
  kind: "limit" | "failed";
  holdUntilMs: number;
  reason: string | null;
  adapterType: string | null;
  provider: string | null;
  model: string | null;
};

function normalizePart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function usageLimitKeyToString(key: UsageLimitKey): string {
  return JSON.stringify([
    normalizePart(key.adapterType),
    normalizePart(key.provider),
    normalizePart(key.model),
  ]);
}

function keyPartsFrom(keyString: string): { adapterType: string | null; provider: string | null; model: string | null } {
  const [adapterType, provider, model] = JSON.parse(keyString) as [string | null, string | null, string | null];
  return { adapterType, provider, model };
}

function finiteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createUsageLimitGate() {
  const entries = new Map<string, UsageLimitEntry>();

  function pruneExpired(nowMs: number): void {
    for (const [keyString, entry] of entries) {
      if (entry.holdUntilMs <= nowMs) entries.delete(keyString);
    }
  }

  /** 기록한다. neverShorten 이 true 면 기존 홀드가 더 길 때 기존 항목을 유지한다(절대 단축 금지). */
  function hold(keyString: string, parts: { adapterType: string | null; provider: string | null; model: string | null }, kind: "limit" | "failed", holdUntilMs: number, reason: string | null, neverShorten: boolean): void {
    const existing = entries.get(keyString);
    if (neverShorten && existing && existing.holdUntilMs > holdUntilMs) return;
    entries.set(keyString, { kind, holdUntilMs, reason, ...parts });
  }

  function snapshotEntry(keyString: string, entry: UsageLimitEntry): UsageLimitEntrySnapshot {
    const parts = keyPartsFrom(keyString);
    return {
      adapterType: parts.adapterType,
      provider: parts.provider,
      model: parts.model,
      kind: entry.kind,
      resetsAtMs: entry.holdUntilMs,
      reason: entry.reason,
    };
  }

  return {
    /** 쿼터 초과 기록. resetsAtMs 가 미래면 resetsAtMs + grace 까지, 아니면 now + 기본 홀드(15분)까지 유지한다. */
    recordQuotaLimit(key: UsageLimitKey, opts?: { resetsAtMs?: number | null; nowMs?: number; reason?: string }): void {
      const nowMs = opts?.nowMs ?? Date.now();
      const resetsAtMs = finiteMs(opts?.resetsAtMs);
      const holdUntilMs =
        resetsAtMs !== null && resetsAtMs > nowMs
          ? resetsAtMs + DEFAULT_QUOTA_RESET_GRACE_MS
          : nowMs + DEFAULT_QUOTA_FALLBACK_HOLD_MS;
      const keyString = usageLimitKeyToString(key);
      hold(keyString, keyPartsFrom(keyString), "limit", holdUntilMs, opts?.reason ?? null, true);
    },

    /** 프로바이더 실패 기록. now + (cooldownMs ?? 기본 10분)까지 유지한다. */
    recordProviderFailure(key: UsageLimitKey, opts?: { cooldownMs?: number; nowMs?: number; reason?: string }): void {
      const nowMs = opts?.nowMs ?? Date.now();
      const cooldownMs = finiteMs(opts?.cooldownMs);
      const holdUntilMs = nowMs + (cooldownMs !== null && cooldownMs > 0 ? cooldownMs : DEFAULT_PROVIDER_FAILURE_HOLD_MS);
      const keyString = usageLimitKeyToString(key);
      hold(keyString, keyPartsFrom(keyString), "failed", holdUntilMs, opts?.reason ?? null, false);
    },

    /** 성공 시 이 키의 limit/failed 항목을 즉시 모두 지운다. */
    recordSuccess(key: UsageLimitKey): void {
      entries.delete(usageLimitKeyToString(key));
    },

    /** 만료 항목을 정리한 뒤 이 키의 차단 상태를 반환한다. */
    isBlocked(key: UsageLimitKey, nowMs?: number): UsageLimitBlockStatus {
      const atMs = nowMs ?? Date.now();
      pruneExpired(atMs);
      const entry = entries.get(usageLimitKeyToString(key));
      if (!entry) return { blocked: false, kind: "ready", resetsAtMs: null };
      return {
        blocked: true,
        kind: entry.kind,
        resetsAtMs: entry.holdUntilMs,
        ...(entry.reason !== null ? { reason: entry.reason } : {}),
      };
    },

    /** 만료 항목을 정리한 뒤 활성 limit/failed 항목 목록을 반환한다. */
    getSnapshot(nowMs?: number): UsageLimitGateSnapshot {
      const atMs = nowMs ?? Date.now();
      pruneExpired(atMs);
      const limitedModels: UsageLimitEntrySnapshot[] = [];
      const failedModels: UsageLimitEntrySnapshot[] = [];
      for (const [keyString, entry] of entries) {
        (entry.kind === "limit" ? limitedModels : failedModels).push(snapshotEntry(keyString, entry));
      }
      return { limitedModels, failedModels };
    },

    /** 테스트 격리용: 모든 상태를 지운다. */
    clear(): void {
      entries.clear();
    },
  };
}

export type UsageLimitGate = ReturnType<typeof createUsageLimitGate>;

export const globalUsageLimitGate = createUsageLimitGate();
