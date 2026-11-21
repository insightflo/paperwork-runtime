// server/src/services/schedule-core-client.ts
//
// [목적] crates/schedule-core (paperclip-schedule-core) stdin/stdout JSON CLI 의 동기(sync)
//   Node 브리지. cron.ts 의 순수 cron 표면(parse / validate / next-run)을 서브커맨드로
//   미러링한 Rust 바이너리에 표현식 단위로 위임한다 — cron.ts 는 null 이면 자기 TS 본문으로
//   조용히 폴백하므로 호출부 시그니처가 불변이다.
// [게이트] PAPERCLIP_SCHEDULE_CORE_BIN 만 본다: 빈값·NUL·상대경로는 게이트 폐쇄 = 스폰 없는
//   조용한 TS 직행. 절대경로일 때만 execFileSync 로 스폰한다.
// [폴백 계약] 100% 조용하다 — 스폰 오류(ENOENT·timeout)·non-zero 종료(parse/next-run 의
//   도메인 오류 채널: TS 도 같은 메시지의 Error 를 던지므로 결과가 TS-동일하게 관측된다)·
//   비JSON·shape 불량·lone surrogate 입력은 전부 null → TS 팔. warn-once 를 두지 않는다:
//   non-zero 는 이 크레이트의 정상 도메인 오류 채널이라 유효 트래픽에서 경고로 오염된다.
//   판단 근거는 종료코드 + JSON 파싱 + shape 검증(기계 계약)뿐이다. TS 본문이 parity 의
//   최종 출처다.
// [수정시 영향] shape 검증을 느슪히 하면 parity 를 깨뜨린 채 Rust 결과가 흐른다. 게이트 env
//   이름이나 서브커맨드 이름을 바꾸면 cron.ts 의 opt-in 위임 3곳과 schedule-core-wiring
//   테스트가 깨진다.
import { execFileSync } from "node:child_process";
import path from "node:path";

const SCHEDULE_CORE_TIMEOUT_MS = 10_000;
const SCHEDULE_CORE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** cron.ts 의 ParsedCron 와 같은 구조 — 순환 import 없이 클라이언트가 구조적으로 소유한다. */
export interface ScheduleCoreParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

/** 게이트 — 설정 env 는 절대경로만 허용한다(NUL 은 env 로 운반되지 않지만 방어한다). */
function resolveScheduleCoreBin(): string | null {
  const configured = process.env.PAPERCLIP_SCHEDULE_CORE_BIN ?? "";
  if (configured === "" || configured.includes("\0") || !path.isAbsolute(configured)) return null;
  return configured;
}

/**
 * [목적] 짝 없는 상/하위 서로게이트 검출. Rust stdin 은 utf8 바이트로 운반되므로 lone
 *   surrogate 는 U+FFFD 로 치환돼 간다 — 그러면 Rust 는 TS 와 다른 표현식을 본 것이 되어
 *   parity 가 깨진다. 직렬화 직후 검출해 TS 팔로 돌려야 TS 본문의 원문 문자열 동작이 그대로
 *   관측된다(메시지 안의 원래 코드 유닛 보존).
 */
export function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * [목적] 동기 Rust 시임. 성공 종료 + JSON 파싱 + shape 통과일 때만 Rust 결과를 돌려주고, 그 외
 *   (게이트 폐쇄/lone surrogate/스폰 오류/non-zero 종료/비JSON/shape 불량)는 null(TS 팔 신호)을
 *   돌려준다. validateShape 는 던지지 않고 불량 시 null 을 돌려준다 — 실패 분류는 종료코드·
 *   JSON·shape 의 기계 신호로만 한다.
 */
function runScheduleCoreOrNull<T>(
  subcommand: "parse" | "validate" | "next-run",
  payload: Record<string, unknown>,
  validateShape: (response: unknown) => T | null,
): T | null {
  const bin = resolveScheduleCoreBin();
  if (bin === null) return null;
  // 직렬화 "이전" 원문 문자열에서 lone surrogate 를 검사한다 — JSON.stringify 는 lone
  //   surrogate 를 \uXXXX escape 텍스트로 바꿔 직렬화본 검사를 무력화한다. 검출되면 Rust 에
  //   U+FFFD 치환 또는 serde 거부로 parity 가 깨질 입력이므로 스폰 없이 TS 팔로 간다.
  for (const value of Object.values(payload)) {
    if (typeof value === "string" && hasLoneSurrogate(value)) return null;
  }
  const serialized = JSON.stringify(payload);
  let stdout: string;
  try {
    stdout = execFileSync(bin, [subcommand], {
      input: serialized,
      encoding: "utf8",
      timeout: SCHEDULE_CORE_TIMEOUT_MS,
      maxBuffer: SCHEDULE_CORE_MAX_BUFFER_BYTES,
      // 명시적 pipe — execFileSync 는 stdio 미지정 시 자식 stderr 를 부모 stderr 로
      //   포워딩하는데, parse/next-run 의 도메인 오류 채널이 정상 트래픽이라 누출이
      //   계속된다. 캡처해 부모 콘솔을 조용히 유지한다(값은 사용하지 않는다).
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // ENOENT/EACCES 스폰 실패, timeout 종료, non-zero exit(도메인 오류 채널)을 동일 취급한다.
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  return validateShape(parsed);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

/** parse — 성공 {ok,parsed:{minutes,hours,daysOfMonth,months,daysOfWeek}}, 도메인 오류 exit 1. */
export function parseCronViaRust(expression: string): ScheduleCoreParsedCron | null {
  return runScheduleCoreOrNull("parse", { expression }, (r) => {
    if (typeof r !== "object" || r === null) return null;
    const parsed = (r as { parsed?: unknown }).parsed;
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (!isNumberArray(p.minutes) || !isNumberArray(p.hours) || !isNumberArray(p.daysOfMonth)
      || !isNumberArray(p.months) || !isNumberArray(p.daysOfWeek)) {
      return null;
    }
    return {
      minutes: p.minutes,
      hours: p.hours,
      daysOfMonth: p.daysOfMonth,
      months: p.months,
      daysOfWeek: p.daysOfWeek,
    };
  });
}

/**
 * validate — {valid: boolean, error: string | null}. "유효" 결과(null)와 폴백 신호(null)가
 *   겹치지 않게 {error} 랩퍼로 돌려준다: {error:null}=유효, {error:msg}=무효, null=브리지 불가.
 */
export function validateCronViaRust(expression: string): { error: string | null } | null {
  return runScheduleCoreOrNull("validate", { expression }, (r) => {
    if (typeof r !== "object" || r === null) return null;
    const { valid, error } = r as { valid?: unknown; error?: unknown };
    if (valid === true && error === null) return { error: null };
    if (valid === false && typeof error === "string") return { error };
    return null;
  });
}

/** next-run — {ok, nextMs: number | null}. nextMs:null=탐색 한도 내 매치 없음(정상 결과). */
export function nextRunViaRust(
  expression: string,
  afterMs: number,
): { nextMs: number | null } | null {
  return runScheduleCoreOrNull("next-run", { expression, afterMs }, (r) => {
    if (typeof r !== "object" || r === null) return null;
    const nextMs = (r as { nextMs?: unknown }).nextMs;
    if (nextMs === null) return { nextMs: null };
    if (typeof nextMs === "number" && Number.isFinite(nextMs)) return { nextMs };
    return null;
  });
}
