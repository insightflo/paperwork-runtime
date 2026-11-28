// server/src/services/verdict-core-client.ts
//
// [목적] crates/verdict-core Rust SSOT 동기(sync) Node 브리지.
//   TS 이중 구현은 제거됨(archive/ts-engines-pre-rust-removal-20261129 백업 참조).
//   Rust 바이너리가 단일 진실 공급원(SSOT)이며, 스폰/계약 오류 시 폴백 없이 즉시 실패한다.
import { spawnSync } from "node:child_process";
import { resolveRustBinary } from "./rust-binary-resolver.js";
import type { ValidationVerdict } from "./validation-verdict.js";
import type { QualityVerdictRouting } from "./quality-verdict-routing.js";

const TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

function runRustStrict<T>(
  subcommand: string,
  payload: unknown,
  validateShape: (response: unknown) => T | null,
): T {
  const bin = resolveRustBinary("PAPERCLIP_VERDICT_CORE_BIN", "verdict-core", "paperclip-verdict-core");
  const result = spawnSync(bin, [subcommand], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: TIMEOUT_MS,
  });
  if (result.error) {
    throw new Error(`[verdict-core] spawn_error (${subcommand}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    throw new Error(stderr || `[verdict-core] exit_${result.status ?? "signal"} (${subcommand})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(result.stdout));
  } catch {
    throw new Error(`[verdict-core] bad_json (${subcommand})`);
  }
  const shaped = validateShape(parsed);
  if (shaped === null) {
    throw new Error(`[verdict-core] bad_shape (${subcommand})`);
  }
  return shaped;
}

function verdictFromResponse(response: unknown): { verdict: ValidationVerdict | null } | null {
  if (response === null) return { verdict: null };
  if (response === "pass" || response === "request_changes") return { verdict: response };
  return null;
}

function routingFromResponse(response: unknown): QualityVerdictRouting | null {
  if (typeof response !== "object" || response === null || Array.isArray(response)) return null;
  const record = response as Record<string, unknown>;
  if (record.kind === "none") return { kind: "none" };
  if (record.kind === "evidence") {
    if (!isStringArray(record.requiredEvidenceSurfaces) || !("reason" in record)) return null;
    return {
      kind: "evidence",
      reason: record.reason as string | null,
      requiredEvidenceSurfaces: record.requiredEvidenceSurfaces,
    };
  }
  if (record.kind === "correction") {
    if (record.verdict !== "fail" && record.verdict !== "request_changes") return null;
    if (!("reason" in record) || !("failureType" in record)) return null;
    return {
      kind: "correction",
      verdict: record.verdict,
      reason: record.reason as string | null,
      failureType: record.failureType as string | null,
    };
  }
  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** No-op kept only for backwards test-import compatibility. */
export function resetVerdictCoreFallbackWarningsForTests(): void {}

export function readExplicitValidationVerdictViaRust(
  value: unknown,
  options: unknown,
): { verdict: ValidationVerdict | null } {
  return runRustStrict("read-explicit-validation-verdict", { value, options }, verdictFromResponse);
}

export function resolveQualityVerdictRoutingViaRust(input: {
  verdict: string;
  reason?: string | null;
  failureType?: string | null;
  requiredEvidenceSurfaces?: readonly string[];
}): QualityVerdictRouting {
  return runRustStrict("resolve-quality-verdict-routing", { input }, routingFromResponse);
}
