// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePrimitives } from "./WorkspacePrimitives";

const api = vi.hoisted(() => ({
  listOpenWaits: vi.fn(), listSharedTables: vi.fn(), resolveOpenWait: vi.fn(), createSharedTable: vi.fn(),
}));
const selection = vi.hoisted(() => ({ companyId: "company-1" as string | null }));
vi.mock("../api/workspacePrimitives", () => ({ workspacePrimitivesApi: api }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: selection.companyId }) }));

const wait = {
  id: "wait-7", companyId: "company-1", agentId: "agent-2", eventKey: "approval-needed",
  note: "검토 답변 대기", requestContext: {}, status: "waiting" as const, expiresAtMs: null,
  matchedPayload: null, createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_000_000,
};
const table = {
  id: "table-1", companyId: "company-1", name: "고객", columns: [{ name: "이름", type: "string" as const }],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  selection.companyId = "company-1";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
});
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><WorkspacePrimitives /></QueryClientProvider>));
}
async function shows(text: string) {
  await act(async () => vi.waitFor(() => expect(host.textContent).toContain(text)));
}
async function fill(label: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

describe("WorkspacePrimitives", () => {
  it("loads company-scoped waits and table metadata with honest empty rows", async () => {
    api.listOpenWaits.mockResolvedValue([wait]); api.listSharedTables.mockResolvedValue([table]);
    await render(); await shows(wait.note); await shows(table.name);
    expect(host.textContent).toContain("작업 공간 · 공유 표 & 대기 요청");
    expect(host.textContent).toContain("아직 등록된 행이 없습니다.");
    expect(api.listOpenWaits).toHaveBeenCalledWith("company-1");
    expect(api.listSharedTables).toHaveBeenCalledWith("company-1");
  });

  it("resolves the selected wait ID and refetches waits", async () => {
    api.listOpenWaits.mockResolvedValueOnce([wait]).mockResolvedValueOnce([]);
    api.listSharedTables.mockResolvedValue([]); api.resolveOpenWait.mockResolvedValue({ id: wait.id });
    await render(); await shows(wait.note);
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("해결 완료"))!.click());
    await act(async () => vi.waitFor(() => {
      expect(api.listOpenWaits).toHaveBeenCalledTimes(2);
      expect(!host.textContent.includes(wait.note)).toBe(true);
    }));
    expect(api.resolveOpenWait).toHaveBeenCalledExactlyOnceWith("company-1", "wait-7");
  });

  it("creates a trimmed string-column table and refetches metadata", async () => {
    api.listOpenWaits.mockResolvedValue([]); api.listSharedTables.mockResolvedValueOnce([]).mockResolvedValueOnce([table]);
    api.createSharedTable.mockResolvedValue(table);
    await render(); await shows("새 공유 표 만들기");
    await fill("표 이름", " 고객 "); await fill("열 이름", " 이름 , 상태 "); await submit();
    await act(async () => vi.waitFor(() => expect(api.listSharedTables).toHaveBeenCalledTimes(2)));
    expect(api.createSharedTable).toHaveBeenCalledExactlyOnceWith("company-1", {
      name: "고객", columns: [{ name: "이름", type: "string" }, { name: "상태", type: "string" }],
    });
    await shows("이름");
  });

  it("does not show old-company data while the selected company is loading", async () => {
    let finishWaits!: (value: typeof wait[]) => void;
    let finishTables!: (value: typeof table[]) => void;
    api.listOpenWaits.mockResolvedValueOnce([wait]).mockImplementationOnce(() => new Promise((resolve) => { finishWaits = resolve; }));
    api.listSharedTables.mockResolvedValueOnce([]).mockImplementationOnce(() => new Promise((resolve) => { finishTables = resolve; }));
    await render(); await shows(wait.note);
    selection.companyId = "company-2";
    await act(async () => root.render(<QueryClientProvider client={client}><WorkspacePrimitives /></QueryClientProvider>));
    expect(host.textContent).not.toContain(wait.note);
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(api.listOpenWaits).toHaveBeenLastCalledWith("company-2");
    await act(async () => {
      finishWaits([]); finishTables([]);
      await vi.waitFor(() => expect(host.querySelector('[role="status"]')).toBeNull());
    });
  });

  it("shows selection guidance without querying when no company is selected", async () => {
    selection.companyId = null;
    await render();
    expect(host.textContent).toContain("회사를 선택하면 작업 공간을 볼 수 있습니다.");
    expect(api.listOpenWaits).not.toHaveBeenCalled(); expect(api.listSharedTables).not.toHaveBeenCalled();
  });

  it("shows read failures and keeps create input when the API rejects", async () => {
    api.listOpenWaits.mockRejectedValue(new Error("offline")); api.listSharedTables.mockResolvedValue([]);
    api.createSharedTable.mockRejectedValue(new Error("offline"));
    await render(); await shows("대기 요청을 불러오지 못했습니다."); await shows("새 공유 표 만들기");
    await fill("표 이름", "고객"); await fill("열 이름", "이름"); await submit();
    await shows("공유 표를 만들지 못했습니다.");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="표 이름"]')?.value).toBe("고객");
  });

  it("turns a rejected resolve into an accessible alert", async () => {
    api.listOpenWaits.mockResolvedValue([wait]); api.listSharedTables.mockResolvedValue([]);
    api.resolveOpenWait.mockRejectedValue(new Error("offline"));
    await render(); await shows(wait.note);
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("해결 완료"))!.click());
    await shows("대기 요청을 해결하지 못했습니다.");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
});
