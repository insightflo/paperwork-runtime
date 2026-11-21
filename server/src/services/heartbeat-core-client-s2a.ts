// server/src/services/heartbeat-core-client-s2a.ts
//
// [목적] crates/heartbeat-core Stage 2A 서브커맨드의 동기(sync) Node 브리지.
//   - stability-env (env 노브 8종 번들) / stability-compute (advisory·step-aware·signals)
//     → heartbeat-stability.ts
//   - run-context (readNonEmptyString·taskKey·fallbackAttempt·agentNameKey·sameTaskScope
//     5종 번들) → heartbeat-run-context.ts
//   서비스 파일은 null 이면 자기 TS 본문으로 조용히 폴백하므로 호출부 시그니처가 불변이다.
//   번들 서브커맨드는 한 번 스폰해 필요한 키만 골라 쓰고, runTaskKey 는 deriveTaskKey 를
//   경유하므로 내부 이중 스폰이 없다. progress-evidence·session-reset·output-validation 은
//   아직 미배선 — 전수 parity 는 heartbeat-core-stage2-parity.test.ts 가 직접 스폰한다.
// [게이트] PAPERCLIP_HEARTBEAT_CORE_BIN 만 본다: 빈값·NUL·상대경로는 게이트 폐쇄 = 스폰 없는
//   조용한 TS 직행. 기본 bin 탐색은 없다 — opt-in 만이 Rust 팔을 연다.
// [폴백 계약] 스폰 오류(ENOENT·timeout)·non-zero 종료·비JSON·shape 불일치는 전부 null → TS 팔.
//   여기에 더해 JSON 직렬화가 값을 바꾸는 입력(undefined·함수·symbol·bigint·비유한수·순환·
//   배열 구멍·비평범 객체·문자열/키 lone surrogate)은 스폰 전에 걸러 null → TS 팔 — Rust 가
//   TS 와 다른 입력을 받아 "성공적으로" 다른 값을 내는 것을 원천 차단한다(tool-hygiene-core-client
//   와 같은 규약). isSameTaskScope 의 동일 참조(===) 비교도 JSON 복제가 깨뜨리므로 걸러낸다.
//   stderr 는 파싱하지 않는다. TS 본문이 parity 의 최종 출처다.
// [수정시 영향] shape 검증을 느슨히 하면 parity 를 깨뜨린 채 Rust 결과가 흐른다. 게이트 규칙이나
//   시임 이름을 바꾸면 서비스 2개 파일의 opt-in 호출과 heartbeat-core-s2a-wiring 테스트가 깨진다.
import { spawnSync } from "node:child_process";
import path from "node:path";

const S2A_TIMEOUT_MS = 10_000;
const S2A_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** 게이트 — 설정 env 는 절대경로만 허용한다(NUL 은 env 로 운반되지 않지만 방어한다). */
function resolveS2aBin(): string | null {
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
  console.warn(`[heartbeat-core-s2a] Rust helper fallback to Node (${subcommand}): ${reason}`);
}

/** 테스트 전용 — warn-once 상태는 프로세스 전역이라 케이스 간 오염을 막는다. */
export function resetHeartbeatCoreS2aFallbackWarningsForTests(): void {
  fallbackWarnedKeys.clear();
}

/**
 * [목적] UTF-16 문자열에 lone surrogate(쌍이 어긋난 서러게이트)가 있는지 검사한다.
 *   직렬화본이 아니라 원본을 검사한다 — 스폰 전에 걸러 TS 팔로 보낸다(tool-hygiene 와 동일).
 */
