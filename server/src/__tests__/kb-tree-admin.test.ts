// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { scheduleMissionKbAutoCompileIfCompleted } from "../services/knowledge/kb-tree-admin.js";

describe("scheduleMissionKbAutoCompileIfCompleted", () => {
  const fakeDb = {} as never;

  it("does not invoke compiler when terminal status is cancelled", () => {
    const compiler = vi.fn();
    const res = scheduleMissionKbAutoCompileIfCompleted(
      fakeDb,
      { companyId: "c1", missionId: "m1", status: "cancelled" },
      compiler as never,
    );
    expect(res).toBeNull();
    expect(compiler).not.toHaveBeenCalled();
  });

  it("invokes compiler asynchronously with system actor when terminal status is completed", async () => {
    const compiler = vi.fn().mockResolvedValue({ created: true });
    const p = scheduleMissionKbAutoCompileIfCompleted(
      fakeDb,
      { companyId: "c1", missionId: "m1", status: "completed" },
      compiler as never,
    );
    expect(p).not.toBeNull();
    await p;
    expect(compiler).toHaveBeenCalledTimes(1);
    expect(compiler).toHaveBeenCalledWith(fakeDb, {
      companyId: "c1",
      missionId: "m1",
      actorId: "system:mission-auto-compile",
    });
  });

  it("fails open and swallows compiler rejections without throwing", async () => {
    const compiler = vi.fn().mockRejectedValue(new Error("rust bin crash"));
    const p = scheduleMissionKbAutoCompileIfCompleted(
      fakeDb,
      { companyId: "c1", missionId: "m2", status: "completed" },
      compiler as never,
    );
    await expect(p).resolves.toBeUndefined();
    expect(compiler).toHaveBeenCalledTimes(1);
  });
});
