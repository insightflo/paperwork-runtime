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

const invalid = () => new ProviderRuntimeEngineError("invalid_input");
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isVersionEntry = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_LEN && !v.includes("\0");
const isSha256 = (v: unknown): v is string => typeof v === "string" && SHA256_RE.test(v);

/** Fail-closed input validation. MUST run before any engine/daemon access. */
export function validateProviderBlocklistInput(raw: unknown): ProviderBlocklistInput {
  if (!isRecord(raw)) throw invalid();
  const { provider, version, sha256, blocklist } = raw;
  if (typeof provider !== "string" || !(PROVIDER_AUTH_IDS as readonly string[]).includes(provider)) {
    throw invalid();
  }
  if (
    typeof version !== "string" || version.length === 0 || version.length > MAX_LEN
    || version.trim() === "" || version.includes("/") || version.includes("\\")
    || version.includes("..") || version.includes("\0")
  ) {
    throw invalid();
  }
  if (sha256 !== undefined && !isSha256(sha256)) throw invalid();
  if (!isRecord(blocklist)) throw invalid();
  const { versions, sha256s } = blocklist;
  if (!Array.isArray(versions) || versions.length > MAX_LIST || !versions.every(isVersionEntry)) {
    throw invalid();
  }
  if (!Array.isArray(sha256s) || sha256s.length > MAX_LIST || !sha256s.every(isSha256)) {
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
    || (raw.reason !== undefined && typeof raw.reason !== "string")
  ) {
    throw new ProviderRuntimeEngineError("invalid_response");
  }
  return raw.reason === undefined
    ? { blocked: raw.blocked }
    : { blocked: raw.blocked, reason: raw.reason };
}
