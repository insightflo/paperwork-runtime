import { expect, it } from "vitest";
import {
  buildConcurrencyAuditEvent,
  summarizeConcurrencyAuditEvents,
  type ConcurrencyAuditEventKind,
} from "../services/heartbeat-concurrency-audit.js";

const baseInput = {
  companyId: "company-1",
  agentId: "agent-1",
  runId: "run-1",
  kind: "slot_admitted" as const,
  slotSnapshot: { running: 1, maxSlots: 2, queued: 3 },
  reason: "slot available",
};

it("builds an event with a deterministic fallback id and normalized timestamp", () => {
  const now = new Date("2026-01-02T03:04:05.006Z");
  const event = buildConcurrencyAuditEvent({
    ...baseInput,
    now,
    issueId: "issue-1",
    reason: "  admitted because a slot opened  ",
  });

  expect(event).toEqual({
    id: `caud_slot_admitted_run-1_${now.getTime()}`,
    timestampIso: now.toISOString(),
    companyId: "company-1",
    agentId: "agent-1",
    runId: "run-1",
    issueId: "issue-1",
    kind: "slot_admitted",
    slotSnapshot: { running: 1, maxSlots: 2, queued: 3 },
    reason: "admitted because a slot opened",
  });
});

it("clamps negative or zero slot snapshot values", () => {
  const event = buildConcurrencyAuditEvent({
    ...baseInput,
    now: new Date("2026-01-02T03:04:05.006Z"),
    slotSnapshot: { running: -2, maxSlots: 0, queued: -4 },
  });

  expect(event.slotSnapshot).toEqual({ running: 0, maxSlots: 1, queued: 0 });
});

it("normalizes omitted and null issue ids to null", () => {
  const now = new Date("2026-01-02T03:04:05.006Z");
  const omitted = buildConcurrencyAuditEvent({ ...baseInput, now });
  const explicitNull = buildConcurrencyAuditEvent({ ...baseInput, now, issueId: null });

  expect(omitted.issueId).toBeNull();
  expect(explicitNull.issueId).toBeNull();
});

it("summarizes counts across all concurrency audit event kinds", () => {
  const kinds: ConcurrencyAuditEventKind[] = [
    "slot_admitted",
    "capacity_deferred",
    "lease_renewed",
    "provider_throttled",
    "issue_serialized",
    "deadlock_break_recommended",
  ];
  const events = [
    ...kinds.map((kind, index) =>
      buildConcurrencyAuditEvent({
        ...baseInput,
        kind,
        runId: `run-${index}`,
        now: new Date("2026-01-02T03:04:05.006Z"),
      }),
    ),
    buildConcurrencyAuditEvent({
      ...baseInput,
      kind: "slot_admitted",
      runId: "run-duplicate",
      now: new Date("2026-01-02T03:04:05.007Z"),
    }),
  ];

  expect(summarizeConcurrencyAuditEvents(events)).toEqual({
    slot_admitted: 2,
    capacity_deferred: 1,
    lease_renewed: 1,
    provider_throttled: 1,
    issue_serialized: 1,
    deadlock_break_recommended: 1,
    total: 7,
  });
});
