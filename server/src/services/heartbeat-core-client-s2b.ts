// server/src/services/heartbeat-core-client-s2b.ts
//
// [목적] crates/heartbeat-core Stage 2B 서브커맨드의 동기(sync) Node 브리지.
//   - session-reset: heartbeat-session-reset.ts 3종(hasWorkflowQaReworkContract /
//     shouldResetTaskSessionForWake / describeSessionResetReason)을 한 번에 계산
//   - output-validation: heartbeat-output-validation.ts 2종
//     (canApplyMissingWorkProductRegistrationGate / resolveStepRunRequiresWorkProduct)
//   - progress-evidence: heartbeat-stability.ts hasRunProgressEvidence(아직 서비스
//     wiring 지점이 없어 래퍼만 제공 — 호출부 생기면 동일 패턴으로 붙인다)
//   대상 TS 공개 함수들이 동기 계약이라 spawnSync 기반 try-*ViaRust 로 제공한다 —
//   서비스 파일은 null 이면 자기 TS 본문으로 조용히 폴백하므로 호출부 시그니처가 불변이다.
// [게이트] Stage 1 브리지(heartbeat-core-client.ts)와 같은 PAPERCLIP_HEARTBEAT_CORE_BIN 만
//   본다: 빈값·NUL·상대경로는 게이트 폐쇄 = 스폰 없는 조용한 TS 직행. 기본 bin 탐색은 없다 —
//   opt-in 만이 Rust 팔을 연다.
// [폴백 계약] 스폰 오류(ENOENT·timeout)·payload 직렬화 불가(BigInt 등 non-JSON-safe —
//   JSON.stringify 도 try 안에서)·non-zero 종료(lone surrogate 입력의 serde 거부·TS-throw
//   미러)·비JSON·shape 불일치는 전부 null → TS 팔. progress-evidence 는 그에 더해 스폰 전
//   입력 가드를 둔다: Date 는 유효한 경우만 epoch ms 로 변환하고, 유효하지 않거나 비Date·
//   Set 아님·배열 아닌 입력은 스폰 없이 null → TS(경고 없음 — 게이트 폐쇄와 같은 조용한 경로).
//   stderr 는 파싱하지 않는다 — 판단 근거는 종료코드 + JSON 파싱 + shape 검증(기계 계약)뿐이다.
//   TS 본문이 parity 의 최종 출처다. session-reset 의 reason null / output-validation 의
//   stepRequires absent(undefined) 는 "값 없음"의 정상 Rust 결과이고, 반환 null 만이 폴백
//   신호다(bundle/response 래퍼가 그 경계를 나눈다).
// [수정시 영향] shape 검증을 느슨히 하면 parity 를 깨뜨린 채 Rust 결과가 흐른다. 시임 이름이나
//   payload 키를 바꾸면 heartbeat-session-reset.ts·heartbeat-output-validation.ts 의 opt-in
//   호출과 heartbeat-core-s2b-wiring 테스트가 깨진다.
import { spawnSync } from "node:child_process";
import path from "node:path";

const HB_TIMEOUT_MS = 10_000;
const HB_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** 게이트 — Stage 1 클라이언트와 동일 규칙: 절대경로만 허용(NUL 은 env 로 운반되지 않지만 방어). */
function resolveHeartbeatCoreBin(): string | null {
  const configured = process.env.PAPERCLIP_HEARTBEAT_CORE_BIN ?? "";
  if (configured === "" || configured.includes("\0") || !path.isAbsolute(configured)) return null;
  return configured;
}

/** 프로세스당 1회 fallback 경고. 게이트 폐쇄·입력 가드는 경고하지 않는다(조용한 TS 경로가 기본값). */
const fallbackWarnedKeys = new Set<string>();
function warnFallbackOnce(subcommand: string, reason: string): void {
  const key = `${subcommand}:${reason}`;
  if (fallbackWarnedKeys.has(key)) return;
  fallbackWarnedKeys.add(key);
  console.warn(`[heartbeat-core-s2b] Rust helper fallback to Node (${subcommand}): ${reason}`);
}

/** 테스트 전용 — warn-once 상태는 프로세스 전역이라 케이스 간 오염을 막는다. */
export function resetHeartbeatCoreS2bFallbackWarningsForTests(): void {
  fallbackWarnedKeys.clear();
}

