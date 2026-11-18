import { redactSensitiveText } from "@paperclipai/adapter-utils";

export type UserErrorKind =
  | "auth"
  | "permission"
  | "file-permission"
  | "rate-limit"
  | "network"
  | "timeout"
  | "storage"
  | "not-found"
  | "read-only"
  | "conflict"
  | "service"
  | "unknown";

const USER_ERROR_COPY: Record<Exclude<UserErrorKind, "unknown">, string> = {
  network: "Could not reach the runtime or remote service. Check connectivity and retry.",
  timeout: "The operation timed out before completing. Retry or inspect the run trace.",
  storage: "Disk storage limit reached. Free space before retrying.",
  "file-permission": "Access to a required workspace file was denied by OS permissions.",
  "not-found": "The requested resource or session could not be found.",
  "read-only": "The target filesystem or resource is read-only.",
  conflict: "A conflicting update or lock is active for this resource.",
  auth: "Authentication expired or credentials are invalid. Re-authenticate and retry.",
  permission: "Permission denied by the provider or policy control plane.",
  "rate-limit": "Provider capacity or quota limit reached. Wait for reset or switch provider.",
  service: "Upstream provider or backend service returned an internal error.",
};

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_NETWORK",
  "ERR_INTERNET_DISCONNECTED",
]);

const NETWORK_MESSAGE =
  /^(?:TypeError: )?(?:Failed to fetch|fetch failed|Network request failed|Load failed|NetworkError when attempting to fetch resource\.)$/iu;
const MESSAGE_PREFIX =
  /^(?:(?:Error invoking remote method '[^']+':|(?!(?:Type|Syntax|Reference|Range)Error:)(?:[A-Z]\w*)?Error(?:\[ref:[^\]\s]*\])?:)\s*)+/u;
const REFERENCE_PATTERN = /^(?=.{3,64}$)[a-z][a-z0-9_-]{0,15}(?:\/[A-Za-z0-9_.-]{1,40}){1,3}$/u;
const REFERENCE_PART = /^[A-Za-z0-9_.-]{1,40}$/u;
const REFERENCE_CARRIER = /(?:^|\s)(?:[A-Z]\w*)?Error\[ref:([^\]\s]{1,64})\]:/u;
const AUTH_SIGNALS =
  /\b401\s+unauthorized\b|\bunauthorized\s*\(\s*401\s*\)|\bhttp\s*401\b|"status"\s*:\s*401\b|\binvalid_api_key\b|\bnot authenticated\b|antigravity_auth_required|claude_auth_required|verification required/iu;
const RATE_LIMIT_SIGNALS =
  /\b429\s+too many requests\b|\blast status:\s*429\b|"status"\s*:\s*429\b|provider_quota_exhausted|provider_overloaded|usage limit reached|model_capacity_exhausted/iu;
