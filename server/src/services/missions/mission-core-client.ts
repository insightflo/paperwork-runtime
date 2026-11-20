import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isMissionPlanUnitMaterialized as isMissionPlanUnitMaterializedNode,
  normalizeMissionPlanDependencyGraph as normalizeMissionPlanDependencyGraphNode,
  remapCanonicalDependenciesToStepIds as remapCanonicalDependenciesToStepIdsNode,
  type NormalizeMissionPlanDependencyGraphResult,
} from "./mission-plan-dependency-graph.js";
import {
  extractMissionQualityContract as extractMissionQualityContractNode,
  renderMissionQualityContractSection as renderMissionQualityContractSectionNode,
} from "./mission-quality-contract.js";
import {
  buildCanonicalRevisionDelta as buildCanonicalRevisionDeltaNode,
  parseRevisionReusePlanRecord as parseRevisionReusePlanRecordNode,
  resolveReuseClosure as resolveReuseClosureNode,
} from "./revision-reuse-plan.js";

/**
 * [목적] Rust mission-core bin(paperclip-mission-core) stdin-JSON 브리지 + Node TS fallback.
 *   workflow-core-client.ts 와 같은 전송 계약: spawn → stdout JSON, stderr 는 tail 캡.
 *   단 Rust 경로는 opt-in — MISSION_CORE_RUST 가 '1'/'true' 이고 bin 이 resolve 될 때만 시도.
 * [주의] 이 bin 은 시맨틱 에러(TS throw 의 byte-identical 미러)를 stderr + exit 1 로 보고한다
 *   ({error:{code}} 봉투 없음). exit 1 + stderr 는 TS 와 동일 문장의 판정이므로 fallback 없이
 *   그대로 던진다 — fallback 이 판정을 흡수하면 어느 팔이 답했는지 증명할 수 없다.
 *   그 외 비정상 종료·스폰 실패·타임아웃·비JSON·shape 불일치만 warn-once 후 TS 로 되돌아간다.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_BIN = path.join(
  fileURLToPath(new URL("../../../..", import.meta.url)),
  "crates/mission-core/target/release/paperclip-mission-core",
);

/**
 * PAPERCLIP_MISSION_CORE_BIN 해석 — 설정값은 절대경로만 허용·NUL 거부(스폰 ENOENT fallback 이
 * 'missing bin' 경고를 만든다). 미설정 시 컴파일된 기본 경로를 실재할 때만 쓴다(기본 bin 부재는
 * 실패가 아니라 게이트 폐쇄 — 조용한 TS 경로). 인자를 받는 이유: process.env 는 NUL 을 운반하지
 * 못해 \0 거부 분기를 env stub 으로 검증할 수 없다. 무인자 호출이 프로덕션 경로다.
 */
export function resolveMissionCoreBin(
  configured: string | undefined = process.env.PAPERCLIP_MISSION_CORE_BIN,
): string | null {
  const trimmed = configured?.trim() ?? "";
  if (trimmed) return path.isAbsolute(trimmed) && !trimmed.includes("\0") ? trimmed : null;
  return existsSync(DEFAULT_BIN) ? DEFAULT_BIN : null;
}

/** helper 를 신뢰할 수 없다(부재/스폰 실패/비정상 종료/타임아웃) — 호출자는 TS 로 되돌아간다. */
export class MissionCoreUnavailableError extends Error {
  constructor(reason: string) { super(reason); this.name = "MissionCoreUnavailableError"; }
}
/** helper 가 계약을 어겼다(비JSON 출력·shape 불일치) — fallback 대상. 시맨틱 에러와 구분된다. */
export class MissionCoreContractError extends Error {
  constructor(reason: string) { super(reason); this.name = "MissionCoreContractError"; }
}

function missionCoreRustFlagOn(): boolean {
  const flag = (process.env.MISSION_CORE_RUST ?? "").trim();
  return flag === "1" || flag === "true";
}
/** 게이트가 의도적으로 닫혀 있으면 fallback 은 '실패'가 아니므로 warn 하지 않는다. */
function missionCoreRustEnabled(): boolean {
  return missionCoreRustFlagOn() && resolveMissionCoreBin() !== null;
}

