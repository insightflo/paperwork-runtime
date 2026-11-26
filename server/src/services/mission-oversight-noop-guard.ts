import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { workflowTransitionEvents, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/** No-progress short-circuit for oversight wake loops.
 * A lane that re-wakes an owner on a time bucket while the supervised state is
 * byte-for-byte unchanged burns runs and tokens without ever escalating. Each
 * wake claim therefore records what it saw (fingerprint) and how many identical
 * wakes came before it; once the chain exceeds the limit the wake is skipped.
 *
 * Contract: the chain is read only from the lane's own durable claims (never
 * process-local state), and any doubt fails OPEN to the pre-existing wake.
 * Unreadable, legacy, malformed or foreign records are not no-progress evidence.
 * A changed fingerprint (different ghost, or the same ghost observed at a new
 * time after recovering) is progress and resets the chain, so a legitimate
 * escalation or an operator-triggered wake is never suppressed.
 */
export const DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_WAKES = 3;
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;

export interface OversightGhostEntity { kind: "heartbeat" | "step"; id: string }
export interface OversightStateFingerprintInput {
  /** Identity of what is currently a ghost; observation time is carried separately. */
  ghostEntities: readonly OversightGhostEntity[];
  reasonCode: string;
  /** Machine timestamp of the stale observation; a recovered-then-stale heartbeat has a new one. */
  oldestRunningHeartbeatAt: string | null;
}
/** A validated prior claim written by this guard. */
export interface PriorOversightWakeClaim { idempotencyKey: string; ghostFingerprint: string; consecutiveNoProgress: number }
export type OversightNoProgressDecision =
  | { shortCircuit: false; consecutiveNoProgress: number }
  | { shortCircuit: true; consecutiveNoProgress: number; reasonCode: "consecutive_no_progress_limit_reached" };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}

/** Deterministic 16-hex digest of the ghost evidence; entity order never matters. */
export function computeOversightStateFingerprint(input: OversightStateFingerprintInput): string {
  const ghostEntities = [...input.ghostEntities].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(canonical({ schemaVersion: 1, ghostEntities,
    reasonCode: input.reasonCode, oldestRunningHeartbeatAt: input.oldestRunningHeartbeatAt }))).digest("hex").slice(0, 16);
}

/** Strict reader for a machine-produced claim payload. Anything else (including a pre-guard claim) yields null. */
export function readPriorOversightWakeClaim(payload: unknown, expectedKind: string): Omit<PriorOversightWakeClaim, "idempotencyKey"> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== expectedKind) return null;
  const { ghostFingerprint, consecutiveNoProgress } = record;
  if (typeof ghostFingerprint !== "string" || !FINGERPRINT_PATTERN.test(ghostFingerprint)) return null;
  if (typeof consecutiveNoProgress !== "number" || !Number.isInteger(consecutiveNoProgress) || consecutiveNoProgress < 1) return null;
  return { ghostFingerprint, consecutiveNoProgress };
}

/** Chain the next wake against the latest prior claim. `prior === null` means "no evidence" and wakes. */
export function decideOversightNoProgressGuard(input: {
  prior: Pick<PriorOversightWakeClaim, "ghostFingerprint" | "consecutiveNoProgress"> | null;
  ghostFingerprint: string;
  maxConsecutiveNoProgressWakes?: number;
}): OversightNoProgressDecision {
  const max = Math.max(1, input.maxConsecutiveNoProgressWakes ?? DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_WAKES);
  const prior = input.prior;
  if (!prior || prior.ghostFingerprint !== input.ghostFingerprint) return { shortCircuit: false, consecutiveNoProgress: 1 };
  const next = prior.consecutiveNoProgress + 1;
  return next > max
    ? { shortCircuit: true, consecutiveNoProgress: prior.consecutiveNoProgress, reasonCode: "consecutive_no_progress_limit_reached" }
    : { shortCircuit: false, consecutiveNoProgress: next };
}

/** Latest durable claim of one lane for one mission, or null when none exists or none is readable.
 * A store failure is logged and returns null: the guard fails open, never closed.
 */
export async function readLatestOversightWakeClaim(db: Db, scope: {
  companyId: string; missionId: string; eventType: string; layer: string;
}): Promise<PriorOversightWakeClaim | null> {
  try {
    const [latest] = await db.select({ idempotencyKey: workflowTransitionEvents.idempotencyKey, payload: workflowTransitionEvents.payload })
      .from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, scope.companyId),
        eq(workflowTransitionEvents.missionId, scope.missionId),
        eq(workflowTransitionEvents.eventType, scope.eventType),
        eq(workflowTransitionEvents.layer, scope.layer),
      )).orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(1);
    if (!latest?.idempotencyKey) return null;
    const claim = readPriorOversightWakeClaim(latest.payload, scope.eventType);
    return claim ? { idempotencyKey: latest.idempotencyKey, ...claim } : null;
  } catch (err) {
    logger.warn({ err, companyId: scope.companyId, missionId: scope.missionId, eventType: scope.eventType },
      "Oversight wake claim read failed; no-progress guard fails open to wake");
    return null;
  }
}
