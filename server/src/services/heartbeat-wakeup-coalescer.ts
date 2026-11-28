export type CoalesceLane = "interactive" | "recovery" | "workflow" | "scheduled";

export interface WakeupEventInput {
  id: string;
  agentId: string;
  issueId?: string | null;
  lane: CoalesceLane;
  requestedAtMs: number;
  triggerDetail?: string | null;
}

export interface CoalescedWakeup {
  primaryId: string;
  agentId: string;
  issueId: string | null;
  lane: CoalesceLane;
  firstRequestedAtMs: number;
  lastRequestedAtMs: number;
  coalescedCount: number;
  mergedIds: string[];
  latestTriggerDetail: string | null;
}

const DEFAULT_WINDOW_MS = 10_000;

const LANE_PRIORITY: Record<CoalesceLane, number> = {
  interactive: 0,
  recovery: 1,
  workflow: 2,
  scheduled: 3,
};

function compareWakeupEvents(a: WakeupEventInput, b: WakeupEventInput): number {
  if (a.requestedAtMs !== b.requestedAtMs) return a.requestedAtMs - b.requestedAtMs;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function isHigherPriority(candidate: CoalesceLane, current: CoalesceLane): boolean {
  return LANE_PRIORITY[candidate] < LANE_PRIORITY[current];
}

function groupKey(agentId: string, issueId: string | null | undefined): string {
  return JSON.stringify([agentId, issueId ?? "__none__"]);
}

export function coalesceWakeupBurst(
  events: readonly WakeupEventInput[],
  opts?: { windowMs?: number },
): CoalescedWakeup[] {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const sortedEvents = [...events].sort(compareWakeupEvents);
  const coalesced: CoalescedWakeup[] = [];
  const currentByKey = new Map<string, CoalescedWakeup>();

  for (const event of sortedEvents) {
    const issueId = event.issueId ?? null;
    const key = groupKey(event.agentId, event.issueId);
    const current = currentByKey.get(key);
    const canMerge =
      current !== undefined &&
      event.requestedAtMs - current.lastRequestedAtMs <= windowMs;

    if (!current || !canMerge) {
      const next: CoalescedWakeup = {
        primaryId: event.id,
        agentId: event.agentId,
        issueId,
        lane: event.lane,
        firstRequestedAtMs: event.requestedAtMs,
        lastRequestedAtMs: event.requestedAtMs,
        coalescedCount: 1,
        mergedIds: [event.id],
        latestTriggerDetail: event.triggerDetail ?? null,
      };
      currentByKey.set(key, next);
      coalesced.push(next);
      continue;
    }

    if (isHigherPriority(event.lane, current.lane)) {
      current.lane = event.lane;
    }
    current.lastRequestedAtMs = event.requestedAtMs;
    if (event.triggerDetail != null) {
      current.latestTriggerDetail = event.triggerDetail;
    }
    current.coalescedCount += 1;
    current.mergedIds.push(event.id);
  }

  return coalesced;
}
