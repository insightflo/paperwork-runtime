export type ProviderErrorClass = "rate_limit" | "overloaded" | "network_transient" | "auth_fatal" | "unknown";

type ProviderFailureInput = {
  errorMessage?: string | null;
  stderr?: string | null;
  exitCode?: number | null;
};

const DEFAULT_BASE_MS = 15_000;
const DEFAULT_MAX_MS = 300_000;
const DEFAULT_CIRCUIT_THRESHOLD = 3;

function failureText(input: ProviderFailureInput): string {
  return [input.errorMessage, input.stderr]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .toLowerCase();
}

function hasStatusCode(text: string, statusCode: number): boolean {
  return new RegExp(`(?<![0-9a-z])${statusCode}(?![0-9a-z])`).test(text);
}

function hasAnyPhrase(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

export function classifyProviderFailure(input: ProviderFailureInput): ProviderErrorClass {
  const text = failureText(input);
  if (text.length === 0) return "unknown";

  if (hasStatusCode(text, 401) || hasStatusCode(text, 403) || hasAnyPhrase(text, [
    "invalid api key",
    "unauthorized",
    "authentication failed",
  ])) {
    return "auth_fatal";
  }

  if (hasStatusCode(text, 429) || hasAnyPhrase(text, [
    "rate limit",
    "rate-limit",
    "too many requests",
    "quota exceeded",
  ])) {
    return "rate_limit";
  }

  if (hasStatusCode(text, 503) || hasStatusCode(text, 529) || hasAnyPhrase(text, [
    "overloaded",
    "capacity",
    "temporarily unavailable",
  ])) {
    return "overloaded";
  }

  if (hasStatusCode(text, 502) || hasStatusCode(text, 504) || hasAnyPhrase(text, [
    "econnreset",
    "etimedout",
    "fetch failed",
    "socket hang up",
  ])) {
    return "network_transient";
  }

  return "unknown";
}

export function computeProviderBackoffMs(opts: {
  errorClass: ProviderErrorClass;
  consecutiveFailures: number;
  retryAfterSec?: number | null;
  baseMs?: number;
  maxMs?: number;
}): { retryable: boolean; delayMs: number; cooldownUntilIso?: string } {
  if (opts.errorClass === "auth_fatal" || opts.errorClass === "unknown") {
    return { retryable: false, delayMs: 0 };
  }

  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const exponentialDelayMs = Math.min(
    maxMs,
    baseMs * 2 ** Math.max(0, opts.consecutiveFailures - 1),
  );
  const retryAfterMs = typeof opts.retryAfterSec === "number" ? opts.retryAfterSec * 1000 : null;
  const delayMs = retryAfterMs !== null && retryAfterMs > exponentialDelayMs
    ? Math.min(maxMs, retryAfterMs)
    : exponentialDelayMs;

  return { retryable: true, delayMs };
}

export function shouldTripProviderCircuit(opts: {
  consecutiveFailures: number;
  errorClass: ProviderErrorClass;
  threshold?: number;
}): boolean {
  const threshold = opts.threshold ?? DEFAULT_CIRCUIT_THRESHOLD;
  if (opts.errorClass === "auth_fatal") return opts.consecutiveFailures >= 1;
  if (opts.errorClass === "unknown") return false;
  return opts.consecutiveFailures >= threshold;
}
