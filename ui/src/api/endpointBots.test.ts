// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointBotsApi } from "./endpointBots";
import type {
  EndpointAuditResponse,
  EndpointBotRecord,
  EnqueueLocalTaskInput,
  IssuePairingCodeInput,
  LocalTaskRecord,
  PairingCodeResponse,
} from "./endpointBots";

type FetchMock = ReturnType<typeof vi.fn>;

function mockResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload),
  } as unknown as Response;
}

function setFetchMock(impl: FetchMock) {
  Object.defineProperty(globalThis, "fetch", {
    value: impl,
    configurable: true,
  });
}

const botRecord: EndpointBotRecord = {
  companyId: "company-1",
  deviceId: "device-1",
  botName: "warehouse-bot",
  os: "darwin",
  arch: "arm64",
  detectedClis: [{ id: "pi", binary: "pi", path: "/usr/local/bin/pi", available: true }],
  allowedFolders: [{ path: "/Users/kwak/Projects", mode: "rw" }],
  tokenPreview: "sha256:abcd1234",
  lastSeenMs: 1_730_000_000_000,
  pendingOutboxCount: 0,
  online: true,
};

describe("endpointBotsApi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists endpoint bots for a company", async () => {
    const fetchMock: FetchMock = vi.fn(async () => mockResponse(200, [botRecord]));
    setFetchMock(fetchMock);

    await expect(endpointBotsApi.list("company-1")).resolves.toEqual([botRecord]);
    expect(fetchMock).toHaveBeenCalledWith("/api/companies/company-1/endpoints", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("method");
  });

  it("issues a pairing code for a company", async () => {
    const pairing: PairingCodeResponse = { code: "AB2CD3", expiresAtMs: 1_730_006_000_000 };
    const fetchMock = vi.fn(async () => mockResponse(201, pairing));
    setFetchMock(fetchMock);

    const body: IssuePairingCodeInput = {
      botName: "warehouse-bot",
      requestedFolders: [{ path: "/Users/kwak/Projects", mode: "rw" }],
      ttlMs: 600_000,
    };
    await expect(endpointBotsApi.issuePairingCode("company-1", body)).resolves.toEqual(pairing);
    expect(fetchMock).toHaveBeenCalledWith("/api/companies/company-1/endpoints/pairing-codes", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(body),
    }));
  });

  it("enqueues a local task for an endpoint bot", async () => {
    const task: LocalTaskRecord = {
      companyId: "company-1",
      deviceId: "device-1",
      taskId: "task-1",
      kind: "read_file",
      targetPath: "/Users/kwak/Projects/notes.md",
      status: "pending",
      createdAtMs: 1_730_000_000_000,
    };
    const fetchMock = vi.fn(async () => mockResponse(201, task));
    setFetchMock(fetchMock);

    const body: EnqueueLocalTaskInput = { kind: "read_file", targetPath: "/Users/kwak/Projects/notes.md" };
    await expect(endpointBotsApi.enqueueTask("company-1", "device-1", body)).resolves.toEqual(task);
    expect(fetchMock).toHaveBeenCalledWith("/api/companies/company-1/endpoints/device-1/tasks", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(body),
    }));
  });

  it("encodes company and device path params", async () => {
    const fetchMock: FetchMock = vi.fn(async () => mockResponse(200, []));
    setFetchMock(fetchMock);

    await endpointBotsApi.list("co/main 1");
    await endpointBotsApi.enqueueTask("co/main 1", "device/1?x", { kind: "list_dir", targetPath: "/tmp" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/companies/co%2Fmain%201/endpoints", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("method");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/companies/co%2Fmain%201/endpoints/device%2F1%3Fx/tasks", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ kind: "list_dir", targetPath: "/tmp" }),
    }));
  });

  it.each([
    ["without options", "company-1", undefined, "/companies/company-1/endpoints/audit"],
    ["with device and limit", "company-1", { deviceId: "device-1", limit: 25 },
      "/companies/company-1/endpoints/audit?deviceId=device-1&limit=25"],
    ["with encoded identifiers", "co/main 1", { deviceId: "device/1?x&name=한 #+%", limit: 10 },
      "/companies/co%2Fmain%201/endpoints/audit?deviceId=device%2F1%3Fx%26name%3D%ED%95%9C+%23%2B%25&limit=10"],
    ["with empty options", "company-1", {}, "/companies/company-1/endpoints/audit"],
    ["with only a zero limit", "company-1", { limit: 0 }, "/companies/company-1/endpoints/audit?limit=0"],
  ] as const)("lists audit events %s", async (_label, companyId, opts, path) => {
    const audit: EndpointAuditResponse = {
      items: [{
        id: "audit-1", companyId: "company-1", deviceId: "device-1", botName: "warehouse-bot",
        taskId: "task-1", kind: "read_file", targetPath: "/tmp/notes.md", outcome: "completed",
        summary: "Read notes", createdAtMs: 1_730_000_000_000,
      }],
      stats: { total: 1, enqueued: 0, completed: 1, failed: 0, denied: 0 },
    };
    const fetchMock: FetchMock = vi.fn(async () => mockResponse(200, audit));
    setFetchMock(fetchMock);

    await expect(endpointBotsApi.listAudit(companyId, opts)).resolves.toEqual(audit);
    expect(fetchMock).toHaveBeenCalledWith(`/api${path}`, expect.objectContaining({ credentials: "include" }));
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("method");
  });
});