export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1; // 유효한 쌍 — 하위 서러게이트를 다시 검사하지 않는다
      } else {
        return true;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * [목적] JSON 직렬화가 값을 바꾸지 않는 입력인지 재귀 검사한다(순환은 WeakSet DFS 로 검출).
 * [규칙] undefined·function·symbol·bigint(직렬 시 소실 또는 예외), 비유한수(null 대체),
 *   배열 구멍, 비평범 프로토타입(Date·Map·클래스), 문자열·키 lone surrogate 는 불안전 — TS 팔.
 */
function jsonUnsafeReason(value: unknown, seen: WeakSet<object>): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return hasLoneSurrogate(value) ? "lone_surrogate_input" : null;
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value) ? null : "non_json_safe_input";
    case "object": {
      const obj = value as object;
      if (seen.has(obj)) return "non_json_safe_input"; // 순환 — JSON.stringify 가 던진다
      seen.add(obj);
      let reason: string | null;
      if (Array.isArray(obj)) {
        reason = null;
        for (let i = 0; reason === null && i < obj.length; i += 1) {
          reason = jsonUnsafeReason(obj[i], seen);
        }
      } else {
        const proto = Object.getPrototypeOf(obj);
        reason = proto === Object.prototype || proto === null ? null : "non_json_safe_input";
        if (reason === null) {
          for (const key of Object.keys(obj)) {
            if (hasLoneSurrogate(key)) { reason = "lone_surrogate_input"; break; }
          }
        }
        if (reason === null) {
          for (const v of Object.values(obj)) {
            reason = jsonUnsafeReason(v, seen);
            if (reason !== null) break;
          }
        }
      }
      seen.delete(obj);
      return reason;
    }
    default:
      return "non_json_safe_input";
  }
}

/** 안전 입력만 직렬화한다. 불안전(사유와 함께)이면 null — 호출부가 TS 팔로 간다. */
function serializeJsonSafe(subcommand: string, payload: unknown): string | null {
  const reason = jsonUnsafeReason(payload, new WeakSet());
  if (reason !== null) {
    warnFallbackOnce(subcommand, reason);
    return null;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    warnFallbackOnce(subcommand, "non_json_safe_input");
    return null;
  }
}

/**
 * [목적] 동기 Rust 시임. 성공 종료 + JSON 파싱 + shape 통과일 때만 Rust 결과를 돌려주고,
 *   그 외(게이트 폐쇄/직렬화 불가/스폰 오류/non-zero 종료/비JSON/shape 불량)는 null(TS 팔 신호).
 * [주의] validateShape 는 던지지 않고 불량 시 null 을 돌려준다 — 시임이 실패 원인을 종료코드·
 *   JSON·shape 의 기계 신호로만 분류한다.
 */
