// server/src/services/portability-yaml-client.ts
//
// [목적] crates/portability-yaml (paperclip-portability-yaml) 서브커맨드의 동기(sync)
//   Node 브리지 — company-portability-yaml.ts Stage 5.1 emitter 의 opt-in Rust 실행 경로다.
//   - build-markdown      ↔ buildMarkdown
//   - build-yaml-file     ↔ buildYamlFile
//   - strip-empty-values  ↔ stripEmptyValues
//   대상 TS 공개 함수들이 동기 계약이라 execFileSync 기반 *ViaRust 시임으로 제공한다 —
//   서비스 파일은 null 이면 자기 TS 본문으로 조용히 폴백하므로 호출부 시그니처가 불변이다.
// [게이트] PAPERCLIP_PORTABILITY_YAML_BIN 만 본다: 빈값·NUL·상대경로는 게이트 폐쇄 =
//   스폰 없는 조용한 TS 직행. 전수 parity 는 portability-yaml-stage1-parity.test.ts 의
//   직접 스폰 계열이 담당한다 — 이 파일은 opt-in transport 만 소유한다.
// [입력 가드] stdin 은 JSON 뿐이라 JSON 으로 무손실 표현 불가한 값은 스폰 전에 걸러낸다:
//   lone surrogate 문자열·키(serde 거부), undefined·BigInt·function·symbol(JSON 소실/오류),
//   NaN·±Infinity·-0(null·0 으로 의미 변질), 순환 참조·비-plain 객체(stringify 오류/변형).
// [폴백 계약] 가드 불량·스폰 오류(ENOENT·timeout)·non-zero 종료·비JSON·shape 불일치는
//   전부 null → TS 팔. stderr 는 파싱하지 않는다 — 판단 근거는 종료코드 + JSON 파싱 +
//   shape 검증(기계 계약)뿐이다. TS 본문이 parity 의 최종 출처다.
// [strip-empty-values 주의] Rust 는 root 가 drop 되면 {"value":null} 을 낸다(TS undefined).
//   kept null 은 존재하지 않으므로(Null 은 항상 drop) null→undefined 매핑이 정확하다.
//   undefined 도 유효 결과라 팔 신호 null 과 구분하려고 {value} 래퍼로 돌려준다.
// [수정시 영향] shape 검증을 느슨히 하면 parity 를 깨뜨린 채 Rust 결과가 흐른다. 게이트
//   규칙이나 시임 이름을 바꾸면 company-portability-yaml 의 opt-in 호출과
//   portability-yaml-wiring 테스트가 깨진다.
import { execFileSync } from "node:child_process";
import path from "node:path";

const TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** 게이트 — 설정 env 는 절대경로만 허용한다(NUL 은 env 로 운반되지 않지만 방어한다). */
function resolveBin(): string | null {
  const configured = process.env.PAPERCLIP_PORTABILITY_YAML_BIN ?? "";
  if (configured === "" || configured.includes("\0") || !path.isAbsolute(configured)) return null;
  return configured;
}

/** 프로세스당 1회 fallback 경고. 게이트 폐쇄는 경고하지 않는다(조용한 TS 경로가 기본값이다). */
const fallbackWarnedKeys = new Set<string>();
function warnFallbackOnce(subcommand: string, reason: string): void {
  const key = `${subcommand}:${reason}`;
  if (fallbackWarnedKeys.has(key)) return;
  fallbackWarnedKeys.add(key);
  console.warn(`[portability-yaml] Rust helper fallback to Node (${subcommand}): ${reason}`);
}

/** 테스트 전용 — warn-once 상태는 프로세스 전역이라 케이스 간 오염을 막는다. */
export function resetPortabilityYamlFallbackWarningsForTests(): void {
  fallbackWarnedKeys.clear();
}

/** UTF-16 코드유닛 스캔 — 짝 없는 high/low surrogate 가 하나라도 있으면 true. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1); // 범위 밖이면 NaN → 짝 없음 → lone
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * [목적] JSON 무손실 왕복 가능성 검사 — false 면 스폰 없이 null(TS 팔).
 *   seen 은 경로(path) 기반 순환 탐지다: 재귀가 빠져나가며 지우므로 같은 객체의
 *   공유 참조(diamond)는 허용하고 진짜 순환만 걸러낸다.
 *   plain object(Object.prototype·null 프로토타입)와 배열만 통과 — Date·Map 같은
 *   비-plain 객체는 JSON.stringify 결과(toJSON 등)가 TS 렌더 계약과 어긋난다.
 */
