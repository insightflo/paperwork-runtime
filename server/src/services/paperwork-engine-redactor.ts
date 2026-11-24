// [파일 목적] resident paperwork-engine `redactor.redact_text` fail-closed typed client —
//   어떤 오류 경로에서도 미스캔 원문을 흘리지 않고 `[redacted-unscanned]` 센티널로 수렴
//   (직접 프로세스 spawn 없음, Node 측 regex 폴백 없음).
// [외부 연결] paperwork-engine-runtime 공유 클라이언트; wire contract는
//   crates/paperwork-engine/src/lib.rs, fail-closed 계약은 crates/redactor-core/src/lib.rs.
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

// Mirrors MAX_TEXT_BYTES in crates/paperwork-engine/src/lib.rs: 32 KiB measured in
// UTF-8 BYTES (not JS chars); larger inputs get -32602 invalid_params from the engine.
export const REDACTOR_MAX_TEXT_BYTES = 32 * 1024;
// Mirrors UNSCANNED in crates/redactor-core/src/lib.rs — exact bytes, never localized.
export const REDACTED_UNSCANNED = "[redacted-unscanned]";

export type PaperworkEngineRedactorErrorReason =
  "invalid_input" | "engine_unavailable" | "rpc_error" | "invalid_response";

export class PaperworkEngineRedactorError extends Error {
  readonly reason: PaperworkEngineRedactorErrorReason;
  constructor(reason: PaperworkEngineRedactorErrorReason) {
    super(`redactor_${reason}`);
    this.name = "PaperworkEngineRedactorError";
    this.reason = reason;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
// Node 20+ ships ES2024 String.isWellFormed but the repo's ES2023 lib types lack it.
const wellFormed = (s: string): boolean =>
  (s as string & { isWellFormed(): boolean }).isWellFormed();

/**
 * Fail-closed wrapper for the resident paperwork-engine `redactor.redact_text`
 * JSON-RPC method. Returns the engine's `redacted` string on success; EVERY failure
 * branch — engine unavailable, transport/RPC error, oversized or ill-formed input,
 * malformed wire response — degrades to the exact `[redacted-unscanned]` sentinel
 * instead of leaking unscanned raw text. There is NO Node-side redaction fallback:
 * the engine is the sole scanning authority. Non-string input is a caller bug and is
 * rejected with a typed error — never coerced and never sent to the engine.
 */
export async function redactTextFailClosed(
  text: unknown,
  opts?: { engineClient?: PaperworkEngineClient | null; timeoutMs?: number },
): Promise<string> {
  if (typeof text !== "string") throw new PaperworkEngineRedactorError("invalid_input");
  // Lone surrogates serialize to invalid UTF-8 and oversized text is rejected by the
  // engine anyway — both short-circuit to the sentinel before touching the wire.
  if (!wellFormed(text) || Buffer.byteLength(text, "utf8") > REDACTOR_MAX_TEXT_BYTES) {
    return REDACTED_UNSCANNED;
  }
  let raw: unknown;
  try {
    const engine = opts?.engineClient !== undefined
      ? opts.engineClient
      : getSharedPaperworkEngineClient();
    if (engine === null) throw new PaperworkEngineRedactorError("engine_unavailable");
    try {
      raw = await engine.call("redactor.redact_text", { text }, { timeoutMs: opts?.timeoutMs });
    } catch {
      throw new PaperworkEngineRedactorError("rpc_error");
    }
    if (!isRecord(raw) || typeof raw.redacted !== "string" || typeof raw.changed !== "boolean") {
      throw new PaperworkEngineRedactorError("invalid_response");
    }
  } catch {
    return REDACTED_UNSCANNED;
  }
  return raw.redacted;
}
