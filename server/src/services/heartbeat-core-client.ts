// server/src/services/heartbeat-core-client.ts
//
// [목적] crates/heartbeat-core Stage 1 서브커맨드의 동기(sync) Node 브리지.
//   - classify-run-failure / run-failure-text / contains-tool-limit-failure
//   - detect-codex-auth-failure
//   대상 TS 공개 함수들이 동기 계약이라 spawnSync 기반 try-*ViaRust 시임으로 제공한다 —
//   서비스 파일은 null 이면 자기 TS 본문으로 조용히 폴백하므로 호출부 시그니처가 불변이다.
// [게이트] PAPERCLIP_HEARTBEAT_CORE_BIN 만 본다: 빈값·NUL·상대경로는 게이트 폐쇄 = 스폰 없는
//   조용한 TS 직행. 기본 bin 탐색은 없다 — opt-in 만이 Rust 팔을 연다.
// [폴백 계약] 스폰 오류(ENOENT·timeout)·non-zero 종료(lone surrogate 입력의 serde 거부·
//   TS-throw 미러 등)·비JSON·shape 불일치는 전부 null → TS 팔. stderr 는 파싱하지 않는다 —
//   판단 근거는 종료코드 + JSON 파싱 + shape 검증(기계 계약)뿐이다. TS 본문이 parity 의
//   최종 출처다. detect-codex-auth-failure 는 정상 결과로 JSON null 을 내는 유일한
//   서브커맨드라 { value: null } 로 감싸 "Rust 팔 성공(미검출)"과 폴백 신호를 구분한다.
// [수정시 영향] shape 검증을 느슨히 하면 parity 를 깨뜨린 채 Rust 결과가 흐른다. 게이트 규칙이나
//   시임 이름을 바꾸면 서비스 2개 파일의 opt-in 호출과 heartbeat-core-wiring 테스트가 깨진다.
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { HeartbeatFailureClassification } from "./heartbeat-failure-classification.js";
import type { CodexAuthAutoBlockInfo } from "./heartbeat-codex-auth-classification.js";

const HB_TIMEOUT_MS = 10_000;
const HB_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** 게이트 — 설정 env 는 절대경로만 허용한다(NUL 은 env 로 운반되지 않지만 방어한다). */
function resolveHeartbeatCoreBin(): string | null {
  const configured = process.env.PAPERCLIP_HEARTBEAT_CORE_BIN ?? "";
  if (configured === "" || configured.includes("\0") || !path.isAbsolute(configured)) return null;
  return configured;
}

/** 프로세스당 1회 fallback 경고. 게이트 폐쇄는 경고하지 않는다(조용한 TS 경로가 기본값이다). */
const fallbackWarnedKeys = new Set<string>();
function warnFallbackOnce(subcommand: string, reason: string): void {
  const key = `${subcommand}:${reason}`;
  if (fallbackWarnedKeys.has(key)) return;
  fallbackWarnedKeys.add(key);
  console.warn(`[heartbeat-core] Rust helper fallback to Node (${subcommand}): ${reason}`);
}

/** 테스트 전용 — warn-once 상태는 프로세스 전역이라 케이스 간 오염을 막는다. */
export function resetHeartbeatCoreFallbackWarningsForTests(): void {
  fallbackWarnedKeys.clear();
}

/**
 * [목적] 동기 Rust 시임. 성공 종료 + JSON 파싱 + shape 통과일 때만 Rust 결과를 돌려주고,
 *   그 외(게이트 폐쇄/스폰 오류/non-zero 종료/비JSON/shape 불량)는 null(TS 팔 신호)을 돌려준다.
 * [주의] validateShape 는 던지지 않고 불량 시 null 을 돌려준다 — 시임이 실패 원인을 종료코드·
 *   JSON·shape 의 기계 신호로만 분류한다.
 */
function runRustOrNull<T>(
  subcommand: string,
  payload: unknown,
  validateShape: (response: unknown) => T | null,
): T | null {
  const bin = resolveHeartbeatCoreBin();
  if (bin === null) return null;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(bin, [subcommand], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      maxBuffer: HB_MAX_BUFFER_BYTES,
      timeout: HB_TIMEOUT_MS,
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

// heartbeat-failure-classification.ts HeartbeatFailureClassification["category"] 집합과
// 같은 목록 — Rust 포트도 같은 집합만 낸다.
const FAILURE_CATEGORIES: ReadonlySet<string> = new Set([
  "timeout",
  "cancelled",
  "overload",
  "quota",
  "auth",
  "command",
  "adapter",
]);

function isFailureClassification(value: unknown): value is HeartbeatFailureClassification {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Partial<HeartbeatFailureClassification>;
  return typeof v.category === "string" && FAILURE_CATEGORIES.has(v.category)
    && typeof v.reasonCode === "string"
    && typeof v.summary === "string"
    && Array.isArray(v.fallbackCandidates)
    && v.fallbackCandidates.every((item) => typeof item === "string");
}

function isCodexAuthAutoBlockInfo(value: unknown): value is CodexAuthAutoBlockInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Partial<CodexAuthAutoBlockInfo>;
  return typeof v.reasonCode === "string"
    && (typeof v.authErrorCode === "string" || v.authErrorCode === null);
}

/** classify-run-failure. payload 는 분류 입력 객체 그 자체다. */
export function classifyHeartbeatRunFailureViaRust(input: unknown): HeartbeatFailureClassification | null {
  return runRustOrNull("classify-run-failure", input, (r) =>
    isFailureClassification(r) ? r : null);
}

/** run-failure-text. */
export function heartbeatRunFailureTextViaRust(input: unknown): string | null {
  return runRustOrNull("run-failure-text", input, (r) =>
    typeof r === "string" ? r : null);
}

/** contains-tool-limit-failure. payload 는 heartbeatRuns 행(관련 키만 읽힌다). */
export function containsToolLimitLifecycleFailureViaRust(run: unknown): boolean | null {
  return runRustOrNull("contains-tool-limit-failure", run, (r) =>
    typeof r === "boolean" ? r : null);
}

/**
 * detect-codex-auth-failure. Rust 가 JSON null(미검출)을 정상 반환하므로 결과를
 * { value } 로 감싼다 — 반환 null 은 "shape 불량/폴백" 의미로만 쓰인다.
 */
export function detectCodexAuthFailureForAutoBlockViaRust(
  input: unknown,
): { value: CodexAuthAutoBlockInfo | null } | null {
  return runRustOrNull("detect-codex-auth-failure", input, (r) => {
    if (r === null) return { value: null };
    return isCodexAuthAutoBlockInfo(r) ? { value: r } : null;
  });
}
