import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { hasNewerActiveMissionWorkflowRun } from "../services/missions/mission-owner-dead-target-loop.js";

function mockDb(rowsBySelect: unknown[][]) {
  let selectIndex = 0;
  const select = vi.fn(() => {
    const rows = rowsBySelect[selectIndex++] ?? [];
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows),
        })),
      })),
    };
  });
  return { db: { select } as unknown as Db, select };
}

const input = {
  companyId: "company-1",
  missionId: "mission-1",
  workflowRunId: "run-old",
};
const targetRow = [{ createdAt: new Date("2026-11-28T00:00:00.000Z") }];

describe("hasNewerActiveMissionWorkflowRun", () => {
  it("returns true when another active running run exists at or after the target", async () => {
    const { db, select } = mockDb([targetRow, [{ id: "run-new" }]]);

    await expect(hasNewerActiveMissionWorkflowRun(db, input)).resolves.toBe(true);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("returns false when no newer active run exists", async () => {
    const { db, select } = mockDb([targetRow, []]);

    await expect(hasNewerActiveMissionWorkflowRun(db, input)).resolves.toBe(false);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("returns false without probing active runs when the target run is missing", async () => {
    const { db, select } = mockDb([[]]);

    await expect(hasNewerActiveMissionWorkflowRun(db, input)).resolves.toBe(false);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