function isJsonSafeValue(value: unknown, seen: Set<unknown>): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
      return true;
    case "string":
      return !hasLoneSurrogate(value);
    case "number":
      // NaN·±Infinity 는 stringify 시 null 로, -0 은 0 으로 의미가 변질된다.
      return Number.isFinite(value) && !Object.is(value, -0);
    case "object":
      break;
    default:
      return false; // undefined·bigint·function·symbol — 소실 또는 stringify 오류
  }
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((entry) => isJsonSafeValue(entry, seen));
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.entries(value as Record<string, unknown>).every(
      ([key, entry]) => !hasLoneSurrogate(key) && isJsonSafeValue(entry, seen),
    );
  } finally {
    seen.delete(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * [목적] 동기 Rust 시임. 게이트 통과 + JSON-safe 가드 + 종료 0 + JSON 파싱 + shape
 *   통과일 때만 Rust 결과를 돌려주고, 그 외는 null(TS 팔 신호)을 돌려준다.
 *   execFileSync 는 스폰 오류·non-zero 종료·timeout 을 모두 throw 로 모은다 —
 *   error.status 가 숫자면 종료코드(exit_N), 아니면 스폰 계열(spawn_error)로 분류한다.
 */
function runRustOrNull<T>(
  subcommand: string,
  payload: unknown,
  validateShape: (response: unknown) => T | null,
): T | null {
  const bin = resolveBin();
  if (bin === null) return null;
  if (!isJsonSafeValue(payload, new Set())) {
    warnFallbackOnce(subcommand, "unsafe_payload");
    return null;
  }
  let stdout: string;
  try {
    stdout = execFileSync(bin, [subcommand], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    warnFallbackOnce(
      subcommand,
      typeof status === "number"
        ? `exit_${status}`
        : `spawn_error:${error instanceof Error ? error.name : "unknown"}`,
    );
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

/** `{field: string}` 봉투 shape 검사 — build-markdown(markdown)·build-yaml-file(yaml) 공용. */
function shapedString(response: unknown, field: "markdown" | "yaml"): string | null {
  if (!isPlainRecord(response)) return null;
  const value = response[field];
  return typeof value === "string" ? value : null;
}

/** build-markdown — payload 는 { frontmatter, body } 그 자체다. */
export function buildMarkdownViaRust(
  frontmatter: Record<string, unknown>,
  body: string,
): string | null {
  return runRustOrNull("build-markdown", { frontmatter, body }, (r) => shapedString(r, "markdown"));
}

/** build-yaml-file — preserveEmptyStrings 생략은 Rust optional_flag 기본값(false)과 동일. */
export function buildYamlFileViaRust(
  value: Record<string, unknown>,
  opts?: { preserveEmptyStrings?: boolean },
): string | null {
  return runRustOrNull(
    "build-yaml-file",
    { value, preserveEmptyStrings: opts?.preserveEmptyStrings ?? false },
    (r) => shapedString(r, "yaml"),
  );
}

/**
 * strip-empty-values — Rust 응답 {value:null} 은 root drop(TS undefined)을 뜻한다.
 *   kept null 은 없으므로(Null 입력도 drop) null→undefined 매핑이 정확하며,
 *   undefined 도 유효 결과이므로 {value} 래퍼로 팔 신호 null 과 구분한다.
 */
export function stripEmptyValuesViaRust(
  value: unknown,
  opts?: { preserveEmptyStrings?: boolean },
): { value: unknown } | null {
  return runRustOrNull(
    "strip-empty-values",
    { value, preserveEmptyStrings: opts?.preserveEmptyStrings ?? false },
    (r) => {
      if (!isPlainRecord(r) || !("value" in r)) return null;
      const stripped = r.value;
      return { value: stripped === null ? undefined : stripped };
    },
  );
}
