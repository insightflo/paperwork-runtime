import { spawn } from "node:child_process";
import path from "node:path";
import { findSkippableSteps as findSkippableStepsNode, type EdgeBearingStep, type PredFacts } from "./control-flow/edge-condition.js";
import { buildPredFactsMap, findRunnableSteps as findRunnableStepsNode } from "./dag-readiness-facts.js";
import type { WorkflowStep } from "./dag-engine.js";
import { validateDag as validateDagNode } from "./dag-validation.js";
import type { DagValidationResult } from "./types.js";
import { renderWorkflowToolStepArgsWithResolvedValues } from "./tool-step-template-render.js";

/**
 * [목적] Rust workflow-core bin(paperclip-workflow-core) stdin-JSON 브리지 + Node TS fallback.
 *   run-log-rust-client.ts 와 같은 계약: spawn → stdout JSON, stderr 는 tail 캡.
 *   Rust 경로는 가용성 우선 — helper 부재/계약 위반 시 기존 TS 구현으로 조용히 되돌아간다.
 * [주의] 이 파일은 순수 서브프로세스 브리지다 — zod/drizzle import 금지(계획 §4).
 *   시맨틱 에러(예: unresolved childInputs)는 TS 도 같은 판정을 내리므로 절대 fallback 하지 않고
 *   그대로 던진다(fallback 이 판정을 흡수하면 결과가 Rust/Node 어느 쪽인지 증명할 수 없다).
 * [수정시 영향] W1~W3 호출처(engine/create-definition, run-sync/conditional-skip, tool dispatch)가
 *   이 래퍼를 소비한다. 응답 shape 검증을 느슨히 하면 parity 를 깨뜨린 채 fallback 없이 흐른다.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * PAPERCLIP_WORKFLOW_CORE_BIN 해석 — 절대경로만 허용, NUL 거부, 빈 값은 null(=fallback 만 사용).
 * 인자를 받는 이유: process.env 값은 NUL 을 운반하지 못해(Node 가 C 문자열로 잘라 저장) \0 거부
 * 분기를 env stub 만으로 검증할 수 없기 때문이다. 무인자 호출이 프로덕션 경로다.
 */
export function resolveWorkflowCoreBin(
  configured: string | undefined = process.env.PAPERCLIP_WORKFLOW_CORE_BIN,
): string | null {
  const trimmed = configured?.trim() ?? "";
  if (!trimmed || !path.isAbsolute(trimmed) || trimmed.includes("\0")) return null;
  return trimmed;
}

/** helper 를 신뢰할 수 없다(부재/스폰 실패/비정상 종료/타임아웃) — 호출자는 TS 로 되돌아간다. */
export class WorkflowCoreUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkflowCoreUnavailableError";
  }
}

/** helper 가 계약을 어겼다(비JSON 출력·shape 불일치) — fallback 대상. 시맨틱 에러와 구분된다. */
export class WorkflowCoreContractError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkflowCoreContractError";
  }
}

