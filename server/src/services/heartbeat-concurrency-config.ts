export interface ConcurrencyPolicyConfig {
  maxConcurrentRuns: number;
  reserveInteractiveHeadroom: boolean;
  coalesceWindowMs: number;
  starvationWarningMs: number;
  maxDelegationDepth: number;
  maxActiveChildren: number;
}

export const DEFAULT_CONCURRENCY_POLICY: ConcurrencyPolicyConfig = {
  maxConcurrentRuns: 1,
  reserveInteractiveHeadroom: true,
  coalesceWindowMs: 10_000,
  starvationWarningMs: 600_000,
  maxDelegationDepth: 3,
  maxActiveChildren: 4,
};

type NumericPolicyField = Exclude<keyof ConcurrencyPolicyConfig, "reserveInteractiveHeadroom">;

const NUMERIC_BOUNDS: Record<NumericPolicyField, { min: number; max: number }> = {
  maxConcurrentRuns: { min: 1, max: 10 },
  coalesceWindowMs: { min: 0, max: 60_000 },
  starvationWarningMs: { min: 60_000, max: 3_600_000 },
  maxDelegationDepth: { min: 1, max: 6 },
  maxActiveChildren: { min: 1, max: 10 },
};

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

function normalizeNumericField(
  field: NumericPolicyField,
  value: unknown,
  defaultValue: number,
  warnings: string[],
): number {
  if (value === undefined) return defaultValue;

  const { min, max } = NUMERIC_BOUNDS[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`${field} is invalid: expected a finite number, got ${formatValue(value)}; defaulted to ${defaultValue}.`);
    return defaultValue;
  }
  if (value < min) {
    warnings.push(`${field} is out of range: got ${value}, minimum is ${min}; clamped to ${min}.`);
    return min;
  }
  if (value > max) {
    warnings.push(`${field} is out of range: got ${value}, maximum is ${max}; clamped to ${max}.`);
    return max;
  }
  return value;
}

function normalizeReserveInteractiveHeadroom(
  value: unknown,
  defaultValue: boolean,
  warnings: string[],
): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;

  warnings.push(`reserveInteractiveHeadroom is invalid: expected a boolean, got ${formatValue(value)}; defaulted to ${defaultValue}.`);
  return defaultValue;
}

export function normalizeConcurrencyPolicy(
  raw: Record<string, unknown> | null | undefined,
): { config: ConcurrencyPolicyConfig; warnings: string[] } {
  const source = raw ?? {};
  const warnings: string[] = [];

  return {
    config: {
      maxConcurrentRuns: normalizeNumericField(
        "maxConcurrentRuns",
        source.maxConcurrentRuns,
        DEFAULT_CONCURRENCY_POLICY.maxConcurrentRuns,
        warnings,
      ),
      reserveInteractiveHeadroom: normalizeReserveInteractiveHeadroom(
        source.reserveInteractiveHeadroom,
        DEFAULT_CONCURRENCY_POLICY.reserveInteractiveHeadroom,
        warnings,
      ),
      coalesceWindowMs: normalizeNumericField(
        "coalesceWindowMs",
        source.coalesceWindowMs,
        DEFAULT_CONCURRENCY_POLICY.coalesceWindowMs,
        warnings,
      ),
      starvationWarningMs: normalizeNumericField(
        "starvationWarningMs",
        source.starvationWarningMs,
        DEFAULT_CONCURRENCY_POLICY.starvationWarningMs,
        warnings,
      ),
      maxDelegationDepth: normalizeNumericField(
        "maxDelegationDepth",
        source.maxDelegationDepth,
        DEFAULT_CONCURRENCY_POLICY.maxDelegationDepth,
        warnings,
      ),
      maxActiveChildren: normalizeNumericField(
        "maxActiveChildren",
        source.maxActiveChildren,
        DEFAULT_CONCURRENCY_POLICY.maxActiveChildren,
        warnings,
      ),
    },
    warnings,
  };
}
