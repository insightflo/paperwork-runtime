// server/src/services/verdict-core-client.ts
//
// [파일 목적] crates/verdict-core Stage 2.1 서브커맨드의 동기(sync) Node 브리지.
//   - read-explicit-validation-verdict: validation-verdict.ts readExplicitValidationVerdict
//   - resolve-quality-verdict-routing: quality-verdict-routing.ts resolveQualityVerdictRouting
//   대상 TS 공개 함수들이 동기 계약이라 spawnSync 기반 try-*ViaRust 로 제공한다 —
//   서비스 파일은 null 이면 자기 TS 본문으로 조용히 폴백하므로 호출부 시그니처가 불변이다.
//   readExplicitValidationVerdict 의 성공값에는 null(판정 없음)이 있으므로 {verdict} 래퍼로
//   폴백 신호(null)와 구분한다. 전수 parity 는 verdict-core-stage1-parity.test.ts 가 담당한다.
// [외부 연결] PAPERCLIP_VERDICT_CORE_BIN 이 가리키는 paperclip-verdict-core 실행 파일.
//   stdin JSON -> stdout JSON, 실패는 non-zero 종료(stderr 는 파싱하지 않는다).
// [게이트] PAPERCLIP_VERDICT_CORE_BIN 만 본다: 빈값·NUL·상대경로는 게이트 폐쇄 = 스폰 없는
//   조용한 TS 직행(경고 0개). 미설정이 기본값이므로 이 브리지는 opt-in 이다.
// [폴백 계약] 스폰 오류(ENOENT·timeout)·non-zero 종료(V8 TypeError 미러·serde 거부)·비JSON·
//   shape 불일치는 전부 null → TS 팔. 판단 근거는 종료코드 + JSON 파싱 + shape 검증(기계 계약)
//   뿐이다. TS 본문이 parity 의 최종 출처다.
// [수정시 주의] shape 검증을 느슨히 하면 parity 를 깨뜨린 채 Rust 결과가 흐른다. 게이트 규칙이나
//   시임 이름을 바꾸면 validation-verdict.ts·quality-verdict-routing.ts 의 opt-in 호출과
//   verdict-core-wiring 테스트가 깨진다.
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ValidationVerdict } from "./validation-verdict.js";
import type { QualityVerdictRouting } from "./quality-verdict-routing.js";

const TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** 게이트 — 설정 env 는 절대경로만 허용한다(NUL 은 env 로 운반되지 않지만 방어한다). */
function resolveBin(): string | null {
  const configured = process.env.PAPERCLIP_VERDICT_CORE_BIN ?? "";
  if (configured === "" || configured.includes("\0") || !path.isAbsolute(configured)) return null;
  return configured;
}

/** 프로세스당 1회 fallback 경고. 게이트 폐쇄는 경고하지 않는다(조용한 TS 경로가 기본값이다). */
const fallbackWarnedKeys = new Set<string>();
function warnFallbackOnce(subcommand: string, reason: string): void {
  const key = `${subcommand}:${reason}`;
  if (fallbackWarnedKeys.has(key)) return;
  fallbackWarnedKeys.add(key);
  console.warn(`[verdict-core] Rust helper fallback to Node (${subcommand}): ${reason}`);
}

/** 테스트 전용 — warn-once 상태는 프로세스 전역이라 케이스 간 오염을 막는다. */
export function resetVerdictCoreFallbackWarningsForTests(): void {
  fallbackWarnedKeys.clear();
}

/**
 * [목적] 동기 Rust 시임. 성공 종료 + JSON 파싱 + shape 통과일 때만 Rust 결과를 돌려주고,
 *   그 외(게이트 폐쇄/스폰 오류/non-zero 종료/비JSON/shape 불량)는 null(TS 팔 신호)을 돌려준다.
 * [입력] subcommand: main.rs dispatch 의 시임 이름. payload: 시임별 stdin JSON.
 *   validateShape: 응답을 기계적으로 검증하는 함수 — 불량 시 null(폴백 신호).
 * [주의] validateShape 는 던지지 않는다 — 시임이 실패 원인을 종료코드·JSON·shape 의
 *   기계 신호로만 분류한다.
 */
