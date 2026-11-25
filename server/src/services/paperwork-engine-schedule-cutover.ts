// [파일 목적] paperwork-engine schedule.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_ENGINE_SCHEDULE_CUTOVER=1 이면 쓰기(advance_fenced/set_enabled)를
//   Rust RPC 로 먼저 시도한다. 응답이 not_committed 로 분류되면 경고 후 기존 TS
//   작성자로 폴백하고, indeterminate 면 커밋 여부를 알 수 없으므로 절대 TS 폴백을
//   호출하지 않고 ScheduleCutoverIndeterminateError 를 던진다(이중 적용 방지).
//   읽기(list_due)는 부작용이 없어 어떤 오류든 TS 폴백한다. 플래그 OFF·
//   null 클라이언트·엔진 표현 불가 입력은 RPC 없이 곧바로 TS 경로다.
// [외부 연결] paperwork-engine-schedule typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  advanceScheduleFenced, classifyScheduleRpcError, listDueSchedules, setScheduleEnabled,
  type DueSchedule, type ScheduleAdvanceFencedParams, type ScheduleAdvanceFencedResult,
  type ScheduleListDueParams, type ScheduleRpcErrorClassification,
  type ScheduleSetEnabledParams, type ScheduleSetEnabledResult,
} from "./paperwork-engine-schedule.js";

export const SCHEDULE_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const SCHEDULE_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(SCHEDULE_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : SCHEDULE_CUTOVER_READ_TIMEOUT_MS;
}

export type ScheduleCutoverSource = "rust" | "ts";
export interface ScheduleCutoverResult<T> { source: ScheduleCutoverSource; value: T }
export type ScheduleCutoverOperation = "advance_fenced" | "set_enabled";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface ScheduleCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class ScheduleCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: ScheduleCutoverOperation,
    readonly classification: ScheduleRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`schedule cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "ScheduleCutoverIndeterminateError";
  }
}

export function isScheduleEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_ENGINE_SCHEDULE_CUTOVER === "1";
}

// --- engine eligibility (typed client 의 전송 전 검증과 1:1 대응) --------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PG_EPOCH_NS = 946_684_800_000_000_000n; // 2000-01-01T00:00:00Z in Unix ns
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

// isTs·pgMicros 는 paperwork-engine-schedule.ts 의 비공개 검증기와 동일 의미다 —
// typed client 가 전송 전 RangeError 를 던질 입력은 indeterminate 가 아니라
// TS 경로(오늘의 동작)로 라우팅해야 한다.
const isTs = (v: unknown): v is string => {
  if (typeof v !== "string" || !RFC3339_RE.test(v) || Number.isNaN(Date.parse(v))) return false;
  const [hh, mm, ss] = v.slice(11, 19).split(":").map(Number);
  if (hh > 23 || mm > 59 || ss > 59) return false;
  if (!v.endsWith("Z")) {
    const [oh, om] = v.slice(-5).split(":").map(Number);
    if (oh > 23 || om > 59) return false;
  }
  const [y, mo, d] = v.slice(0, 10).split("-").map(Number);
  const dt = new Date(0); dt.setUTCFullYear(y, mo - 1, d);
  return dt.toISOString().slice(0, 10) === v.slice(0, 10);
};

/** schedule.ts checkTs 의 비던지기 판 — Date|string 을 와이어 타임스탬프로 정규화하거나 null. */
function toWireTs(v: unknown): string | null {
  if (v instanceof Date) {
    if (!Number.isNaN(v.getTime())) {
      const iso = v.toISOString();
      if (isTs(iso)) return iso;
    }
  } else if (isTs(v)) {
    return v;
  }
  return null;
}

function pgMicros(rfc3339: string): bigint | null {
  const ms = Date.parse(rfc3339);
  const frac = /\.(\d+)/.exec(rfc3339)?.[1] ?? "";
  const subMsNs = BigInt(frac.slice(3, 9).padEnd(6, "0") || "0");
  const micros = (BigInt(ms) * 1_000_000n + subMsNs - PG_EPOCH_NS) / 1_000n;
  return micros >= I64_MIN && micros <= I64_MAX ? micros : null;
}

/** advance_fenced 의 엔진 표현 가능 여부 — UUID·타임스탬프·advance window·
 *  expected_next_run_at 모두 typed client 의 전송 전 검증과 같은 조건이다. */
function isAdvanceEngineEligible(params: ScheduleAdvanceFencedParams): boolean {
  if (!isUuid(params.schedule_id) || !isUuid(params.company_id)) return false;
  const last = toWireTs(params.last_run_at), next = toWireTs(params.next_run_at);
  if (last === null || next === null) return false;
  const expected = params.expected_next_run_at;
  if (expected !== undefined && expected !== null && toWireTs(expected) === null) return false;
  const l = pgMicros(last), n = pgMicros(next);
  return l !== null && n !== null && n > l;
}

function isSetEnabledEngineEligible(params: ScheduleSetEnabledParams): boolean {
  return isUuid(params.schedule_id) && isUuid(params.company_id) && typeof params.enabled === "boolean";
}

/** 로거 실패가 폴백 결정이나 오류 전파를 막지 않도록 모든 경고는 best-effort. */
function warnBestEffort(obj: Record<string, unknown>, msg: string): void {
  try { logger.warn(obj, msg); } catch { /* 로깅 실패는 컷오버 경로를 절대 차단하지 않는다 */ }
}

async function writeWithCutover<T>(
  operation: ScheduleCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<ScheduleCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyScheduleRpcError(error);
    if (classification.outcome === "not_committed") {
      warnBestEffort({ operation, kind: classification.kind, err: error },
        "paperwork-engine schedule write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new ScheduleCutoverIndeterminateError(operation, classification, error);
  }
}

export async function advanceFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: ScheduleAdvanceFencedParams,
  tsFallback: () => Promise<ScheduleAdvanceFencedResult>,
  opts: ScheduleCutoverCallOpts = {},
): Promise<ScheduleCutoverResult<ScheduleAdvanceFencedResult>> {
  if (client === null || !isScheduleEngineCutoverEnabled(opts.env)
    || !isAdvanceEngineEligible(params)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("advance_fenced",
    () => advanceScheduleFenced(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function setEnabledWithCutover(
  client: PaperworkEngineClient | null,
  params: ScheduleSetEnabledParams,
  tsFallback: () => Promise<ScheduleSetEnabledResult>,
  opts: ScheduleCutoverCallOpts = {},
): Promise<ScheduleCutoverResult<ScheduleSetEnabledResult>> {
  if (client === null || !isScheduleEngineCutoverEnabled(opts.env)
    || !isSetEnabledEngineEligible(params)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("set_enabled",
    () => setScheduleEnabled(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listDueWithCutover(
  client: PaperworkEngineClient | null,
  params: ScheduleListDueParams,
  tsFallback: () => Promise<DueSchedule[]>,
  opts: ScheduleCutoverCallOpts = {},
): Promise<ScheduleCutoverResult<DueSchedule[]>> {
  if (client === null || !isScheduleEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  try {
    return {
      source: "rust",
      value: await listDueSchedules(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    };
  } catch (error) {
    warnBestEffort({ operation: "list_due", err: error },
      "paperwork-engine schedule read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}
