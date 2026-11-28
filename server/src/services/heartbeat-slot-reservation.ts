export interface SlotReservationEntry {
  runId: string;
  agentId: string;
  issueId: string | null;
  reservedAtMs: number;
  expiresAtMs: number;
}

type SlotReservationFailure = {
  reserved: false;
  reason: "at_capacity" | "issue_already_reserved" | "run_already_reserved";
};

type SlotReservationResult =
  | { reserved: true; entry: SlotReservationEntry }
  | SlotReservationFailure;

const DEFAULT_TTL_MS = 30_000;

export class AgentSlotReservationTracker {
  private readonly defaultTtlMs: number;
  private readonly reservations = new Map<string, SlotReservationEntry>();

  constructor(opts: { defaultTtlMs?: number } = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  pruneExpired(nowMs: number = Date.now()): number {
    let removed = 0;
    for (const [runId, entry] of this.reservations) {
      if (entry.expiresAtMs <= nowMs) {
        this.reservations.delete(runId);
        removed += 1;
      }
    }
    return removed;
  }

  tryReserve(input: {
    agentId: string;
    runId: string;
    maxSlots: number;
    issueId?: string | null;
    nowMs?: number;
    ttlMs?: number;
  }): SlotReservationResult {
    const nowMs = input.nowMs ?? Date.now();
    this.pruneExpired(nowMs);

    if (this.reservations.has(input.runId)) {
      return { reserved: false, reason: "run_already_reserved" };
    }

    const issueId = input.issueId ?? null;
    if (issueId !== null) {
      for (const entry of this.reservations.values()) {
        if (entry.agentId === input.agentId && entry.issueId === issueId) {
          return { reserved: false, reason: "issue_already_reserved" };
        }
      }
    }

    if (this.activeCount(input.agentId, nowMs) >= Math.max(1, input.maxSlots)) {
      return { reserved: false, reason: "at_capacity" };
    }

    const entry: SlotReservationEntry = {
      runId: input.runId,
      agentId: input.agentId,
      issueId,
      reservedAtMs: nowMs,
      expiresAtMs: nowMs + (input.ttlMs ?? this.defaultTtlMs),
    };
    this.reservations.set(input.runId, entry);
    return { reserved: true, entry };
  }

  release(runId: string): boolean {
    return this.reservations.delete(runId);
  }

  activeCount(agentId: string, nowMs: number = Date.now()): number {
    let count = 0;
    for (const entry of this.reservations.values()) {
      if (entry.agentId === agentId && entry.expiresAtMs > nowMs) {
        count += 1;
      }
    }
    return count;
  }
}
