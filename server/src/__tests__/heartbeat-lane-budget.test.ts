import { describe, expect, it } from "vitest";
import { computeLaneSlotBudget } from "../services/heartbeat-lane-budget.js";

describe("computeLaneSlotBudget", () => {
  it("does not reserve interactive headroom for one- or two-slot agents", () => {
    for (const maxSlots of [1, 2]) {
      expect(computeLaneSlotBudget({ maxSlots, runningByLane: {} })).toEqual({
        totalSlots: maxSlots,
        totalRunning: 0,
        freeSlots: maxSlots,
        reservedHeadroom: 0,
        maxAdmittableByLane: {
          interactive: maxSlots,
          recovery: maxSlots,
          workflow: maxSlots,
          scheduled: maxSlots,
        },
      });
    }
  });

  it("reserves one headroom slot when a multi-slot agent has no interactive run", () => {
    expect(computeLaneSlotBudget({ maxSlots: 4, runningByLane: {} })).toEqual({
      totalSlots: 4,
      totalRunning: 0,
      freeSlots: 4,
      reservedHeadroom: 1,
      maxAdmittableByLane: {
        interactive: 4,
        recovery: 4,
        workflow: 3,
        scheduled: 3,
      },
    });
  });

  it("releases headroom once an interactive run is already using a slot", () => {
    expect(computeLaneSlotBudget({ maxSlots: 4, runningByLane: { interactive: 1 } })).toEqual({
      totalSlots: 4,
      totalRunning: 1,
      freeSlots: 3,
      reservedHeadroom: 0,
      maxAdmittableByLane: {
        interactive: 3,
        recovery: 3,
        workflow: 3,
        scheduled: 3,
      },
    });
  });

  it("honors disabled headroom reservation", () => {
    expect(
      computeLaneSlotBudget({
        maxSlots: 4,
        runningByLane: {},
        reserveInteractiveHeadroom: false,
      }),
    ).toEqual({
      totalSlots: 4,
      totalRunning: 0,
      freeSlots: 4,
      reservedHeadroom: 0,
      maxAdmittableByLane: {
        interactive: 4,
        recovery: 4,
        workflow: 4,
        scheduled: 4,
      },
    });
  });

  it("admits no additional runs when running count exceeds capacity", () => {
    expect(
      computeLaneSlotBudget({
        maxSlots: 2,
        runningByLane: { workflow: 2, scheduled: 1 },
      }),
    ).toEqual({
      totalSlots: 2,
      totalRunning: 3,
      freeSlots: 0,
      reservedHeadroom: 0,
      maxAdmittableByLane: {
        interactive: 0,
        recovery: 0,
        workflow: 0,
        scheduled: 0,
      },
    });
  });
});
