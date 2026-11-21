// server/src/services/runtime-guard-core-client.ts
//
// [목적] crates/runtime-guard-core Stage 1.1 동기(sync) Node 브리지 — extract-command
//   (runtime-command-extractor.ts) 와 broad-scan(runtime-broad-scan-command-policy.ts) 의
//   opt-in Rust 시임. Rust 성공 결과는 null("미탐지")일 수 있으므로 { ok: true, value } 로
//   포장하고, 브리지 null 은 "TS 폴백 신호" 로만 쓴다 — 두 null 을 섞지 않는다.
// [게이트] PAPERCLIP_RUNTIME_GUARD_CORE_BIN 만 본다: 빈값·NUL·상대경로는 게이트 폐쇄 =
//   스폰 없는 조용한 TS 직행(경고 0개). 기본 bin 탐색도 플래그도 없다 — 절대경로 설정만 연다.
// [폴백 계약] 스폰 오류(ENOENT·timeout)·non-zero 종료(lone surrogate 입력의 serde 거부 등)·
//   비JSON·shape 불량은 전부 null → TS 팔. stderr 는 파싱하지 않는다 — 판단 근거는
//   종료코드 + JSON 파싱 + shape 검증(기계 계약)뿐이다. TS 본문이 parity 의 최종 출처다.
// [수정시 영향] shape 검증을 느슨히 하면 parity 를 깨뜨린 채 Rust 결과가 흐른다. 게이트 env
//   이름이나 서브커맨드 이름을 바꾸면 runtime-guard-core-wiring 테스트가 깨진다.
import { spawnSync } from "node:child_process";
import path from "node:path";

const GUARD_CORE_TIMEOUT_MS = 10_000;
const GUARD_CORE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** Rust 성공 결과 — value 는 null("미탐지")일 수 있다. 브리지 null(=TS 폴백)과 구분된다. */
export interface RuntimeGuardOutcome<T> {
  readonly ok: true;
  readonly value: T;
}

/** 게이트 — 설정 env 는 절대경로만 허용한다(NUL 은 env 로 운반되지 않지만 방어한다). */
function resolveGuardCoreBin(): string | null {
  const configured = process.env.PAPERCLIP_RUNTIME_GUARD_CORE_BIN ?? "";
  if (configured === "" || configured.includes("\0") || !path.isAbsolute(configured)) return null;
  return configured;
}

/** 프로세스당 1회 fallback 경고. 게이트 폐쇄는 경고하지 않는다(조용한 TS 경로가 기본값이다). */
const fallbackWarnedKeys = new Set<string>();
function warnFallbackOnce(subcommand: string, reason: string): void {
  const key = `${subcommand}:${reason}`;
  if (fallbackWarnedKeys.has(key)) return;
  fallbackWarnedKeys.add(key);
  console.warn(`[runtime-guard-core] Rust helper fallback to Node (${subcommand}): ${reason}`);
}

/** 테스트 전용 — warn-once 상태는 프로세스 전역이라 케이스 간 오염을 막는다. */
export function resetRuntimeGuardCoreFallbackWarningsForTests(): void {
  fallbackWarnedKeys.clear();
}

/**
 * [목적] 동기 Rust 시임. 성공 종료 + JSON 파싱 + shape 통과일 때만 { ok, value } 를 돌려주고,
 *   그 외(게이트 폐쇄/스폰 오류/non-zero 종료/비JSON/shape 불량)는 null(TS 팔 신호)을 돌려준다.
 * [주의] validateShape 는 던지지 않고 불량 시 null 을 돌려준다 — 시임이 실패 원인을 종료코드·
 *   JSON·shape 의 기계 신호로만 분류한다.
 */
function runRustOrNull<T>(
  subcommand: string,
  payload: unknown,
  validateShape: (response: unknown) => RuntimeGuardOutcome<T> | null,
): RuntimeGuardOutcome<T> | null {
  const bin = resolveGuardCoreBin();
  if (bin === null) return null;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(bin, [subcommand], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      maxBuffer: GUARD_CORE_MAX_BUFFER_BYTES,
      timeout: GUARD_CORE_TIMEOUT_MS,
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

/** Rust 쪽 결과 계약은 string | null("미탐지") 두 갈래뿐이다. */
function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

/** extract-command — extractRuntimeCommand 의 시임. payload 는 { adapterType, line } 다. */
export function extractRuntimeCommandViaRust(
  adapterType: string,
  line: string,
): RuntimeGuardOutcome<string | null> | null {
  return runRustOrNull("extract-command", { adapterType, line }, (r) =>
    isNullableString(r) ? { ok: true, value: r } : null);
}

/** broad-scan 입력 — runtime-broad-scan-command-policy.ts 의 RuntimeBroadScanCommandInput 과 동형. */
export interface RuntimeGuardBroadScanInput {
  readonly command: string;
  readonly allowedPaths: readonly string[];
  readonly allowedDirectories: readonly string[];
  readonly workingDirectory?: string | null;
  readonly repoSearchRoot?: string | null;
  readonly shellVariables: ReadonlyMap<string, string>;
  readonly stdinFromPipe?: boolean;
}

/** broad-scan — findRuntimeBroadScanCommand 의 시임. shellVariables Map 을 JSON 객체로 변환한다. */
export function findRuntimeBroadScanCommandViaRust(
  input: RuntimeGuardBroadScanInput,
): RuntimeGuardOutcome<string | null> | null {
  const payload = {
    command: input.command,
    allowedPaths: [...input.allowedPaths],
    allowedDirectories: [...input.allowedDirectories],
    workingDirectory: input.workingDirectory ?? null,
    repoSearchRoot: input.repoSearchRoot ?? null,
    shellVariables: Object.fromEntries(input.shellVariables),
    stdinFromPipe: input.stdinFromPipe ?? false,
  };
  return runRustOrNull("broad-scan", payload, (r) =>
    isNullableString(r) ? { ok: true, value: r } : null);
}
