// server/src/services/missions/mission-core-client-s9.ts
//
// [목적] crates/mission-core Stage 9A/9C/9D 서브커맨드의 동기(sync) Node 브리지.
//   - 9A revision-plan-declaration-targets: read-step-declared-dependency-unit-ids
//   - 9C operator-card-summary: format-operator-decision-summary
//   - 9D mission-plan-qa: review-plan-against-intent
//   대상 TS 공개 함수들이 동기 계약이라 spawnSync 기반 try-*ViaRust 시임으로 제공한다 —
//   서비스 파일은 null 이면 자기 TS 본문으로 조용히 폴백하므로 호출부 시그니처가 불변이다.
//   9A의 read-unit-id / has-dependency-declaration, 9D의 build-clarification-request /
//   extract-unit-roles 는 조합 헬퍼·순수 mapper 라 스폰 비용 대비 이득이 없어 시임에서 뺐다
//   (전수 parity 는 mission-core-*-parity.test.ts 직접 스폰 계열이 담당한다).
// [게이트] PAPERCLIP_MISSION_CORE_BIN 만 본다: 빈값·NUL·상대경로는 게이트 폐쇄 = 스폰 없는
//   조용한 TS 직행. s6/s8 클라이언트(mission-core-client.ts)의 MISSION_CORE_RUST 플래그와
//   기본 bin 탐색과는 독립이다 — 이 파일은 transport 를 재사용하지 않고 동기 시임을 소유한다.
// [폴백 계약] 스폰 오류(ENOENT·timeout)·non-zero 종료(lone surrogate 입력의 serde 거부 등)·
//   비JSON·shape 불일치는 전부 null → TS 팔. stderr 는 파싱하지 않는다 — 판단 근거는
//   종료코드 + JSON 파싱 + shape 검증(기계 계약)뿐이다. TS 본문이 parity 의 최종 출처다.
// [수정시 영향] shape 검증을 느슷히 하면 parity 를 깨뜨린 채 Rust 결과가 흐른다. 게이트 규칙이나
//   시임 이름을 바꾸면 서비스 3개 파일의 opt-in 호출과 mission-core-s9-wiring 테스트가 깨진다.
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { OperatorCardSummaryInput } from "./operator-card-summary.js";
import type { MissionIntent } from "./mission-intent.js";
import type { PlanningArtifactTool } from "./mission-plan-publication-contract.js";
import type { PlanQaDiagnostic } from "./mission-plan-qa.js";

const S9_TIMEOUT_MS = 10_000;
const S9_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** 게이트 — 설정 env 는 절대경로만 허용한다(NUL 은 env 로 운반되지 않지만 방어한다). */
function resolveS9Bin(): string | null {
  const configured = process.env.PAPERCLIP_MISSION_CORE_BIN ?? "";
  if (configured === "" || configured.includes("\0") || !path.isAbsolute(configured)) return null;
  return configured;
}

/** 프로세스당 1회 fallback 경고. 게이트 폐쇄는 경고하지 않는다(조용한 TS 경로가 기본값이다). */
const fallbackWarnedKeys = new Set<string>();
function warnFallbackOnce(subcommand: string, reason: string): void {
  const key = `${subcommand}:${reason}`;
  if (fallbackWarnedKeys.has(key)) return;
  fallbackWarnedKeys.add(key);
  console.warn(`[mission-core-s9] Rust helper fallback to Node (${subcommand}): ${reason}`);
}

/** 테스트 전용 — warn-once 상태는 프로세스 전역이라 케이스 간 오염을 막는다. */
export function resetMissionCoreS9FallbackWarningsForTests(): void {
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
  const bin = resolveS9Bin();
  if (bin === null) return null;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(bin, [subcommand], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      maxBuffer: S9_MAX_BUFFER_BYTES,
      timeout: S9_TIMEOUT_MS,
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// mission-plan-qa.ts PlanQaDiagnosticCode 집합과 같은 목록 — Rust 포트도 같은 집합만 낸다.
const PLAN_QA_CODES: ReadonlySet<string> = new Set([
  "missing_publish_unit",
  "missing_publish_readback_qa",
  "missing_publication_verify_tool",
  "missing_artifact_qa_before_delivery",
  "invalid_artifact_qa_delivery_order",
  "invalid_artifact_workproduct_marker",
  "invalid_delivery_tool_preflight_unit",
  "missing_audience_split",
  "missing_scenario_taxonomy",
]);
const PLAN_QA_SEVERITIES: ReadonlySet<string> = new Set(["invalid", "needs_clarification"]);

function isPlanQaDiagnostics(value: unknown): value is PlanQaDiagnostic[] {
  return Array.isArray(value) && value.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const d = item as Partial<PlanQaDiagnostic>;
    return typeof d.code === "string" && PLAN_QA_CODES.has(d.code)
      && (d.severity === "invalid" || d.severity === "needs_clarification")
      && typeof d.message === "string";
  });
}

/** 9C — format-operator-decision-summary. payload 는 카드 입력 객체 그 자체다. */
export function formatOperatorDecisionSummaryViaRust(input: OperatorCardSummaryInput): string | null {
  return runRustOrNull("format-operator-decision-summary", input, (r) =>
    typeof r === "string" ? r : null);
}

/** 9A — read-step-declared-dependency-unit-ids. TS 는 Set<string>, Rust 는 string[]. */
export function readStepDeclaredDependencyUnitIdsViaRust(
  decision: Record<string, unknown>,
  declaredUnits: readonly Record<string, unknown>[],
): Set<string> | null {
  return runRustOrNull("read-step-declared-dependency-unit-ids", { decision, declaredUnits }, (r) =>
    isStringArray(r) ? new Set(r) : null);
}

/** 9D — review-plan-against-intent. critiqueHook 활성 시 우회 판단은 호출자(mission-plan-qa)가 한다. */
export function reviewPlanAgainstIntentViaRust(input: {
  intent: MissionIntent;
  selectedExecutionUnits: ReadonlyArray<Record<string, unknown>>;
  successCriteria?: unknown[];
  tools?: readonly PlanningArtifactTool[];
}): PlanQaDiagnostic[] | null {
  return runRustOrNull("review-plan-against-intent", input, (r) =>
    isPlanQaDiagnostics(r) ? r : null);
}