const TECHNICAL_OUTPUT =
  /(?:\bSQLITE_\w+|\bERR_\w+|^E[A-Z_]+:|^Command failed|^spawn |\n\s*at |\[object Object\]|^\s*[<{[]|\/(?:Users|home|srv|tmp|private|var|etc|usr)\/|[A-Za-z]:\\)/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : isRecord(error) && typeof error.message === "string"
          ? error.message
          : "";
  return raw.trim().replace(MESSAGE_PREFIX, "");
}

function errnoCode(message: string): string | undefined {
  return message.match(/^(?:[a-z]+\s+)?(E[A-Z_]+)(?=[:\s]|$)/u)?.[1];
}

export function safeReference(value: unknown): string | null {
  return typeof value === "string" && REFERENCE_PATTERN.test(value) ? value : null;
}

export function referenceFrom(...parts: readonly (string | number | null | undefined)[]): string | null {
  const safe = parts
    .map((p) => (typeof p === "number" ? String(p) : p))
    .filter((p): p is string => typeof p === "string" && REFERENCE_PART.test(p));
  return safe.length > 0 ? safeReference(safe.join("/")) : null;
}

export function referenceCarrierName(reference: string): string {
  return `Error[ref:${reference}]`;
}

function codeToReference(code: string): string | null {
  if (/^SQLITE_[A-Z_]+$/u.test(code)) return referenceFrom("sqlite", code);
  if (/^(?:E[A-Z_]+|ERR_[A-Z_]+)$/u.test(code)) return referenceFrom("errno", code);
  return referenceFrom("code", code);
}

export function extractErrorReference(error: unknown, explicitCode?: string | null): string | null {
  if (isRecord(error)) {
    const directRef = safeReference(error.reference);
    if (directRef) return directRef;
    const status = typeof error.status === "number" && Number.isInteger(error.status) ? error.status : undefined;
    const code = typeof error.code === "string" && REFERENCE_PART.test(error.code) ? error.code : null;
    if (status !== undefined) return referenceFrom("http", status, code);
    if (code) return codeToReference(code);
  }
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const carried = raw.match(REFERENCE_CARRIER)?.[1];
  if (carried && safeReference(carried)) return carried;

  const message = normalizeErrorMessage(error);
  const token =
    errnoCode(message) ?? message.match(/\b(SQLITE_[A-Z_]+|ERR_[A-Z_]+|E(?:CONN|NOT|AI_|TIMEDOUT)[A-Z_]*)\b/u)?.[1];
  if (token) return codeToReference(token);
  const httpStatus = message.match(/^(?:HTTP )?([1-5]\d\d)(?:\b|:)/u)?.[1];
  if (httpStatus) return referenceFrom("http", httpStatus);
  if (NETWORK_MESSAGE.test(message)) return "network/fetch";
  if (explicitCode && REFERENCE_PART.test(explicitCode)) return codeToReference(explicitCode);
  return null;
}

export function classifyUserError(error: unknown, explicitCode?: string | null): UserErrorKind {
  const combined = `${normalizeErrorMessage(error)} ${explicitCode ?? ""}`.trim();
  const code = errnoCode(combined);

  if (NETWORK_MESSAGE.test(combined) || (code && NETWORK_CODES.has(code))) return "network";
  if (code === "ETIMEDOUT" || code === "ERR_CONNECTION_TIMED_OUT" || explicitCode === "timed_out" || (error instanceof Error && error.name === "TimeoutError")) {
    return "timeout";
  }
  if (code === "ENOSPC") return "storage";
  if (code === "EACCES" || code === "EPERM") return "file-permission";
  if (code === "ENOENT") return "not-found";
  if (code === "EROFS") return "read-only";
  if (code === "EEXIST") return "conflict";
  if (/^(?:HTTP )?401(?:\b|:)/u.test(combined)) return "auth";
  if (/^(?:HTTP )?403(?:\b|:)/u.test(combined)) return "permission";
  if (/^(?:HTTP )?429(?:\b|:)/u.test(combined) || RATE_LIMIT_SIGNALS.test(combined)) return "rate-limit";
  if (/^(?:HTTP )?5\d\d(?:\b|:)/u.test(combined)) return "service";
  if (AUTH_SIGNALS.test(combined)) return "auth";
  return "unknown";
}

export function userErrorMessage(error: unknown, fallback: string, explicitCode?: string | null): string {
  const kind = classifyUserError(error, explicitCode);
  if (kind !== "unknown") return USER_ERROR_COPY[kind];

  const message = normalizeErrorMessage(error);
  if (
    !message ||
    message.length > 400 ||
    /^(?:TypeError|SyntaxError|ReferenceError|RangeError):/u.test(message) ||
    error instanceof TypeError ||
    error instanceof SyntaxError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    TECHNICAL_OUTPUT.test(message)
  ) {
    return fallback;
  }
  return redactSensitiveText(message);
}

export interface UserErrorDetails {
  kind: UserErrorKind;
  message: string;
  reference: string | null;
}

export function userErrorDetails(error: unknown, fallback: string, explicitCode?: string | null): UserErrorDetails {
  return {
    kind: classifyUserError(error, explicitCode),
    message: userErrorMessage(error, fallback, explicitCode),
    reference: extractErrorReference(error, explicitCode),
  };
}
