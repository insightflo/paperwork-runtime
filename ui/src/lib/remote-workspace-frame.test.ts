import { describe, expect, it } from "vitest";
import {
  deleteRemoteWorkspaceFrames,
  FRAME_MAX_AGE_MS,
  readRemoteWorkspaceFrame,
  saveRemoteWorkspaceFrame,
  type FrameStorage,
} from "./remote-workspace-frame";

function createMemoryStorage(): FrameStorage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
  };
}

describe("remote-workspace-frame", () => {
  it("scrubs message previews/secrets and enforces max 4 recent agents and 30-day TTL", () => {
    const storage = createMemoryStorage();
    const t0 = 1_700_000_000_000;

    saveRemoteWorkspaceFrame(
      "user-1",
      "a1-host",
      {
        selectedCompanyId: "co-1",
        selectedAgentId: "ag-1",
        companies: [{ id: "co-1", name: "Papercompany", secretToken: "leak-me" }],
        agents: [
          {
            id: "ag-1",
            name: "Research Director",
            role: "researcher",
            status: "running",
            preview: "CONFIDENTIAL MESSAGE TEXT",
            apiKey: "sk-secret",
          },
        ],
        unreadCounts: { "ag-1": 3, "ag-2": 0 },
      },
      storage,
      t0,
    );

    const frame = readRemoteWorkspaceFrame("user-1", "a1-host", storage, t0 + 1000);
    expect(frame).not.toBeNull();
    expect(frame?.agents[0]?.preview).toBe("");
    expect(JSON.stringify(frame)).not.toContain("CONFIDENTIAL");
    expect(JSON.stringify(frame)).not.toContain("sk-secret");
    expect(frame?.unreadCounts).toEqual({ "ag-1": 3 });

    for (const id of ["ag-2", "ag-3", "ag-4", "ag-5"]) {
      saveRemoteWorkspaceFrame("user-1", "a1-host", { selectedAgentId: id }, storage, t0 + 2000);
    }
    const afterRecent = readRemoteWorkspaceFrame("user-1", "a1-host", storage, t0 + 3000);
    expect(afterRecent?.recentAgentIds).toEqual(["ag-5", "ag-4", "ag-3", "ag-2"]);

    const expired = readRemoteWorkspaceFrame("user-1", "a1-host", storage, t0 + FRAME_MAX_AGE_MS + 5000);
    expect(expired).toBeNull();
  });

  it("handles corrupt storage JSON safely and removes frames selectively on disconnect", () => {
    const storage = createMemoryStorage();
    storage.setItem("paperclip:remote-frame:v1:u1:s1", "{broken json");
    expect(readRemoteWorkspaceFrame("u1", "s1", storage)).toBeNull();

    saveRemoteWorkspaceFrame("u1", "s1", { agents: [{ id: "a", name: "A" }] }, storage, 100);
    saveRemoteWorkspaceFrame("u1", "s2", { agents: [{ id: "b", name: "B" }] }, storage, 100);
    deleteRemoteWorkspaceFrames("u1", ["s2"], storage);
    expect(readRemoteWorkspaceFrame("u1", "s1", storage, 200)).toBeNull();
    expect(readRemoteWorkspaceFrame("u1", "s2", storage, 200)?.agents[0]?.name).toBe("B");
  });
});