function runRustOrNull<T>(
  subcommand: string,
  payload: unknown,
  validateShape: (response: unknown) => T | null,
): T | null {
  const bin = resolveS2aBin();
  if (bin === null) return null;
  const input = serializeJsonSafe(subcommand, payload);
  if (input === null) return null;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(bin, [subcommand], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: S2A_MAX_BUFFER_BYTES,
      timeout: S2A_TIMEOUT_MS,
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

type JsonObj = Record<string, unknown>;
const isObj = (v: unknown): v is JsonObj => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStringOrNull = (v: unknown): v is string | null => typeof v === "string" || v === null;
const isNumArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isFiniteNum);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((i) => typeof i === "string");

/** stability-env 번들 — 8개 env 리졸버가 필요한 키만 골라 쓴다(함수당 스폰 1회). */
export type StabilityEnvBundle = {
  qaStepActiveExecutionTimeoutMs: number;
  runawayLogLimitBytes: number;
  adapterFailedTransientRetryMaxSec: number;
  noProgressAdvisoryThreshold: number;
  noProgressAutoBlockThreshold: number;
  noProgressWindowMs: number;
  provider403RetryDelaysMin: number[];
  provider403ReasonCodes: string[];
};

function asStabilityEnvBundle(r: unknown): StabilityEnvBundle | null {
  if (!isObj(r)) return null;
  if (!isFiniteNum(r.qaStepActiveExecutionTimeoutMs) || !isFiniteNum(r.runawayLogLimitBytes)
    || !isFiniteNum(r.adapterFailedTransientRetryMaxSec) || !isFiniteNum(r.noProgressAdvisoryThreshold)
    || !isFiniteNum(r.noProgressAutoBlockThreshold) || !isFiniteNum(r.noProgressWindowMs)
    || !isNumArray(r.provider403RetryDelaysMin) || !isStrArray(r.provider403ReasonCodes)) {
    return null;
  }
  return r as unknown as StabilityEnvBundle;
}

/**
 * stability-env — payload {env?, adapterConfig?}. env === process.env 이면 키를 아예 빼서
 *   Rust 가 자식의 실제 env 를 읽게 한다(스폰 상속으로 부모와 동일) — process.env 는
 *   평범 객체가 아니라 직렬화 가드에 걸리므로 직렬화 경로가 아니라 실제 env 경로를 쓴다.
 *   커스텀 env 객체는 그대로 직렬화된다(비문자열 값은 Rust Err → exit_1 → TS 팔).
 */
export function stabilityEnvViaRust(input: { env: unknown; adapterConfig?: unknown }): StabilityEnvBundle | null {
  const payload: JsonObj = {};
  if (input.env !== process.env) payload.env = input.env;
  if (input.adapterConfig !== undefined) payload.adapterConfig = input.adapterConfig;
  return runRustOrNull("stability-env", payload, asStabilityEnvBundle);
}

/** stability-compute — resolveRunawayAdvisorySoftBytes. step:{} 는 Rust 계약상 필수라 채운다. */
export function runawayAdvisorySoftBytesViaRust(runawayLogLimitBytes: unknown): number | null {
  return runRustOrNull("stability-compute", { runawayLogLimitBytes, step: {} }, (r) =>
    isObj(r) && isFiniteNum(r.runawayAdvisorySoftBytes) ? r.runawayAdvisorySoftBytes : null);
}

/**
 * stability-compute — resolveStepAwareActiveExecutionTimeoutMs. TS 본문도 경로에 따라
 *   undefined·문자열 등 임의 값을 돌려주므로 키 부재는 { value: undefined }(TS 미러),
 *   present-null 은 Rust 의 NaN/∞ 인코딩이라 TS 팔로 보낸다(TS 는 진짜 NaN 을 낸다).
 */
export function stepAwareActiveExecutionTimeoutMsViaRust(input: {
  baseMs: unknown;
  contract: unknown;
  qaStepActiveExecutionTimeoutMs: unknown;
}): { value: unknown } | null {
  return runRustOrNull("stability-compute", { ...input, step: {} }, (r) => {
    if (!isObj(r) || !("stepAwareTimeoutMs" in r)) return { value: undefined };
    const v = r.stepAwareTimeoutMs;
    return v === null ? null : { value: v };
  });
}

/** stability-compute — stepTimeoutSignalsFromStep. step 이 null/부재면 Rust exit_1 → TS 팔. */
export function stepTimeoutSignalsViaRust(step: unknown): { stepTimeoutSeconds: number; isQaStep: boolean } | null {
  return runRustOrNull("stability-compute", { step }, (r) => {
    const s = isObj(r) ? r.stepTimeoutSignals : undefined;
    return isObj(s) && isFiniteNum(s.stepTimeoutSeconds) && typeof s.isQaStep === "boolean"
      ? { stepTimeoutSeconds: s.stepTimeoutSeconds, isQaStep: s.isQaStep }
      : null;
  });
}

/** run-context 번들 — 5개 순수 헬퍼가 필요한 키만 골라 쓴다(함수당 스폰 1회, Rust 가 던지지 않는다). */
export type RunContextBundle = {
  readNonEmptyString: string | null;
  taskKey: string | null;
  fallbackAttempt: number;
  agentNameKey: string | null;
  sameTaskScope: boolean;
};

function asRunContextBundle(r: unknown): RunContextBundle | null {
  if (!isObj(r)) return null;
  if (!isStringOrNull(r.readNonEmptyString) || !isStringOrNull(r.taskKey)
    || !isFiniteNum(r.fallbackAttempt) || !isStringOrNull(r.agentNameKey)
    || typeof r.sameTaskScope !== "boolean") {
    return null;
  }
  return r as unknown as RunContextBundle;
}

/**
 * run-context — payload {value?, contextSnapshot?, payload?, contextRaw?, agentName?, left?, right?}.
 *   left === right 가 같은 객체·함수 참조이면 JSON 복제본이 TS 의 === 참조 비교를 깨뜨리므로
 *   스폰 전에 걸러 TS 팔로 보낸다(스칼라 동치는 Rust js_nullish_eq 가 그대로 미러한다).
 */
export function runContextViaRust(input: {
  value?: unknown;
  contextSnapshot?: unknown;
  payload?: unknown;
  contextRaw?: unknown;
  agentName?: unknown;
  left?: unknown;
  right?: unknown;
}): RunContextBundle | null {
  const shared = input.left;
  if (shared === input.right && shared !== null
    && (typeof shared === "object" || typeof shared === "function")) {
    warnFallbackOnce("run-context", "non_json_safe_input");
    return null;
  }
  return runRustOrNull("run-context", input, asRunContextBundle);
}
