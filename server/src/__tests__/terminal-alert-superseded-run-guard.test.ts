import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { isWorkflowRunSupersededByNewerActiveRun } from "../services/missions/terminal-mission-human-operator-alert.js";

const input = {
  companyId: "company-1",
  missionId: "mission-1",
  workflowRunId: "run-old",
};

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => rows),
      })),
    })),
  };
}

function mockDb(selectResults: unknown[][]) {
  const select = vi.fn();
  for (const rows of selectResults) {
    select.mockImplementationOnce(() => selectChain(rows));
  }
  return { db: { select } as unknown as Db, select };
}

describe("isWorkflowRunSupersededByNewerActiveRun", () => {
  it.each(["running", "queued"])("returns true when a newer %s run exists for the mission", async (status) => {
    const createdAt = new Date("2026-11-28T00:00:00.000Z");
    const { db } = mockDb([
      [{ createdAt }],
      [{ id: "run-newer", status }],
    ]);

    await expect(isWorkflowRunSupersededByNewerActiveRun(db, input)).resolves.toBe(true);
  });

  it("returns false when no newer active run exists", async () => {
    const createdAt = new Date("2026-11-28T00:00:00.000Z");
    const { db, select } = mockDb([
      [{ createdAt }],
      [],
    ]);

    await expect(isWorkflowRunSupersededByNewerActiveRun(db, input)).resolves.toBe(false);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("returns false when the target run row is not found", async () => {
    const { db, select } = mockDb([[]]);

    await expect(isWorkflowRunSupersededByNewerActiveRun(db, input)).resolves.toBe(false);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