/**
 * [목적] 동기 Rust 시임. 성공 종료 + JSON 파싱 + shape 통과일 때만 Rust 결과를 돌려주고,
 *   그 외(게이트 폐쇄/직렬화 불가/스폰 오류/non-zero 종료/비JSON/shape 불량)는 null(TS 팔 신호).
 * [주의] validateShape 는 던지지 않는다 — 시임이 실패 원인을 종료코드·JSON·shape 의 기계
 *   신호로만 분류한다. JSON.stringify 도 try 안에서 — non-JSON-safe payload 는 throw 대신 폴백.
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
      stdio: ["pipe", "pipe", "pipe"],
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

// --- session-reset ---------------------------------------------------------

export type SessionResetRustBundle = {
  hasQaReworkContract: boolean;
  shouldReset: boolean;
  reason: string | null;
};

function isSessionResetBundle(value: unknown): value is SessionResetRustBundle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Partial<SessionResetRustBundle>;
  return typeof v.hasQaReworkContract === "boolean"
    && typeof v.shouldReset === "boolean"
    && (typeof v.reason === "string" || v.reason === null);
}

/**
 * session-reset 시임. contextSnapshot(null/undefined 포함)을 그대로 payload 로 보내면
 * Rust 가 3 함수의 계산 결과를 한 번에 돌려준다. reason null 은 "리셋 사유 없음"의 정상
 * 결과이고, 반환 null 만이 폴백 신호다.
 */
export function sessionResetViaRust(contextSnapshot: unknown): SessionResetRustBundle | null {
  return runRustOrNull("session-reset", { contextSnapshot }, (r) =>
    isSessionResetBundle(r) ? r : null);
}

// --- output-validation -------------------------------------------------------

export type OutputValidationRustResponse = {
  gate: boolean;
  stepRequires?: boolean;
};

function isOutputValidationResponse(value: unknown): value is OutputValidationRustResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Partial<OutputValidationRustResponse>;
  if (typeof v.gate !== "boolean") return false;
  return v.stepRequires === undefined || typeof v.stepRequires === "boolean";
}

/**
 * output-validation 시임. issue.absent/null 은 Rust 계약상 Err(exit 1)이므로 게이트 판정에는
 * 원 issue 를 그대로 보내고, metadata 3상 판정에는 gate 계산에 영향을 줄 수 없는 빈 issue({})
 * 를 실어 보낸다(서브커맨드의 issue 필수 계약을 만족시키는 최소값). stepRequires 는
 * metadata.graphWorkProductRequired 가 boolean 으로 stamp 된 경우만 응답에 나온다 —
 * absent(undefined) 는 "미스탬프"의 정상 결과이고, 반환 null 만이 폴백 신호다.
 */
export function outputValidationViaRust(payload: {
  issue: unknown;
  stepRunRequiresWorkProduct?: unknown;
  metadata?: unknown;
}): OutputValidationRustResponse | null {
  return runRustOrNull("output-validation", payload, (r) =>
    isOutputValidationResponse(r) ? r : null);
}

// --- progress-evidence -------------------------------------------------------

/** Date → epoch ms. 유효한 Date 만 통과(그 외 null — 호출부에서 스폰 회수 신호로 쓴다). */
function epochMsOrNull(value: unknown): number | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
}

/**
 * progress-evidence 시임. TS 계약(heartbeat-stability.ts hasRunProgressEvidence)의
 * ReadonlySet/Date 를 JSON-wire(Set→배열, 유효 Date→epoch ms, nullish→null)로 변환해 보낸다.
 * 입력이 그 계약을 벗어나면(유효하지 않은 Date·비Date 타임스탬프·Set 아님·배열 아님·run 비객체)
 * 스폰하지 않고 null → TS — TS 본문이 원래 입력으로 내던 비교 결과·TypeError 까지 그대로 재현한다.
 * 반환 null 은 언제나 폴백 신호다(정상 결과는 true/false).
 */
export function hasRunProgressEvidenceViaRust(input: {
  run: { id: unknown; startedAt: unknown; finishedAt: unknown; createdAt: unknown };
  workProductRunIds: unknown;
  transitionRunIds: unknown;
  agentCommentTimestamps: unknown;
}): boolean | null {
  const run = input.run;
  if (typeof run !== "object" || run === null) return null;
  if (run.startedAt != null && epochMsOrNull(run.startedAt) === null) return null;
  if (run.finishedAt != null && epochMsOrNull(run.finishedAt) === null) return null;
  const createdAt = epochMsOrNull(run.createdAt);
  if (createdAt === null) return null;
  if (!(input.workProductRunIds instanceof Set) || !(input.transitionRunIds instanceof Set)) return null;
  if (!Array.isArray(input.agentCommentTimestamps)) return null;
  const comments: number[] = [];
  for (const ts of input.agentCommentTimestamps) {
    const ms = epochMsOrNull(ts);
    if (ms === null) return null;
    comments.push(ms);
  }
  return runRustOrNull(
    "progress-evidence",
    {
      run: {
        id: run.id,
        startedAt: run.startedAt == null ? null : epochMsOrNull(run.startedAt),
        finishedAt: run.finishedAt == null ? null : epochMsOrNull(run.finishedAt),
        createdAt,
      },
      workProductRunIds: Array.from(input.workProductRunIds),
      transitionRunIds: Array.from(input.transitionRunIds),
      agentCommentTimestamps: comments,
    },
    (r) => (typeof r === "boolean" ? r : null),
  );
}
