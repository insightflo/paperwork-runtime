// server/src/services/tool-hygiene-core-client.ts
//
// [목적] crates/tool-hygiene-core 서브커맨드의 동기(sync) Node 브리지.
//   - compute-agent-tool-fingerprint / has-tool-surface-changed → tool-fingerprint.ts
//   - normalize-tool-error-signature / tool-error-signature-key / condense-tool-error-text
//     → tool-result-hygiene.ts (signatureKey·condenseErrorText 는 TS 에서 private 다)
//   - is-sensitive-tool-env-key → tool-env-sensitivity.ts
//   서비스 함수들은 null 이면 자기 TS 본문으로 조용히 폴백하므로 호출부 시그니처가 불변이다.
// [게이트] PAPERCLIP_TOOL_HYGIENE_CORE_BIN 만 본다: 빈값·NUL·상대경로는 게이트 폐쇄 = 스폰 없는
//   조용한 TS 직행.
// [폴백 계약] 스폰 오류(ENOENT·timeout)·non-zero 종료·비JSON·shape 불일치는 전부 null → TS 팔.
//   여기에 더해, JSON 직렬화가 값을 바꾸거나 예외를 만들 입력(undefined·함수·symbol·bigint·
//   비유한수·순환·배열 구멍·비평범 객체·lone surrogate)은 스폰 전에 걸러 null → TS 팔 —
//   Rust 가 TS 와 다른 입력을 받아 "성공적으로" 다른 값을 내는 것을 원천 차단한다.
//   TS 본문이 parity 의 최종 출처다.
// [수정시 영향] shape 검증을 느슨히 하면 parity 를 깨뜨린 채 Rust 결과가 흐른다. 게이트 규칙이나
//   시임 이름을 바꾸면 서비스 3개 파일의 opt-in 호출과 tool-hygiene-core-wiring 테스트가 깨진다.
import { execFileSync } from "node:child_process";
import path from "node:path";

const HYGIENE_TIMEOUT_MS = 10_000;
const HYGIENE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** 게이트 — 설정 env 는 절대경로만 허용한다(NUL 은 env 로 운반되지 않지만 방어한다). */
function resolveHygieneBin(): string | null {
  const configured = process.env.PAPERCLIP_TOOL_HYGIENE_CORE_BIN ?? "";
  if (configured === "" || configured.includes("\0") || !path.isAbsolute(configured)) return null;
  return configured;
}

/** 프로세스당 1회 fallback 경고. 게이트 폐쇄는 경고하지 않는다(조용한 TS 경로가 기본값이다). */
const fallbackWarnedKeys = new Set<string>();
function warnFallbackOnce(subcommand: string, reason: string): void {
  const key = `${subcommand}:${reason}`;
  if (fallbackWarnedKeys.has(key)) return;
  fallbackWarnedKeys.add(key);
  console.warn(`[tool-hygiene-core] Rust helper fallback to Node (${subcommand}): ${reason}`);
}

/** 테스트 전용 — warn-once 상태는 프로세스 전역이라 케이스 간 오염을 막는다. */
export function resetToolHygieneCoreFallbackWarningsForTests(): void {
  fallbackWarnedKeys.clear();
}

/**
 * [목적] UTF-16 문자열에 lone surrogate(상·하위 쌍이 어긋난 서러게이트)가 있는지 검사한다.
 * [주의] well-formed JSON.stringify 는 lone surrogate 를 \uD800 이스케이프로 남기고, Rust
 *   serde_json 은 그 이스케이프를 U+FFFD 로 축손 복원한다 — TS 는 원래 서러게이트를 유지하므로
 *   normalize 같은 문자열 반환 경로에서 결과가 갈라진다. 그래서 직렬화된 문자열이 아니라
 *   원본 payload 문자열을 검사해야 한다 — 스폰 전에 걸러 TS 팔로 보낸다.
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
 *   배열 구멍(undefined 로 읽힘), Object.prototype(또는 null) 이 아닌 프로토타입(Date·Map·
 *   클래스 인스턴스 등 축실), 문자열·객체 키의 lone surrogate 는 불안전 — TS 팔.
 *   위험은 "다른 값 성공"까지 포함하므로 보수적이며, 불안전 사유를 문자열로 돌려준다(null 은 안전).
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
 *   JSON·shape 의 기계 신호로만 분류한다. stderr 는 파싱하지 않는다.
 */
function runRustOrNull<T>(
  subcommand: string,
  payload: unknown,
  validateShape: (response: unknown) => T | null,
): T | null {
  const bin = resolveHygieneBin();
  if (bin === null) return null;
  const input = serializeJsonSafe(subcommand, payload);
  if (input === null) return null;
  let stdout: string;
  try {
    stdout = execFileSync(bin, [subcommand], {
      input,
      encoding: "utf8",
      timeout: HYGIENE_TIMEOUT_MS,
      maxBuffer: HYGIENE_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    const reason = typeof status === "number"
      ? `exit_${status}`
      : `spawn_error:${error instanceof Error ? error.name : "unknown"}`;
    warnFallbackOnce(subcommand, reason);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
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

const asString = (r: unknown): string | null => (typeof r === "string" ? r : null);
const asBoolean = (r: unknown): boolean | null => (typeof r === "boolean" ? r : null);

function asSurfaceChanged(r: unknown): { changed: boolean; currentFingerprint: string } | null {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
  const v = r as { changed?: unknown; currentFingerprint?: unknown };
  return typeof v.changed === "boolean" && typeof v.currentFingerprint === "string"
    ? { changed: v.changed, currentFingerprint: v.currentFingerprint }
    : null;
}

/** compute-agent-tool-fingerprint — payload 는 TS 입력 객체 그 자체다. */
export function computeAgentToolFingerprintViaRust(input: unknown): string | null {
  return runRustOrNull("compute-agent-tool-fingerprint", input, asString);
}

/** has-tool-surface-changed — TS (previousFingerprint, currentInput) 를 객체로 감싼 payload. */
export function hasToolSurfaceChangedViaRust(
  previousFingerprint: unknown,
  currentInput: unknown,
): { changed: boolean; currentFingerprint: string } | null {
  return runRustOrNull(
    "has-tool-surface-changed",
    { previousFingerprint, currentInput },
    asSurfaceChanged,
  );
}

/** normalize-tool-error-signature — payload {text}. Rust 는 비문자열 text 를 exit 1 로 거절. */
export function normalizeToolErrorSignatureViaRust(text: string): string | null {
  return runRustOrNull("normalize-tool-error-signature", { text }, asString);
}

/** tool-error-signature-key — TS private signatureKey 의 시임. payload {tool, status, error}. */
export function toolErrorSignatureKeyViaRust(
  tool: unknown,
  status: unknown,
  error: string,
): string | null {
  return runRustOrNull("tool-error-signature-key", { tool, status, error }, asString);
}

/** condense-tool-error-text — TS private condenseErrorText 의 시임. payload {error, count}. */
export function condenseToolErrorTextViaRust(error: string, count: number): string | null {
  return runRustOrNull("condense-tool-error-text", { error, count }, asString);
}

/** is-sensitive-tool-env-key — payload {key}. */
export function isSensitiveToolEnvKeyViaRust(key: string): boolean | null {
  return runRustOrNull("is-sensitive-tool-env-key", { key }, asBoolean);
}
