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

  it("deduplicates in-flight compiles and enforces max concurrency of 2", async () => {
    let active = 0;
    let maxActive = 0;
    const resolvers: Array<() => void> = [];
    const compiler = vi.fn(
      () =>
        new Promise((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          resolvers.push(() => {
            active -= 1;
            resolve({ created: true });
          });
        }),
    );

    const p1 = scheduleMissionKbAutoCompileIfCompleted(fakeDb, { companyId: "c1", missionId: "m-q1", status: "completed" }, compiler as never);
    const dup = scheduleMissionKbAutoCompileIfCompleted(fakeDb, { companyId: "c1", missionId: "m-q1", status: "completed" }, compiler as never);
    const p2 = scheduleMissionKbAutoCompileIfCompleted(fakeDb, { companyId: "c1", missionId: "m-q2", status: "completed" }, compiler as never);
    const p3 = scheduleMissionKbAutoCompileIfCompleted(fakeDb, { companyId: "c1", missionId: "m-q3", status: "completed" }, compiler as never);

    expect(dup).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(maxActive).toBe(2);
    expect(compiler).toHaveBeenCalledTimes(2);

    resolvers.shift()?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(compiler).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(2);

    while (resolvers.length > 0) resolvers.shift()?.();
    await Promise.all([p1, p2, p3]);

    // After completion, dedupe key is cleared so re-triggering works
    const pAgain = scheduleMissionKbAutoCompileIfCompleted(fakeDb, { companyId: "c1", missionId: "m-q1", status: "completed" }, vi.fn().mockResolvedValue({ created: false }) as never);
    expect(pAgain).not.toBeNull();
    await pAgain;
  });
});
