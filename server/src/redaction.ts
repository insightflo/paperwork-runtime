const SECRET_PAYLOAD_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const BASE64URL_SEGMENT_RE = /^[A-Za-z0-9_-]*$/;
// A base64url-encoded JSON object that starts with `{"` always begins with `eyJ`.
const JWT_HEADER_PREFIX = "eyJ";
const JWT_HEADER_MIN_LENGTH = 10;
const JWT_PAYLOAD_MIN_LENGTH = 10;
const JWT_SIGNATURE_OR_TAG_MIN_LENGTH = 16;
const JWT_HEADER_KEYS = ["alg", "typ", "enc"];
export const REDACTED_EVENT_VALUE = "***REDACTED***";

/**
 * Recognizes only genuine compact-serialized JWTs: JWS (header.payload.signature, 3 segments)
 * or JWE (header.encryptedKey.iv.ciphertext.tag, 5 segments).
 * Plain `a.b.c` strings such as `research-ai-news.raw.json` are file names, not tokens.
 */
function isJwtLikeValue(value: string): boolean {
  const segments = value.split(".");
  if (segments.length !== 3 && segments.length !== 5) return false;
  // JWE leaves the encrypted-key segment empty for `dir`/`EC` algs, so empty middle segments are allowed.
  if (!segments.every((segment) => BASE64URL_SEGMENT_RE.test(segment))) return false;
  const [header, , ciphertext] = segments;
  const signatureOrTag = segments[segments.length - 1];
  if (!header.startsWith(JWT_HEADER_PREFIX)) return false;
  if (header.length < JWT_HEADER_MIN_LENGTH) return false;
  if (segments.length === 3) {
    if (segments[1].length < JWT_PAYLOAD_MIN_LENGTH) return false;
  } else if (!ciphertext || ciphertext.length < JWT_PAYLOAD_MIN_LENGTH) {
    return false;
  }
  if (signatureOrTag.length < JWT_SIGNATURE_OR_TAG_MIN_LENGTH) return false;
  return hasJwtHeader(header);
}

function hasJwtHeader(header: string): boolean {
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown;
    if (!isPlainObject(decoded)) return false;
    return JWT_HEADER_KEYS.some((key) => key in decoded && typeof decoded[key] === "string");
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    if (typeof value === "string" && isJwtLikeValue(value)) {
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[key] = sanitizeValue(value);
  }
  return redacted;
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}
