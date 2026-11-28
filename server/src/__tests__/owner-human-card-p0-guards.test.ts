import { describe, expect, it } from "vitest";
import {
  findActiveMissionReworkStep,
  findNewerActiveWorkflowRun,
  hasConcreteHumanCardContent,
} from "../services/missions/owner-human-card-admission-guards.js";

function makeSelectDb(responses: unknown[][]) {
  let index = 0;
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => responses[index++] ?? [],
          }),
        }),
        where: () => ({
          limit: async () => responses[index++] ?? [],
        }),
      }),
    }),
  } as unknown as Parameters<typeof findActiveMissionReworkStep>[0];
}

describe("owner-human-card-admission-guards", () => {
  it("rejects blank reason/nextAction and accepts non-empty text", () => {
    expect(hasConcreteHumanCardContent({})).toBe(false);
    expect(hasConcreteHumanCardContent({ reason: "   ", nextAction: "" })).toBe(false);
    expect(hasConcreteHumanCardContent({ reason: "A" })).toBe(true);
    expect(hasConcreteHumanCardContent({ reason: "API 키 승인이 필요합니다" })).toBe(true);
    expect(hasConcreteHumanCardContent({ nextAction: "외부 계정 권한 확인" })).toBe(true);
  });

  it("detects actively running rework steps in a mission", async () => {
    const activeDb = makeSelectDb([[{ workflowRunId: "run-1", stepRunId: "step-5", stepId: "action-5" }]]);
    await expect(findActiveMissionReworkStep(activeDb, "comp-1", "mis-1")).resolves.toEqual({
      workflowRunId: "run-1",
      stepRunId: "step-5",
      stepId: "action-5",
    });

    const idleDb = makeSelectDb([[]]);
    await expect(findActiveMissionReworkStep(idleDb, "comp-1", "mis-1")).resolves.toBeNull();
  });

  it("detects when an old workflow run is superseded by a newer active run", async () => {
    const supersededDb = makeSelectDb([
      [{ id: "old-run", createdAt: new Date("2026-11-28T13:00:00Z") }],
      [{ id: "new-run", status: "running" }],
    ]);
    await expect(findNewerActiveWorkflowRun(supersededDb, "comp-1", "mis-1", "old-run")).resolves.toEqual({
      newerWorkflowRunId: "new-run",
      status: "running",
    });

    const latestDb = makeSelectDb([
      [{ id: "new-run", createdAt: new Date("2026-11-28T13:41:00Z") }],
      [],
    ]);
    await expect(findNewerActiveWorkflowRun(latestDb, "comp-1", "mis-1", "new-run")).resolves.toBeNull();

    const missingDb = makeSelectDb([[]]);
    await expect(findNewerActiveWorkflowRun(missingDb, "comp-1", "mis-1", "missing")).resolves.toBeNull();
  });
});
