import { randomUUID } from "node:crypto";

/**
 * In-memory open-wait store for `await_event` style agent waits
 * (stage30 W7). An agent registers a wait before yielding; an external event
 * later matches the wait so the caller can resume the agent with its original
 * request context, note, and the matched payload.
 *
 * Statuses are result state: only the explicit transitions below are
 * performed by this store.
 */

export type AgentOpenWaitStatus = "waiting" | "resumed" | "expired" | "cancelled";

export type AgentOpenWait = {
  id: string;
  companyId: string;
  agentId: string;
  eventKey: string;
  note: string;
  requestContext: Record<string, unknown>;
  status: AgentOpenWaitStatus;
  expiresAtMs: number | null;
  matchedPayload: Record<string, unknown> | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type RegisterAgentOpenWaitInput = {
  companyId: string;
  agentId: string;
  eventKey: string;
  note: string;
  requestContext: Record<string, unknown>;
  ttlMs?: number;
  nowMs?: number;
};

export type MatchAgentEventInput = {
  companyId: string;
  eventKey: string;
  payload: Record<string, unknown>;
  nowMs?: number;
};

export type AgentOpenWaitStore = ReturnType<typeof createAgentOpenWaitStore>;

function requireNonEmpty(value: string | undefined, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`agent open wait ${field} is required`);
  }
}

function defaultNowMs(): number {
  return Date.now();
}

export function createAgentOpenWaitStore() {
  const waits = new Map<string, AgentOpenWait>();

  function pruneExpired(nowMs: number): void {
    for (const wait of waits.values()) {
      if (wait.status === "waiting" && wait.expiresAtMs !== null && wait.expiresAtMs <= nowMs) {
        wait.status = "expired";
        wait.updatedAtMs = nowMs;
      }
    }
  }

  return {
    registerWait(input: RegisterAgentOpenWaitInput): AgentOpenWait {
      const nowMs = input.nowMs ?? defaultNowMs();
      requireNonEmpty(input.companyId, "companyId");
      requireNonEmpty(input.agentId, "agentId");
      requireNonEmpty(input.eventKey, "eventKey");

      const wait: AgentOpenWait = {
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        eventKey: input.eventKey,
        note: input.note,
        requestContext: input.requestContext,
        status: "waiting",
        expiresAtMs: typeof input.ttlMs === "number" ? nowMs + input.ttlMs : null,
        matchedPayload: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      waits.set(wait.id, wait);
      return { ...wait };
    },

    matchEvent(input: MatchAgentEventInput): AgentOpenWait[] {
      const nowMs = input.nowMs ?? defaultNowMs();
      requireNonEmpty(input.companyId, "companyId");
      requireNonEmpty(input.eventKey, "eventKey");
      pruneExpired(nowMs);

      const resumed: AgentOpenWait[] = [];
      for (const wait of waits.values()) {
        if (wait.status === "waiting" && wait.companyId === input.companyId && wait.eventKey === input.eventKey) {
          wait.status = "resumed";
          wait.matchedPayload = input.payload;
          wait.updatedAtMs = nowMs;
          resumed.push({ ...wait });
        }
      }
      return resumed;
    },

    cancelWait(companyId: string, waitId: string): boolean {
      const wait = waits.get(waitId);
      if (!wait || wait.companyId !== companyId || wait.status !== "waiting") {
        return false;
      }
      wait.status = "cancelled";
      wait.updatedAtMs = defaultNowMs();
      return true;
    },

    listActiveWaits(companyId: string, agentId?: string, nowMs?: number): AgentOpenWait[] {
      const atMs = nowMs ?? defaultNowMs();
      requireNonEmpty(companyId, "companyId");
      pruneExpired(atMs);

      const active: AgentOpenWait[] = [];
      for (const wait of waits.values()) {
        if (wait.status !== "waiting") continue;
        if (wait.companyId !== companyId) continue;
        if (agentId !== undefined && wait.agentId !== agentId) continue;
        active.push({ ...wait });
      }
      return active;
    },
  };
}

/** Process-wide singleton; use `createAgentOpenWaitStore()` for isolated instances. */
export const globalAgentOpenWaitStore = createAgentOpenWaitStore();
