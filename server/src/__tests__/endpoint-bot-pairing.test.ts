import { createHash, timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEndpointBotPairingService, createMemoryEndpointBotPairingStore } from "../services/endpoint-bot-pairing.js";

vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const folders = [{ path: "/work", mode: "rw" as const }, { path: "/work/private", mode: "ro" as const }];
const identity = { companyId: "company-a", botName: "My laptop", requestedFolders: folders, nowMs: 1_000 };
const platform = { os: "linux", arch: "arm64", detectedClis: ["codex"], nowMs: 1_001 };
function setup() {
  const store = createMemoryEndpointBotPairingStore();
  const service = createEndpointBotPairingService(store);
  const pair = service.issuePairingCode(identity);
  const device = service.completePairing({ ...platform, code: pair.code });
  const scope = { companyId: device.companyId, deviceId: device.deviceId };
  return { store, service, pair, device, scope };
}

describe("personal endpoint pairing and local task dispatch", () => {
  beforeEach(() => { vi.mocked(timingSafeEqual).mockClear(); });

  it("issues distinct six-character unambiguous codes with ten-minute expiry", () => {
    const service = createEndpointBotPairingService();
    const codes = Array.from({ length: 50 }, () => service.issuePairingCode(identity));
    expect(new Set(codes.map((p) => p.code)).size).toBe(50);
    for (const pair of codes) {
      expect(pair.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
      expect(pair.expiresAtMs).toBe(601_000);
    }
  });

  it("consumes a code exactly once and rejects unknown codes", () => {
    const { service, pair } = setup();
    expect(() => service.completePairing({ ...platform, code: pair.code })).toThrow(/pairing code/i);
    expect(() => service.completePairing({ ...platform, code: "!!!!!!" })).toThrow(/pairing code/i);
  });

  it("rejects a code at its exact expiry", () => {
    const service = createEndpointBotPairingService();
    const pair = service.issuePairingCode({ ...identity, ttlMs: 20 });
    expect(() => service.completePairing({ ...platform, code: pair.code, nowMs: 1_020 })).toThrow(/pairing code/i);
    expect(service.listEndpoints(identity.companyId)).toEqual([]);
  });

  it("stores only a token hash and exposes no credential in endpoint responses", () => {
    const { store, service, device, scope } = setup();
    expect(store.getEndpoint(scope.companyId, scope.deviceId)?.tokenHash)
      .toBe(createHash("sha256").update(device.deviceToken).digest("hex"));
    const saved = store.getEndpoint(scope.companyId, scope.deviceId)!;
    expect(JSON.stringify(saved)).not.toContain(device.deviceToken);
    const heartbeat = service.recordHeartbeat({ ...scope, detectedClis: [], pendingOutboxCount: 0 });
    for (const response of [heartbeat, ...service.listEndpoints(scope.companyId)]) {
      expect(response).not.toHaveProperty("tokenHash");
      expect(response).not.toHaveProperty("deviceToken");
      expect(JSON.stringify(response)).not.toContain(device.deviceToken);
    }
    expect(device.tokenPreview.length).toBeLessThan(device.deviceToken.length);
  });

  it("compares fixed-length hashes with timingSafeEqual for correct, bad and absent credentials", () => {
    const { service, device, scope } = setup();
    expect(service.verifyDeviceToken({ ...scope, token: device.deviceToken })).toBe(true);
    expect(service.verifyDeviceToken({ ...scope, token: "x" })).toBe(false);
    expect(service.verifyDeviceToken({ ...scope, token: "" })).toBe(false);
    expect(service.verifyDeviceToken({ ...scope, companyId: "other", token: device.deviceToken })).toBe(false);
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalledTimes(4);
    for (const [left, right] of vi.mocked(timingSafeEqual).mock.calls) {
      expect(left.byteLength).toBe(32);
      expect(right.byteLength).toBe(32);
    }
  });

  it("shares registrations through an injected store", () => {
    const { store, device, scope } = setup();
    const other = createEndpointBotPairingService(store);
    expect(other.verifyDeviceToken({ ...scope, token: device.deviceToken })).toBe(true);
    expect(createEndpointBotPairingService().listEndpoints(scope.companyId)).toEqual([]);
  });

  it("updates heartbeat inventory and turns stale after sixty seconds", () => {
    const { service, scope } = setup();
    service.recordHeartbeat({ ...scope, detectedClis: ["claude"], pendingOutboxCount: 3, nowMs: 2_000 });
    expect(service.listEndpoints(scope.companyId, 62_000)[0]).toMatchObject({ online: true, detectedClis: ["claude"], pendingOutboxCount: 3 });
    expect(service.listEndpoints(scope.companyId, 62_001)[0]?.online).toBe(false);
    expect(service.listEndpoints("other", 2_000)).toEqual([]);
  });

  it("allows reads and directory listings in read-only folders", () => {
    const { service, scope } = setup();
    for (const kind of ["read_file", "list_dir"] as const) {
      expect(service.enqueueLocalTask({ ...scope, kind, targetPath: "/work/private/file" }).status).toBe("pending");
    }
  });

  it("allows writes and shell tasks only in writable folders", () => {
    const { service, scope } = setup();
    for (const kind of ["write_file", "shell_exec"] as const) {
      expect(service.enqueueLocalTask({ ...scope, kind, targetPath: "/work/file", command: "pwd" }).kind).toBe(kind);
      expect(() => service.enqueueLocalTask({ ...scope, kind, targetPath: "/work/private/file", command: "pwd" })).toThrow(/folder/i);
    }
  });

  it.each(["/work/../secret", "/work/private/../file", "/work/..\\secret", "/work-other/file", "relative/file", "/work/file\0"])("rejects unsafe target %j", (targetPath) => {
    const { service, scope } = setup();
    expect(() => service.enqueueLocalTask({ ...scope, kind: "read_file", targetPath })).toThrow(/path|folder/i);
    expect(service.pollPendingTasks(scope)).toEqual([]);
  });

  it("handles Windows paths independently of the server OS", () => {
    const service = createEndpointBotPairingService();
    const pair = service.issuePairingCode({ ...identity, requestedFolders: [{ path: "C:\\Work", mode: "rw" }] });
    const device = service.completePairing({ ...platform, os: "windows", code: pair.code });
    const scope = { companyId: device.companyId, deviceId: device.deviceId };
    expect(service.enqueueLocalTask({ ...scope, kind: "read_file", targetPath: "c:/WORK/file" }).status).toBe("pending");
    for (const targetPath of ["C:\\Work\\..\\secret", "C:\\Work-other\\file", "C:\\Work\\file:stream"]) {
      expect(() => service.enqueueLocalTask({ ...scope, kind: "read_file", targetPath })).toThrow();
    }
  });

  it("polls FIFO with a limit, retries pending delivery, and acknowledges results once", () => {
    const { service, scope } = setup();
    const first = service.enqueueLocalTask({ ...scope, kind: "read_file", targetPath: "/work/a", nowMs: 3_000 });
    const second = service.enqueueLocalTask({ ...scope, kind: "list_dir", targetPath: "/work", nowMs: 3_001 });
    expect(service.pollPendingTasks({ ...scope, limit: 1 }).map((t) => t.taskId)).toEqual([first.taskId]);
    expect(service.pollPendingTasks({ ...scope, limit: 1 })[0]?.taskId).toBe(first.taskId);
    const ack = { ...scope, taskId: first.taskId, ok: true, output: "contents", nowMs: 4_000 };
    expect(service.ackTaskResult(ack)).toMatchObject({ status: "completed", output: "contents", completedAtMs: 4_000 });
    expect(service.ackTaskResult({ ...ack, ok: false, output: "changed" }).output).toBe("contents");
    expect(service.pollPendingTasks(scope).map((t) => t.taskId)).toEqual([second.taskId]);
    expect(service.ackTaskResult({ ...scope, taskId: second.taskId, ok: false, error: "denied" })).toMatchObject({ status: "failed", error: "denied" });
    expect(service.pollPendingTasks(scope)).toEqual([]);
  });

  it("rejects unknown or cross-company/device operations", () => {
    const { service, scope } = setup();
    const task = service.enqueueLocalTask({ ...scope, kind: "read_file", targetPath: "/work/a" });
    const pair = service.issuePairingCode(identity);
    const other = service.completePairing({ ...platform, code: pair.code });
    for (const wrong of [{ ...scope, companyId: "other" }, { ...scope, deviceId: "missing" }]) {
      expect(() => service.recordHeartbeat({ ...wrong, detectedClis: [], pendingOutboxCount: 0 })).toThrow();
      expect(() => service.pollPendingTasks(wrong)).toThrow();
      expect(() => service.enqueueLocalTask({ ...wrong, kind: "read_file", targetPath: "/work/a" })).toThrow();
      expect(() => service.ackTaskResult({ ...wrong, taskId: task.taskId, ok: true })).toThrow();
    }
    expect(() => service.ackTaskResult({ ...scope, deviceId: other.deviceId, taskId: task.taskId, ok: true })).toThrow();
    expect(() => service.ackTaskResult({ ...scope, taskId: "missing", ok: true })).toThrow();
  });

  it("defends paired grants, inventory and tasks against reference mutation", () => {
    const { service, scope } = setup();
    const endpoint = service.listEndpoints(scope.companyId)[0]!;
    endpoint.allowedFolders[1]!.mode = "rw";
    endpoint.detectedClis.push("changed");
    expect(() => service.enqueueLocalTask({ ...scope, kind: "write_file", targetPath: "/work/private/a" })).toThrow();
    const args = ["a"];
    const task = service.enqueueLocalTask({ ...scope, kind: "shell_exec", targetPath: "/work", command: "echo", args });
    args.push("changed"); task.args!.push("changed");
    expect(service.pollPendingTasks(scope)[0]?.args).toEqual(["a"]);
  });

  it("fails closed on malformed policy and task inputs", () => {
    const { service, scope } = setup();
    for (const ttlMs of [0, -1, NaN, Infinity]) expect(() => service.issuePairingCode({ ...identity, ttlMs })).toThrow();
    expect(() => service.issuePairingCode({ ...identity, requestedFolders: [{ path: "/work/../secret", mode: "rw" }] })).toThrow();
    expect(() => service.issuePairingCode({ ...identity, requestedFolders: [{ path: "/work", mode: "bad" as "rw" }] })).toThrow();
    expect(() => service.enqueueLocalTask({ ...scope, kind: "bad" as "read_file", targetPath: "/work" })).toThrow();
    expect(() => service.enqueueLocalTask({ ...scope, kind: "shell_exec", targetPath: "/work" })).toThrow();
    for (const limit of [0, -1, NaN, 1.5]) expect(() => service.pollPendingTasks({ ...scope, limit })).toThrow();
    expect(() => service.recordHeartbeat({ ...scope, detectedClis: [], pendingOutboxCount: -1 })).toThrow();
  });
});
