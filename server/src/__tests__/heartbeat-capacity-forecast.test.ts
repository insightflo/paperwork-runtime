import { describe, expect, it } from "vitest";
import { forecastQueueDrain } from "../services/heartbeat-capacity-forecast.js";

describe("forecastQueueDrain", () => {
  it("returns a zero drain forecast for an empty queue", () => {
    expect(forecastQueueDrain({
      queuedCount: 0,
      runningCount: 3,
      currentSlots: 2,
      avgRunDurationMs: 5_000,
    })).toEqual({
      currentSlots: 2,
      estimatedDrainMs: 0,
      suggestedSlots: 2,
      suggestedDrainMs: 0,
      speedupRatio: 1,
    });
  });

  it("doubling from one slot to two slots halves the drain time", () => {
    expect(forecastQueueDrain({
      queuedCount: 4,
      runningCount: 0,
      currentSlots: 1,
      avgRunDurationMs: 1_000,
    })).toEqual({
      currentSlots: 1,
      estimatedDrainMs: 4_000,
      suggestedSlots: 2,
      suggestedDrainMs: 2_000,
      speedupRatio: 2,
    });
  });

  it("scales a four-slot backlog and caps scaling at maxSlotCap", () => {
    expect(forecastQueueDrain({
      queuedCount: 16,
      runningCount: 0,
      currentSlots: 4,
      avgRunDurationMs: 1_000,
      maxSlotCap: 10,
    })).toEqual({
      currentSlots: 4,
      estimatedDrainMs: 4_000,
      suggestedSlots: 8,
      suggestedDrainMs: 2_000,
      speedupRatio: 2,
    });

    expect(forecastQueueDrain({
      queuedCount: 80,
      runningCount: 0,
      currentSlots: 8,
      avgRunDurationMs: 1_000,
      maxSlotCap: 10,
    })).toEqual({
      currentSlots: 8,
      estimatedDrainMs: 10_000,
      suggestedSlots: 10,
      suggestedDrainMs: 8_000,
      speedupRatio: 1.25,
    });
  });

  it("clamps invalid and negative inputs to their minimums", () => {
    expect(forecastQueueDrain({
      queuedCount: 2,
      runningCount: -4,
      currentSlots: -1,
      avgRunDurationMs: 10,
      maxSlotCap: 0,
    })).toEqual({
      currentSlots: 1,
      estimatedDrainMs: 2_000,
      suggestedSlots: 1,
      suggestedDrainMs: 2_000,
      speedupRatio: 1,
    });

    expect(forecastQueueDrain({
      queuedCount: Number.NaN,
      runningCount: Number.NaN,
      currentSlots: Number.NaN,
      avgRunDurationMs: Number.NaN,
      maxSlotCap: Number.NaN,
    })).toEqual({
      currentSlots: 1,
      estimatedDrainMs: 0,
      suggestedSlots: 1,
      suggestedDrainMs: 0,
      speedupRatio: 1,
    });
  });
});