/** Rust helper 1회 스폰 실행 — 게이트(bin + WORKFLOW_CORE_RUST!=='0'})이 닫히면 Unavailable 로 거절. */
export function runWorkflowCoreSubcommand<T = unknown>(
  subcommand: string,
  payload: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const bin = resolveWorkflowCoreBin();
  if (bin === null || process.env.WORKFLOW_CORE_RUST === "0") {
    return Promise.reject(new WorkflowCoreUnavailableError("workflow_core_disabled"));
  }
  return new Promise<T>((resolve, reject) => {
    const child = spawn(bin, [subcommand], { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (error: WorkflowCoreUnavailableError | WorkflowCoreContractError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };

    timer = setTimeout(() => fail(new WorkflowCoreUnavailableError("workflow_core_timeout")), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail(new WorkflowCoreContractError("workflow_core_stdout_overflow"));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (err: NodeJS.ErrnoException) =>
      fail(new WorkflowCoreUnavailableError(`workflow_core_spawn_${err.code ?? "error"}`)));
    child.stdin.on("error", () => fail(new WorkflowCoreUnavailableError("workflow_core_stdin_error")));
    child.stdout.on("error", () => fail(new WorkflowCoreUnavailableError("workflow_core_stdout_error")));
    child.stderr.on("error", () => fail(new WorkflowCoreUnavailableError("workflow_core_stderr_error")));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new WorkflowCoreUnavailableError(
          `workflow_core_exit_${code ?? "signal"}${stderrTail ? `: ${stderrTail}` : ""}`,
        ));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8")) as T);
      } catch {
        reject(new WorkflowCoreContractError("workflow_core_bad_json"));
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

/** Rust 경로 활성 조건 — 게이트가 의도적으로 닫혀 있으면 fallback 은 '실패'가 아니므로 warn 하지 않는다. */
function workflowCoreRustEnabled(): boolean {
  return process.env.WORKFLOW_CORE_RUST !== "0" && resolveWorkflowCoreBin() !== null;
}

/** 프로세스당 1회 fallback 경고 — 스폰 실패가 매 패스마다 로그를 도배하지 않게 한다. */
const fallbackWarnedKeys = new Set<string>();

function warnFallbackOnce(subcommand: string, reason: string): void {
  const key = `${subcommand}:${reason}`;
  if (fallbackWarnedKeys.has(key)) return;
  fallbackWarnedKeys.add(key);
  console.warn(`[workflow-core] Rust helper fallback to Node (${subcommand}): ${reason}`);
}

/** 테스트 전용 — warn-once 상태는 프로세스 전역이라 케이스 간 오염을 막는다. */
export function resetWorkflowCoreFallbackWarningsForTests(): void {
  fallbackWarnedKeys.clear();
}

/**
 * [목적] Rust 우선 · Node fallback 공통 실행기. 게이트 폐쇄 → 조용한 TS 직행.
 *   payload 를 lazy 로 받는 이유: Rust 꺼짐 시 stepRun 직렬화 등 불필요한 비용을 덜기 위해서다.
 *   interpret 가 WorkflowCoreContractError 를 던지면(응답 shape 불일치) fallback 한다.
 *   그 외 에러(시맨틱)는 재발사 없이 그대로 전파한다.
 */
async function runWithNodeFallback<T>(input: {
  subcommand: string;
  payload: () => unknown;
  fallback: () => T | Promise<T>;
  interpret: (response: unknown) => T;
  timeoutMs?: number;
}): Promise<T> {
  if (!workflowCoreRustEnabled()) return await input.fallback();
  let response: unknown;
  try {
    response = await runWorkflowCoreSubcommand(input.subcommand, input.payload(), input.timeoutMs);
  } catch (err) {
    if (err instanceof WorkflowCoreUnavailableError || err instanceof WorkflowCoreContractError) {
      warnFallbackOnce(input.subcommand, err.message);
      return await input.fallback();
    }
    throw err;
  }
  try {
    return input.interpret(response);
  } catch (err) {
    if (err instanceof WorkflowCoreContractError) {
      warnFallbackOnce(input.subcommand, err.message);
      return await input.fallback();
    }
    throw err;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** `{stepIds:[…]}` 응답을 입력 순서 그대로 step 객체로 되돌린다 — 모르는 id 는 계약 위반. */
function stepsByIdResponse<T extends { id: string }>(steps: ReadonlyArray<T>, raw: unknown, reason: string): T[] {
  if (!isStringArray(raw)) throw new WorkflowCoreContractError(`${reason}_bad_shape`);
  const byId = new Map(steps.map((step) => [step.id, step]));
  return raw.map((id) => {
    const step = byId.get(id);
    if (!step) throw new WorkflowCoreContractError(`${reason}_unknown_step`);
    return step;
  });
}

/** db 타입 직접 import 없이(design 계약) findRunnableSteps 의 stepRunMap 타입을 그대로 재사용한다. */
export type WorkflowStepRunMap = Parameters<typeof findRunnableStepsNode>[1];
export type RenderWorkflowToolArgsInput = Parameters<typeof renderWorkflowToolStepArgsWithResolvedValues>[0];

export function validateDagWithNodeFallback(steps: WorkflowStep[]): Promise<DagValidationResult> {
  return runWithNodeFallback({
    subcommand: "validate-dag",
    payload: () => ({ steps }),
    fallback: () => validateDagNode(steps),
    interpret: (response) => {
      const r = response as { valid?: unknown; errors?: unknown; warnings?: unknown };
      if (!r || typeof r !== "object" || typeof r.valid !== "boolean"
        || !isStringArray(r.errors) || !isStringArray(r.warnings)) {
        throw new WorkflowCoreContractError("workflow_core_validate_dag_bad_shape");
      }
      return { valid: r.valid, errors: r.errors, warnings: r.warnings };
    },
  });
}

export async function findRunnableStepsWithNodeFallback(
  steps: WorkflowStep[],
  stepRunMap: WorkflowStepRunMap,
  options: Parameters<typeof findRunnableStepsNode>[2] = {},
): Promise<WorkflowStep[]> {
  return runWithNodeFallback({
    subcommand: "runnable-steps",
    payload: () => ({
      steps,
      preds: Object.fromEntries(
        buildPredFactsMap(steps, stepRunMap, options.validationVerdictsByIssueId, options.v1EnforcementEnabled, options.issueStatusByIssueId),
      ),
      stepRuns: Object.fromEntries(stepRunMap),
      options: {
        launchedStepIds: options.launchedStepIds ? [...options.launchedStepIds] : undefined,
        nowIso: new Date().toISOString(),
      },
    }),
    fallback: () => findRunnableStepsNode(steps, stepRunMap, options),
    interpret: (response) =>
      stepsByIdResponse(steps, (response as { stepIds?: unknown }).stepIds, "workflow_core_runnable_steps"),
  });
}

export async function findSkippableStepsWithNodeFallback<T extends EdgeBearingStep>(
  steps: ReadonlyArray<T>,
  predsByStepId: ReadonlyMap<string, PredFacts>,
  options: { launchedStepIds?: Set<string>; eligibleStepIds?: Set<string> } = {},
): Promise<T[]> {
  const eligible = options.eligibleStepIds;
  return runWithNodeFallback({
    subcommand: "skippable-steps",
    payload: () => ({
      steps,
      preds: Object.fromEntries(predsByStepId),
      options: {
        launchedStepIds: options.launchedStepIds ? [...options.launchedStepIds] : undefined,
        eligibleStepIds: eligible ? [...eligible] : undefined,
      },
    }),
    fallback: () => findSkippableStepsNode(steps, predsByStepId, {
      launchedStepIds: options.launchedStepIds,
      isStepEligible: eligible ? (step) => eligible.has(step.id) : undefined,
    }),
    interpret: (response) =>
      stepsByIdResponse(steps, (response as { stepIds?: unknown }).stepIds, "workflow_core_skippable_steps"),
  });
}

export function renderToolArgsWithNodeFallback(input: RenderWorkflowToolArgsInput): Promise<unknown> {
  return runWithNodeFallback({
    subcommand: "render-tool-args",
    payload: () => ({
      args: input.args,
      runDate: input.runDate,
      runId: input.runId,
      pathsByStepId: Object.fromEntries(input.pathsByStepId),
      runMetadata: input.runMetadata,
      separator: path.sep, // F5 — Rust 가 path.join/dirname 을 Node 와 같게 계산하도록 플랫폼 구분자 전달
    }),
    fallback: () => renderWorkflowToolStepArgsWithResolvedValues(input),
    interpret: (response) => {
      const r = response as { args?: unknown; error?: { code?: unknown; token?: unknown; message?: unknown } };
      if (r && typeof r === "object" && r.error && typeof r.error === "object" && typeof r.error.code === "string") {
        if (r.error.code === "unresolved_child_inputs" && typeof r.error.token === "string") {
          // TS 렌더러의 throw 문장과 byte-identical — 호출자가 어느 팔에서 왔는지 구분 못 하는 게 정상.
          throw new Error(
            `Unresolved {$childInputs} token in tool args: ${r.error.token}`
            + " (child input keys must be declared on the parent workflow step inputs)",
          );
        }
        throw new Error(typeof r.error.message === "string" ? r.error.message : `workflow_core_error_${r.error.code}`);
      }
      if (!r || typeof r !== "object" || !("args" in r)) {
        throw new WorkflowCoreContractError("workflow_core_render_tool_args_bad_shape");
      }
      return r.args;
    },
  });
}
