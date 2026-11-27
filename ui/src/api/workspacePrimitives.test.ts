// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  workspacePrimitivesApi,
  type CreateOpenWaitInput,
  type CreateSharedTableInput,
  type OpenWaitRecord,
  type SharedTableRecord,
  type UpsertSharedTableRowInput,
} from "./workspacePrimitives";
import { ApiError } from "./client";

const companyId = "company/공유 &?";
const base = "/api/companies/company%2F%EA%B3%B5%EC%9C%A0%20%26%3F";
const tableInput: CreateSharedTableInput = {
  name: "tasks",
  columns: [{ name: "title", type: "string", required: true }],
};
const table: SharedTableRecord = {
  ...tableInput, id: "table-1", companyId, createdAt: "2026-11-28", updatedAt: "2026-11-28",
};
const waitInput: CreateOpenWaitInput = {
  agentId: "agent-1", eventKey: "reply", note: "답변 대기",
  requestContext: { issueId: "issue-1" }, ttlMs: 60_000,
};
const wait: OpenWaitRecord = {
  ...waitInput, id: "wait-1", companyId, status: "waiting",
  expiresAtMs: null, matchedPayload: null, createdAtMs: 1, updatedAtMs: 1,
};
const fetchMock = vi.fn<typeof fetch>();
const respond = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

describe("workspacePrimitivesApi", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists shared tables with an encoded company ID", async () => {
    respond([table]);
    await expect(workspacePrimitivesApi.listSharedTables(companyId)).resolves.toEqual([table]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${base}/shared-tables`,
      expect.objectContaining({ credentials: "include" }));
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it("creates a shared table with the supplied columns", async () => {
    respond(table, 201);
    await expect(workspacePrimitivesApi.createSharedTable(companyId, tableInput)).resolves.toEqual(table);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${base}/shared-tables`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(tableInput) }));
  });

  it("upserts a row with an encoded table ID and unchanged values", async () => {
    const row: UpsertSharedTableRowInput = {
      key: "row/한 &?", values: { title: "검토", count: 2, active: true, data: { tags: [] } }, agentId: null,
    };
    const saved = { key: row.key, values: row.values, updatedByAgentId: null, updatedAt: "2026-11-28" };
    respond(saved);
    await expect(workspacePrimitivesApi.upsertSharedTableRow(companyId, "table/a &?", row)).resolves.toEqual(saved);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${base}/shared-tables/table%2Fa%20%26%3F/rows`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(row) }));
  });

  it("lists open waits without a query when agentId is omitted", async () => {
    respond([wait]);
    await expect(workspacePrimitivesApi.listOpenWaits(companyId)).resolves.toEqual([wait]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${base}/open-waits`, expect.any(Object));
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it.each([
    ["agent/a &?=#+%", "agent%2Fa%20%26%3F%3D%23%2B%25"],
    ["", ""],
  ])("encodes a provided agentId query (%j)", async (agentId, encoded) => {
    respond([]);
    await expect(workspacePrimitivesApi.listOpenWaits(companyId, agentId)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${base}/open-waits?agentId=${encoded}`, expect.any(Object));
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
  });

  it("creates an open wait with its request context and TTL", async () => {
    respond(wait, 201);
    await expect(workspacePrimitivesApi.createOpenWait(companyId, waitInput)).resolves.toEqual(wait);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${base}/open-waits`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(waitInput) }));
  });

  it("resolves an encoded wait ID and returns the server's cancellation receipt", async () => {
    const receipt = { id: "wait/a &?", companyId, status: "cancelled" as const };
    respond(receipt);
    await expect(workspacePrimitivesApi.resolveOpenWait(companyId, receipt.id)).resolves.toEqual(receipt);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${base}/open-waits/wait%2Fa%20%26%3F/resolve`,
      expect.objectContaining({ method: "POST", body: "{}" }));
  });

  it("preserves API errors for the caller", async () => {
    respond({ error: "Active open wait not found" }, 404);
    await expect(workspacePrimitivesApi.resolveOpenWait(companyId, "missing")).rejects.toMatchObject({
      name: "ApiError", status: 404, message: "Active open wait not found",
    } satisfies Partial<ApiError>);
  });
});
