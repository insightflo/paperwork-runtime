// [파일 목적] resident paperwork-engine `provider.check_blocklist` advisory 평가 — 설치 승인이 아닌 dry-run 신호, Node 폴백 없음(fail-closed).
// [외부 연결] paperwork-engine-runtime 공유 클라이언트, routes/instance-settings.ts.
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";
import { PROVIDER_AUTH_IDS, type ProviderAuthId } from "./provider-auth-core-client.js";

export type ProviderRuntimeEngineErrorReason =
  "invalid_input" | "engine_unavailable" | "rpc_error" | "invalid_response";

export class ProviderRuntimeEngineError extends Error {
  readonly reason: ProviderRuntimeEngineErrorReason;
  constructor(reason: ProviderRuntimeEngineErrorReason) {
    super(`provider_runtime_${reason}`);
    this.name = "ProviderRuntimeEngineError";
    this.reason = reason;
  }
}

export interface ProviderBlocklistInput {
  provider: ProviderAuthId;
  version: string;
  sha256?: string;
  blocklist: { versions: string[]; sha256s: string[] };
}

export interface ProviderBlocklistResult {
  blocked: boolean;
  reason?: string;
}

const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const MAX_LEN = 128;
const MAX_LIST = 256;
// Mirrors Rust bad_name() in provider-runtime-core: bytes <0x20, 0x7f, '/', '\\'.
const BAD_NAME_RE = /[\x00-\x1f\x7f/\\]/;

const invalid = () => new ProviderRuntimeEngineError("invalid_input");
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isVersionEntry = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_LEN && !v.includes("\0");
const isSha256 = (v: unknown): v is string => typeof v === "string" && SHA256_RE.test(v);
const isBadName = (s: string): boolean =>
  s.length === 0 || s === "." || s === ".." || BAD_NAME_RE.test(s);
const isDense = (a: readonly unknown[]): boolean => {
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(a, i)) return false;
  }
  return true;
};

/** Fail-closed input validation. MUST run before any engine/daemon access. */
export function validateProviderBlocklistInput(raw: unknown): ProviderBlocklistInput {
  if (!isRecord(raw)) throw invalid();
  const { provider, version, sha256, blocklist } = raw;
  if (typeof provider !== "string" || !(PROVIDER_AUTH_IDS as readonly string[]).includes(provider)) {
    throw invalid();
  }
  if (
    typeof version !== "string" || version.length > MAX_LEN
    || version.trim() === "" || version.includes("..") || isBadName(version)
  ) {
    throw invalid();
  }
  if (sha256 !== undefined && !isSha256(sha256)) throw invalid();
  if (!isRecord(blocklist)) throw invalid();
  const { versions, sha256s } = blocklist;
  if (
    !Array.isArray(versions) || versions.length > MAX_LIST
    || !isDense(versions) || !versions.every(isVersionEntry)
  ) {
    throw invalid();
  }
  if (
    !Array.isArray(sha256s) || sha256s.length > MAX_LIST
    || !isDense(sha256s) || !sha256s.every(isSha256)
  ) {
    throw invalid();
  }
  return {
    provider: provider as ProviderAuthId,
    version,
    ...(sha256 !== undefined ? { sha256 } : {}),
    blocklist: { versions: [...versions], sha256s: [...sha256s] },
  };
}

/**
 * Advisory dry-run evaluator for the resident paperwork-engine `provider.check_blocklist`
 * JSON-RPC method. The result is ONLY an advisory signal: a caller-supplied blocklist —
 * including an empty one — NEVER constitutes runtime installation approval. There is no
 * Node-side fallback: engine unavailability, RPC failure, and malformed replies all throw
 * (fail-closed); this function never fabricates `blocked: false`.
 */
export async function checkProviderRuntimeBlocklist(
  rawInput: unknown,
  opts?: { engineClient?: PaperworkEngineClient | null; timeoutMs?: number },
): Promise<ProviderBlocklistResult> {
  const input = validateProviderBlocklistInput(rawInput);
  let engine: PaperworkEngineClient | null;
  if (opts?.engineClient !== undefined) {
    engine = opts.engineClient;
  } else {
    try {
      engine = getSharedPaperworkEngineClient();
    } catch {
      throw new ProviderRuntimeEngineError("engine_unavailable");
    }
  }
  if (engine === null) throw new ProviderRuntimeEngineError("engine_unavailable");
  let raw: unknown;
  try {
    raw = await engine.call("provider.check_blocklist", input, { timeoutMs: opts?.timeoutMs });
  } catch {
    throw new ProviderRuntimeEngineError("rpc_error");
  }
  if (
    !isRecord(raw) || typeof raw.blocked !== "boolean"
    || (raw.reason !== undefined && raw.reason !== null && typeof raw.reason !== "string")
  ) {
    throw new ProviderRuntimeEngineError("invalid_response");
  }
  return raw.reason === undefined || raw.reason === null
    ? { blocked: raw.blocked }
    : { blocked: raw.blocked, reason: raw.reason };
}
