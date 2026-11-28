export type ConcurrencyAuditEventKind =
  | "slot_admitted"
  | "capacity_deferred"
  | "lease_renewed"
  | "provider_throttled"
  | "issue_serialized"
  | "deadlock_break_recommended";

export interface ConcurrencyAuditEvent {
  id: string;
  timestampIso: string;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  kind: ConcurrencyAuditEventKind;
  slotSnapshot: {
    running: number;
    maxSlots: number;
    queued: number;
  };
  reason: string;
}

const CONCURRENCY_AUDIT_EVENT_KINDS: readonly ConcurrencyAuditEventKind[] = [
  "slot_admitted",
  "capacity_deferred",
  "lease_renewed",
  "provider_throttled",
  "issue_serialized",
  "deadlock_break_recommended",
];

function clampAtLeast(value: number, minimum: number) {
  return Number.isFinite(value) ? Math.max(minimum, value) : minimum;
}

export function buildConcurrencyAuditEvent(
  input: Omit<ConcurrencyAuditEvent, "id" | "timestampIso" | "issueId"> & {
    id?: string;
    now?: Date;
    issueId?: string | null;
  },
): ConcurrencyAuditEvent {
  const timestamp = input.now ?? new Date();
  const timestampMs = Number.isFinite(timestamp.getTime()) ? timestamp.getTime() : 0;
  const explicitId = input.id?.trim();

  return {
    id: explicitId || `caud_${input.kind}_${input.runId}_${timestampMs}`,
    timestampIso: new Date(timestampMs).toISOString(),
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    issueId: input.issueId ?? null,
    kind: input.kind,
    slotSnapshot: {
      running: clampAtLeast(input.slotSnapshot.running, 0),
      maxSlots: clampAtLeast(input.slotSnapshot.maxSlots, 1),
      queued: clampAtLeast(input.slotSnapshot.queued, 0),
    },
    reason: input.reason.trim(),
  };
}

export function summarizeConcurrencyAuditEvents(
  events: readonly ConcurrencyAuditEvent[],
): Record<ConcurrencyAuditEventKind, number> & { total: number } {
  const summary = Object.fromEntries(
    CONCURRENCY_AUDIT_EVENT_KINDS.map((kind) => [kind, 0]),
  ) as Record<ConcurrencyAuditEventKind, number> & { total: number };

  summary.total = 0;
  for (const event of events) {
    summary[event.kind] += 1;
    summary.total += 1;
  }

  return summary;
}