function runRustOrNull<T>(
  subcommand: string,
  payload: unknown,
  validateShape: (response: unknown) => T | null,
): T | null {
  const bin = resolveBin();
  if (bin === null) return null;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(bin, [subcommand], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: TIMEOUT_MS,
    });
  } catch (error) {
    warnFallbackOnce(subcommand, `spawn_error:${error instanceof Error ? error.name : "unknown"}`);
    return null;
  }
  if (result.error) {
    warnFallbackOnce(subcommand, `spawn_error:${result.error.name}`);
    return null;
  }
  if (result.status !== 0) {
    // lone surrogate 입력처럼 Rust 가 거부하는 입력도 여기서 TS 팔로 간다 — TS 본문이 같은
    // 입력에 대해 정의된 동작(parity 출처)이므로 결과는 TS-동일하게 관측된다.
    warnFallbackOnce(subcommand, `exit_${result.status ?? "signal"}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(result.stdout));
  } catch {
    warnFallbackOnce(subcommand, "bad_json");
    return null;
  }
  const shaped = validateShape(parsed);
  if (shaped === null) {
    warnFallbackOnce(subcommand, "bad_shape");
    return null;
  }
  return shaped;
}

/**
 * [목적] read-explicit-validation-verdict 응답 shape 검증.
 * [출력] "pass"|"request_changes" 문자열 또는 null(판정 없음 — 성공값이다)을 {verdict} 로
 *   감싸 돌려준다. 그 외는 null(폴백 신호).
 */
function verdictFromResponse(response: unknown): { verdict: ValidationVerdict | null } | null {
  if (response === null) return { verdict: null };
  if (response === "pass" || response === "request_changes") return { verdict: response };
  return null;
}

/**
 * [목적] resolve-quality-verdict-routing 응답 shape 검증.
 * [주의] reason·failureType 은 TS 런타임 계약상 임의 JSON 값을 verbatim 통과하므로(routing.rs),
 *   키 존재만 검증하고 값은 TS 본문과 동일하게 있는 그대로 흘려보낸다. kind·verdict·
 *   requiredEvidenceSurfaces 는 집합/배열로 엄격히 검증한다.
 */
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

/**
 * [목적] read-explicit-validation-verdict 동기 시임 — validation-verdict.ts 의 opt-in 팔.
 * [입력] value: 판정 문서 본문(호출부에서 truthy string 으로 좁혀진 값).
 *   options: allowLeadingVerdict 등 TS 옵션 객체. 그대로 stdin JSON 으로 간다.
 * [출력] {verdict} — verdict 는 "pass"|"request_changes" 또는 null(판정 없음).
 *   null(래퍼 자체)이면 TS 폴백 신호다.
 */
export function readExplicitValidationVerdictViaRust(
  value: string,
  options: unknown,
): { verdict: ValidationVerdict | null } | null {
  return runRustOrNull(
    "read-explicit-validation-verdict",
    { value, options },
    verdictFromResponse,
  );
}

/**
 * [목적] resolve-quality-verdict-routing 동기 시임 — quality-verdict-routing.ts 의 opt-in 팔.
 * [입력] input: verdict/reason/failureType/requiredEvidenceSurfaces 입력 객체.
 * [출력] 라우팅 객체(none/evidence/correction) 또는 null(TS 폴백 신호).
 */
export function resolveQualityVerdictRoutingViaRust(input: {
  verdict: string;
  reason?: string | null;
  failureType?: string | null;
  requiredEvidenceSurfaces?: readonly string[];
}): QualityVerdictRouting | null {
  return runRustOrNull("resolve-quality-verdict-routing", { input }, routingFromResponse);
}
