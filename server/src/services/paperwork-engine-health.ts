// [파일 목적] resident paperwork-engine `engine.health` readiness probe —
//   crates/paperwork-engine/src/lib.rs health_result() 의 {ok, engine,
//   protocol_version, capabilities} 와이어 계약을 재검증하고, 모든 실패를
//   healthy/degraded/unavailable typed 결과로만 분류하는 fail-closed 경계다.
//   어떤 입력·실패도 예외로 새지 않는다 (never throws).
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-runtime getSharedPaperworkEngineClient (probe 시점에만
//   lazy resolve — 모듈 로드 시 엔진을 깨우지 않는다).
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

/** Minimal structural view of the engine client the probe needs. The real
 *  PaperworkEngineClient is assignable (its health() ignores the extra arg and
 *  stays bounded by its own client-level timeout); tests inject stubs whose
 *  health() may resolve malformed wire objects for re-validation coverage. */
export interface PaperworkEngineHealthClient {
  health(callOpts?: { timeoutMs?: number }): Promise<unknown>;
}
export type PaperworkEngineHealthClientResolver = () => PaperworkEngineHealthClient | null;

export interface ProbePaperworkEngineHealthOptions {
  /** Injected client or lazy resolver; null forces "unavailable". */
  engineClient?: PaperworkEngineHealthClient | PaperworkEngineHealthClientResolver | null;
  /** Read timeout forwarded to health() callOpts; clamped to [1, 600_000]. */
  timeoutMs?: number;
}

export interface PaperworkEngineHealthyProbe {
  status: "healthy"; engine: "paperwork-engine"; protocolVersion: 1;
  capabilities: string[]; probedAt: number; durationMs: number;
}
export type PaperworkEngineProbeDegradedReason =
  | "timeout" | "transport_error" | "protocol_error" | "unknown";
export interface PaperworkEngineDegradedProbe {
  status: "degraded"; reason: PaperworkEngineProbeDegradedReason;
  errorKind?: string; errorCode?: number; message?: string;
  probedAt: number; durationMs: number;
}
export interface PaperworkEngineUnavailableProbe { status: "unavailable"; probedAt: number }
export type PaperworkEngineHealthProbe =
  | PaperworkEngineHealthyProbe | PaperworkEngineDegradedProbe | PaperworkEngineUnavailableProbe;

const PROBE_DEFAULT_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MIN_MS = 1;
const PROBE_TIMEOUT_MAX_MS = 600_000;

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Same [1, 600_000] bounds as the engine-client family, but clamps instead of
 *  throwing — a readiness probe must never reject on bad tuning input. */
function clampTimeoutMs(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return PROBE_DEFAULT_TIMEOUT_MS;
  return Math.min(PROBE_TIMEOUT_MAX_MS, Math.max(PROBE_TIMEOUT_MIN_MS, Math.trunc(v)));
}

/** Re-validates the exact engine.health wire shape even though client.health()
 *  already validates — a stub or a future client that lets a malformed result
 *  slip through degrades closed instead of publishing phantom capabilities. */
function isEngineHealthWire(v: unknown): v is {
  ok: true; engine: "paperwork-engine"; protocol_version: 1; capabilities: string[];
} {
  return isRec(v) && v.ok === true && v.engine === "paperwork-engine"
    && v.protocol_version === 1 && Array.isArray(v.capabilities)
    && v.capabilities.every((c) => typeof c === "string");
}

function errorMessage(e: unknown): string | undefined {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return undefined;
  }
}

/** Maps rejections to probe reasons: client timeout -> "timeout"; shape
 *  violations -> "protocol_error"; other PaperworkEngineError codes are
 *  transport/queue/process failures -> "transport_error"; arbitrary throws we
 *  cannot attribute stay "unknown". errorKind/errorCode keep the raw fields. */
function classifyProbeError(e: unknown): Pick<
  PaperworkEngineDegradedProbe, "reason" | "errorKind" | "errorCode" | "message"
> {
  if (e instanceof PaperworkEngineError) {
    const reason: PaperworkEngineProbeDegradedReason = e.code === "timeout" ? "timeout"
      : e.code === "protocol_error" ? "protocol_error" : "transport_error";
    return { reason, errorKind: e.code, errorCode: e.rpcCode, message: e.message };
  }
  return { reason: "unknown", errorKind: e instanceof Error ? e.name : undefined, message: errorMessage(e) };
}

const elapsed = (since: number): number => Math.max(0, Date.now() - since);

/** Fail-closed readiness probe: resolves the engine client lazily per call,
 *  invokes engine.health, and classifies the outcome. Never throws. */
export async function probePaperworkEngineHealth(
  opts?: ProbePaperworkEngineHealthOptions,
): Promise<PaperworkEngineHealthProbe> {
  const probedAt = Date.now();
  const injected = opts?.engineClient;
  const resolver: PaperworkEngineHealthClientResolver = injected === undefined
    ? () => getSharedPaperworkEngineClient()
    : typeof injected === "function" ? injected : () => injected;
  let client: PaperworkEngineHealthClient | null;
  try {
    client = resolver();
  } catch {
    return { status: "unavailable", probedAt };
  }
  if (client === null || client === undefined) return { status: "unavailable", probedAt };
  const timeoutMs = clampTimeoutMs(opts?.timeoutMs);
  let wire: unknown;
  try {
    wire = await client.health({ timeoutMs });
  } catch (e) {
    return { status: "degraded", ...classifyProbeError(e), probedAt, durationMs: elapsed(probedAt) };
  }
  if (!isEngineHealthWire(wire)) {
    return {
      status: "degraded", reason: "protocol_error", errorKind: "protocol_error",
      message: "bad engine.health result shape", probedAt, durationMs: elapsed(probedAt),
    };
  }
  return {
    status: "healthy", engine: "paperwork-engine", protocolVersion: 1,
    capabilities: [...wire.capabilities], probedAt, durationMs: elapsed(probedAt),
  };
}

/** Exact-match capability check; fails closed on any non-healthy probe,
 *  missing/malformed capabilities array, or non-string method. Never throws. */
export function hasEngineCapability(probe: PaperworkEngineHealthProbe, method: unknown): boolean {
  return isRec(probe) && probe.status === "healthy" && typeof method === "string"
    && Array.isArray(probe.capabilities) && probe.capabilities.includes(method);
}