/** Rust helper 1회 스폰 — 게이트가 닫히면 Unavailable. exit 1 + stderr 는 TS throw 미러로 그대로 던진다. */
export function runMissionCoreSubcommand<T = unknown>(
  subcommand: string,
  payload: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const bin = resolveMissionCoreBin();
  if (bin === null || !missionCoreRustFlagOn()) {
    return Promise.reject(new MissionCoreUnavailableError("mission_core_disabled"));
  }
  return new Promise<T>((resolve, reject) => {
    const child = spawn(bin, [subcommand], { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0, stderrTail = "", settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: MissionCoreUnavailableError | MissionCoreContractError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    timer = setTimeout(() => fail(new MissionCoreUnavailableError("mission_core_timeout")), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) return fail(new MissionCoreContractError("mission_core_stdout_overflow"));
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (err: NodeJS.ErrnoException) =>
      fail(new MissionCoreUnavailableError(`mission_core_spawn_${err.code ?? "error"}`)));
    child.stdin.on("error", () => fail(new MissionCoreUnavailableError("mission_core_stdin_error")));
    child.stdout.on("error", () => fail(new MissionCoreUnavailableError("mission_core_stdout_error")));
    child.stderr.on("error", () => fail(new MissionCoreUnavailableError("mission_core_stderr_error")));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 1 && stderrTail.trim()) {
        // 시맨틱 에러 — TS TypeError/Error 의 바이트-동일 미러. fallback 금지.
        reject(new Error(stderrTail.trim()));
        return;
      }
      if (code !== 0) {
        reject(new MissionCoreUnavailableError(
          `mission_core_exit_${code ?? "signal"}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""}`,
        ));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8")) as T);
      } catch {
        reject(new MissionCoreContractError("mission_core_bad_json"));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/** 프로세스당 1회 fallback 경고 — 스폰 실패가 매 패스마다 로그를 도배하지 않게 한다. */
const fallbackWarnedKeys = new Set<string>();
function warnFallbackOnce(subcommand: string, reason: string): void {
  const key = `${subcommand}:${reason}`;
  if (fallbackWarnedKeys.has(key)) return;
  fallbackWarnedKeys.add(key);
  console.warn(`[mission-core] Rust helper fallback to Node (${subcommand}): ${reason}`);
}
/** 테스트 전용 — warn-once 상태는 프로세스 전역이라 케이스 간 오염을 막는다. */
export function resetMissionCoreFallbackWarningsForTests(): void {
  fallbackWarnedKeys.clear();
}

/**
 * Rust 우선 · Node fallback 공통 실행기. 게이트 폐쇄 → 조용한 TS 직행.
 * validateShape 가 MissionCoreContractError 를 던지면(shape 불일치) warn-once 후 fallback 한다.
 * 시맨틱 에러(exit 1 stderr)를 포함한 그 외 에러는 재발사 없이 그대로 전파한다.
 */
export async function runMissionCoreWithNodeFallback<T>(
  subcommand: string,
  payload: unknown,
  validateShape: (response: unknown) => T,
  fallbackFn: () => T | Promise<T>,
): Promise<T> {
  if (!missionCoreRustEnabled()) return await fallbackFn();
  let response: unknown;
  try {
    response = await runMissionCoreSubcommand(subcommand, payload);
  } catch (err) {
    if (err instanceof MissionCoreUnavailableError || err instanceof MissionCoreContractError) {
      warnFallbackOnce(subcommand, err.message);
      return await fallbackFn();
    }
    throw err;
  }
  try {
    return validateShape(response);
  } catch (err) {
    if (err instanceof MissionCoreContractError) {
      warnFallbackOnce(subcommand, err.message);
      return await fallbackFn();
    }
    throw err;
  }
}

const isObjectRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");
const shape = <T>(cond: boolean, value: T, reason: string): T => {
  if (!cond) throw new MissionCoreContractError(`mission_core_${reason}_bad_shape`);
  return value;
};
/** `{ok:boolean,...}` 공통 봉투 — ok 면 okCheck, 아니면 diagnostics 배열 검사. */
const envelope = (r: unknown, okCheck: (o: Record<string, unknown>) => boolean, reason: string) =>
  shape(isObjectRecord(r) && typeof r.ok === "boolean" && (r.ok ? okCheck(r) : Array.isArray(r.diagnostics)),
    r, reason);

export function normalizeMissionPlanDependencyGraphWithNodeFallback(
  selectedExecutionUnits: Parameters<typeof normalizeMissionPlanDependencyGraphNode>[0],
  draftSteps: Parameters<typeof normalizeMissionPlanDependencyGraphNode>[1] = [],
): Promise<NormalizeMissionPlanDependencyGraphResult> {
  return runMissionCoreWithNodeFallback("normalize-dependency-graph",
    { units: selectedExecutionUnits, draftSteps },
    (r) => envelope(r,
      (o) => isObjectRecord(o.graph)
        && ["units", "draftSteps", "dependencyIndex", "materializedUnits", "materializedDependencyIndex"]
          .every((k) => Array.isArray((o.graph as Record<string, unknown>)[k])),
      "normalize") as unknown as NormalizeMissionPlanDependencyGraphResult,
    () => normalizeMissionPlanDependencyGraphNode(selectedExecutionUnits, draftSteps));
}

export function isMissionPlanUnitMaterializedWithNodeFallback(
  unit: Parameters<typeof isMissionPlanUnitMaterializedNode>[0],
): Promise<boolean> {
  return runMissionCoreWithNodeFallback("is-unit-materialized", { unit },
    (r) => shape(typeof r === "boolean", r as boolean, "materialized"),
    () => isMissionPlanUnitMaterializedNode(unit));
}

export function remapCanonicalDependenciesToStepIdsWithNodeFallback(
  units: Parameters<typeof remapCanonicalDependenciesToStepIdsNode>[0],
  stepIds: Parameters<typeof remapCanonicalDependenciesToStepIdsNode>[1],
): Promise<string[][]> {
  return runMissionCoreWithNodeFallback("remap-to-step-ids", { units, stepIds },
    (r) => shape(Array.isArray(r) && r.every(isStringArray), r, "remap") as string[][],
    () => remapCanonicalDependenciesToStepIdsNode(units, stepIds));
}

export function extractMissionQualityContractWithNodeFallback(
  input: Parameters<typeof extractMissionQualityContractNode>[0],
): Promise<ReturnType<typeof extractMissionQualityContractNode>> {
  return runMissionCoreWithNodeFallback("extract-quality-contract", input,
    (r) => {
      const s = isObjectRecord(r) ? r.signals : null;
      return shape(
        isObjectRecord(r) && typeof r.purpose === "string" && typeof r.targetUser === "string"
          && typeof r.useCase === "string" && isStringArray(r.mustDeliver) && isStringArray(r.failureCriteria)
          && isStringArray(r.evaluationAxes) && isStringArray(r.hardStopRules)
          && typeof r.underspecified === "boolean" && (r.clarifyNote === null || typeof r.clarifyNote === "string")
          && isObjectRecord(s) && typeof s.beginnerFacing === "boolean" && typeof s.actionableReport === "boolean"
          && typeof s.deepResearch === "boolean" && typeof s.publishHtml === "boolean",
        r, "extract_contract") as ReturnType<typeof extractMissionQualityContractNode>;
    },
    () => extractMissionQualityContractNode(input));
}

export function renderMissionQualityContractSectionWithNodeFallback(
  contract: Parameters<typeof renderMissionQualityContractSectionNode>[0],
): Promise<string[]> {
  return runMissionCoreWithNodeFallback("render-quality-contract-section", { contract },
    (r) => shape(isStringArray(r), r as string[], "render_section"),
    () => renderMissionQualityContractSectionNode(contract));
}

export function parseMissionRevisionReusePlanRecordWithNodeFallback(
  refs: Parameters<typeof parseRevisionReusePlanRecordNode>[0],
): Promise<ReturnType<typeof parseRevisionReusePlanRecordNode>> {
  return runMissionCoreWithNodeFallback("parse-reuse-plan-record", { refs },
    (r) => r === null ? null : shape(
      isObjectRecord(r) && typeof r.schemaVersion === "string" && typeof r.sourceWorkflowRunId === "string"
        && isStringArray(r.roots) && isStringArray(r.closureUnitIds),
      r, "reuse_plan_record") as ReturnType<typeof parseRevisionReusePlanRecordNode>,
    () => parseRevisionReusePlanRecordNode(refs));
}

export function resolveMissionRevisionReuseClosureWithNodeFallback(
  sourceSteps: Parameters<typeof resolveReuseClosureNode>[0],
  roots: Parameters<typeof resolveReuseClosureNode>[1],
): Promise<ReturnType<typeof resolveReuseClosureNode>> {
  return runMissionCoreWithNodeFallback("resolve-reuse-closure", { sourceSteps, roots },
    (r) => envelope(r, (o) => isStringArray(o.closure), "reuse_closure") as ReturnType<typeof resolveReuseClosureNode>,
    () => resolveReuseClosureNode(sourceSteps, roots));
}

export function buildCanonicalMissionRevisionDeltaWithNodeFallback(
  rawDelta: Parameters<typeof buildCanonicalRevisionDeltaNode>[0],
  closureUnitIds: Parameters<typeof buildCanonicalRevisionDeltaNode>[1],
): Promise<Record<string, unknown>> {
  return runMissionCoreWithNodeFallback("build-canonical-revision-delta", { rawDelta, closureUnitIds },
    (r) => shape(isObjectRecord(r), r as Record<string, unknown>, "revision_delta"),
    () => buildCanonicalRevisionDeltaNode(rawDelta, closureUnitIds));
}
