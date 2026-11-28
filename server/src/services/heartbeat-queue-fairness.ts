export type QueueLane = "interactive" | "recovery" | "workflow" | "scheduled";

export interface QueuedRunCandidate {
  id: string;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
  invocationSource?: string | null;
  triggerDetail?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
  issueId?: string | null;
}

const LANE_WEIGHTS: Record<QueueLane, number> = {
  interactive: 400,
  recovery: 300,
  workflow: 200,
  scheduled: 100,
};

const DEFAULT_AGING_PROMOTION_MS = 180_000;
const INTERACTIVE_TOKENS = ["mention", "comment", "manual", "operator", "chat"] as const;
const RECOVERY_TOKENS = ["unblock", "recovery", "handoff", "qa_retry", "supervision", "retry"] as const;
const WORKFLOW_TOKENS = ["workflow", "mission"] as const;
const MACHINE_SIGNAL_KEYS = new Set([
  "action",
  "eventtype",
  "handoffreason",
  "kind",
  "mode",
  "originkind",
  "reason",
  "recoveryreason",
  "requestkind",
  "retryreason",
  "source",
  "status",
  "triggerdetail",
  "type",
  "wakereason",
  "wakesource",
]);

function normalizedText(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function containsToken(value: string | null | undefined, tokens: readonly string[]) {
  const text = normalizedText(value);
  return text.length > 0 && tokens.some((token) => text.includes(token));
}

function isPresent(value: unknown) {
  return value !== null && value !== undefined && value !== false && value !== 0 && value !== "";
}

function visitContextEntries(
  value: unknown,
  visit: (key: string, value: unknown) => boolean,
) {
  const seen = new WeakSet<object>();
  const walk = (current: unknown, depth: number): boolean => {
    if (depth > 6 || current === null || typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) return current.some((entry) => walk(entry, depth + 1));
    return Object.entries(current as Record<string, unknown>).some(
      ([key, entry]) => visit(key, entry) || walk(entry, depth + 1),
    );
  };
  return walk(value, 0);
}

function machineValueContains(key: string, value: unknown, tokens: readonly string[]) {
  return typeof value === "string"
    && MACHINE_SIGNAL_KEYS.has(key.toLowerCase())
    && containsToken(value, tokens);
}

function contextIndicatesRecovery(contextSnapshot: Record<string, unknown> | null | undefined) {
  return visitContextEntries(contextSnapshot, (key, value) => {
    const normalizedKey = key.toLowerCase();
    if (isPresent(value) && RECOVERY_TOKENS.some((token) => normalizedKey.includes(token))) return true;
    return machineValueContains(key, value, RECOVERY_TOKENS);
  });
}

function contextIndicatesWorkflow(contextSnapshot: Record<string, unknown> | null | undefined) {
  return visitContextEntries(contextSnapshot, (key, value) => {
    const normalizedKey = key.toLowerCase();
    if (machineValueContains(key, value, WORKFLOW_TOKENS)) return true;
    if (!isPresent(value)) return false;
    return normalizedKey.includes("workflow")
      || normalizedKey.includes("mission")
      || normalizedKey === "issueid"
      || normalizedKey === "stepid"
      || normalizedKey === "taskid";
  });
}

export function classifyQueueLane(input: {
  invocationSource?: string | null;
  triggerDetail?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
}): QueueLane {
  const source = normalizedText(input.invocationSource);
  if (source === "on_demand" || source === "manual" || containsToken(input.triggerDetail, INTERACTIVE_TOKENS)) {
    return "interactive";
  }
  if (containsToken(input.triggerDetail, RECOVERY_TOKENS) || contextIndicatesRecovery(input.contextSnapshot)) {
    return "recovery";
  }
  if (source === "assignment"
    || containsToken(input.triggerDetail, WORKFLOW_TOKENS)
    || contextIndicatesWorkflow(input.contextSnapshot)) {
    return "workflow";
  }
  return "scheduled";
}

function createdAtMs(value: Date | string) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function normalizedSlots(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizedAgingPromotionMs(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_AGING_PROMOTION_MS;
  return value;
}

function compareIds(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function laneScore(candidate: QueuedRunCandidate, nowMs: number, agingPromotionMs: number) {
  const lane = classifyQueueLane(candidate);
  const waitMs = Math.max(0, nowMs - createdAtMs(candidate.createdAt));
  return LANE_WEIGHTS[lane] + Math.floor(waitMs / agingPromotionMs) * 100;
}

export function selectNextQueuedRuns<T extends QueuedRunCandidate>(
  candidates: readonly T[],
  opts: {
    availableSlots: number;
    now?: Date;
    agingPromotionMs?: number;
    activeIssueIds?: ReadonlySet<string>;
  },
): T[] {
  const capacity = normalizedSlots(opts.availableSlots);
  if (capacity === 0 || candidates.length === 0) return [];

  const now = opts.now ?? new Date();
  const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : 0;
  const agingPromotionMs = normalizedAgingPromotionMs(opts.agingPromotionMs);
  const ranked = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      createdMs: createdAtMs(candidate.createdAt),
      score: laneScore(candidate, nowMs, agingPromotionMs),
    }))
    .sort((left, right) => right.score - left.score
      || left.createdMs - right.createdMs
      || compareIds(left.candidate.id, right.candidate.id)
      || left.index - right.index);

  const selected: T[] = [];
  const selectedIssueIds = new Set<string>();
  for (const entry of ranked) {
    if (selected.length >= capacity) break;
    const issueId = entry.candidate.issueId;
    if (issueId != null && (opts.activeIssueIds?.has(issueId) || selectedIssueIds.has(issueId))) continue;
    selected.push(entry.candidate);
    if (issueId != null) selectedIssueIds.add(issueId);
  }
  return selected;
}
