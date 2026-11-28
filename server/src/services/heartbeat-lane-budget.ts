export type DispatchLane = "interactive" | "recovery" | "workflow" | "scheduled";

export interface LaneBudgetInput {
  maxSlots: number;
  runningByLane: Partial<Record<DispatchLane, number>>;
  reserveInteractiveHeadroom?: boolean;
}

export interface LaneBudgetResult {
  totalSlots: number;
  totalRunning: number;
  freeSlots: number;
  reservedHeadroom: number;
  maxAdmittableByLane: Record<DispatchLane, number>;
}

const DISPATCH_LANES = ["interactive", "recovery", "workflow", "scheduled"] as const;

function nonNegativeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function computeLaneSlotBudget(input: LaneBudgetInput): LaneBudgetResult {
  const totalSlots = Math.max(1, Math.floor(input.maxSlots || 1));
  const totalRunning = DISPATCH_LANES.reduce(
    (sum, lane) => sum + nonNegativeCount(input.runningByLane[lane]),
    0,
  );
  const freeSlots = Math.max(0, totalSlots - totalRunning);
  const shouldReserveHeadroom =
    (input.reserveInteractiveHeadroom ?? true) &&
    totalSlots >= 3 &&
    (input.runningByLane.interactive ?? 0) === 0;
  const reservedHeadroom = shouldReserveHeadroom ? Math.min(1, freeSlots) : 0;
  const backgroundAdmittable = Math.max(0, freeSlots - reservedHeadroom);

  return {
    totalSlots,
    totalRunning,
    freeSlots,
    reservedHeadroom,
    maxAdmittableByLane: {
      interactive: freeSlots,
      recovery: freeSlots,
      workflow: backgroundAdmittable,
      scheduled: backgroundAdmittable,
    },
  };
}
