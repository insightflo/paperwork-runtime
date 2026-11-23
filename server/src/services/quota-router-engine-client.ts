// [파일 목적] resident paperwork-engine `quota.route` typed client — Rust quota-router가
//   라우팅 권위, TS는 fail-closed 경계 검증만 담당(spawnSync 없음, resident engine 전용).
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

// Closed verdict vocabulary shared by `tried` entries and the top-level reason.
export const QUOTA_ROUTE_VERDICTS = [
  "unknown_quota", "future_timestamp", "stale", "invalid_remaining_pct",
  "hard_limited", "below_threshold", "eligible", "invalid_threshold",
] as const;
export type QuotaRouteVerdict = (typeof QUOTA_ROUTE_VERDICTS)[number];

export interface QuotaModelRef { provider: string; model: string }
export interface QuotaSnapshotInput {
  provider: string; model: string;
  observed_at_epoch_ms: number; stale_after_ms: number; remaining_pct: number;
  hard_limited?: boolean; resets_at_epoch_ms?: number | null;
}
export interface QuotaRouteRequest {
  primary: QuotaModelRef; backup_order: QuotaModelRef[]; quotas: QuotaSnapshotInput[];
  now_epoch_ms: number; min_remaining_pct: number; allow_unknown_quota?: boolean;
}
export interface QuotaTriedCandidate { provider: string; model: string; reason: QuotaRouteVerdict }
export interface QuotaRouteResult {
  selected: QuotaModelRef | null; reason: QuotaRouteVerdict;
  tried: QuotaTriedCandidate[]; earliest_reset_epoch_ms: number | null;
}
export type QuotaRouteOutcome =
  | { ok: true; result: QuotaRouteResult }
  | { ok: false; kind: "invalid_input" | "engine_unavailable" | "invalid_response" };

export interface QuotaRouteDeps {
  getClient?: () => PaperworkEngineClient | null | Promise<PaperworkEngineClient | null>;
}

const VERDICTS: ReadonlySet<string> = new Set(QUOTA_ROUTE_VERDICTS);
const MAX_NAME_BYTES = 128, MAX_BACKUP_ORDER = 64, MAX_QUOTAS = 256;
const MAX_TRIED = MAX_BACKUP_ORDER + 1; // primary + backup_order
const owns = Object.prototype.hasOwnProperty;
// Function declaration (not an arrow const): only never-returning declarations
// end the control-flow branch so following code is narrowed correctly.
function invalid(): never { throw new Error("quota_route_invalid"); }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
// Node 20+ ships ES2024 String.isWellFormed but the repo's ES2023 lib types lack it.
const wellFormed = (s: string): boolean =>
  (s as string & { isWellFormed(): boolean }).isWellFormed();
function reqName(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !wellFormed(v)
    || Buffer.byteLength(v, "utf8") > MAX_NAME_BYTES) invalid();
  return v;
}
function safeInt(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) invalid();
  return v;
}
function finiteNum(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) invalid();
  return v;
}
function optBool(v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") invalid();
  return v;
}
function optReset(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return safeInt(v);
}
// Reads .length once and each element once; rejects proxies, holes, inherited slots.
function denseCopy(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v)) invalid();
  const len = v.length;
  if (!Number.isInteger(len) || len < 0 || len > max) invalid();
  const out = new Array<unknown>(len);
  for (let i = 0; i < len; i += 1) {
    if (!owns.call(v, i)) invalid();
    out[i] = v[i];
  }
  return out;
}
function modelRef(v: unknown): QuotaModelRef {
  if (!isRecord(v)) invalid();
  return { provider: reqName(v.provider), model: reqName(v.model) };
}
function snapshot(v: unknown): QuotaSnapshotInput {
  if (!isRecord(v)) invalid();
  const hard = optBool(v.hard_limited);
  const reset = optReset(v.resets_at_epoch_ms);
  const out: QuotaSnapshotInput = {
    provider: reqName(v.provider), model: reqName(v.model),
    observed_at_epoch_ms: safeInt(v.observed_at_epoch_ms),
    stale_after_ms: safeInt(v.stale_after_ms),
    remaining_pct: finiteNum(v.remaining_pct),
  };
  if (hard !== undefined) out.hard_limited = hard;
  if (reset !== undefined) out.resets_at_epoch_ms = reset;
  return out;
}
// Single-read validate-and-copy: each property/element is read exactly once into a
// validated local before the first await, so fluctuating getters cannot swap values.
function toRequest(input: unknown): QuotaRouteRequest {
  if (!isRecord(input)) invalid();
  const backup = denseCopy(input.backup_order, MAX_BACKUP_ORDER);
  const quotas = denseCopy(input.quotas, MAX_QUOTAS);
  const allow = optBool(input.allow_unknown_quota);
  const req: QuotaRouteRequest = {
    primary: modelRef(input.primary),
    backup_order: backup.map(modelRef),
    quotas: quotas.map(snapshot),
    now_epoch_ms: safeInt(input.now_epoch_ms),
    // Finite out-of-range values pass through so Rust returns invalid_threshold.
    min_remaining_pct: finiteNum(input.min_remaining_pct),
  };
  if (allow !== undefined) req.allow_unknown_quota = allow;
  return req;
}
function verdict(v: unknown): QuotaRouteVerdict {
  if (typeof v !== "string" || !VERDICTS.has(v)) invalid();
  return v as QuotaRouteVerdict;
}
function triedCandidate(v: unknown): QuotaTriedCandidate {
  if (!isRecord(v)) invalid();
  return { provider: reqName(v.provider), model: reqName(v.model), reason: verdict(v.reason) };
}
// Same single-read discipline on the engine response; returns a fresh plain object.
function toResult(v: unknown): QuotaRouteResult {
  if (!isRecord(v)) invalid();
  const selected = v.selected;
  const reset = v.earliest_reset_epoch_ms;
  return {
    selected: selected === null ? null : modelRef(selected),
    reason: verdict(v.reason),
    tried: denseCopy(v.tried, MAX_TRIED).map(triedCandidate),
    earliest_reset_epoch_ms: reset === null ? null : safeInt(reset),
  };
}

export async function routeQuotaWithEngine(
  input: unknown,
  deps?: QuotaRouteDeps,
): Promise<QuotaRouteOutcome> {
  let req: QuotaRouteRequest;
  try { req = toRequest(input); } catch { return { ok: false, kind: "invalid_input" }; }
  let raw: unknown;
  try {
    const client = await (deps?.getClient ?? getSharedPaperworkEngineClient)();
    if (client === null || client === undefined) invalid();
    raw = await client.call("quota.route", req);
  } catch { return { ok: false, kind: "engine_unavailable" }; }
  try { return { ok: true, result: toResult(raw) }; }
  catch { return { ok: false, kind: "invalid_response" }; }
}
