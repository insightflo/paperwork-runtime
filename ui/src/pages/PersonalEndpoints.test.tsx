/** @vitest-environment jsdom */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PersonalEndpoints } from "./PersonalEndpoints";
import { endpointBotsApi, type EndpointAuditEventRecord, type EndpointBotRecord } from "../api/endpointBots";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));

let listMock: MockInstance<typeof endpointBotsApi.list>;
let auditMock: MockInstance<typeof endpointBotsApi.listAudit>;
let codeMock: MockInstance<typeof endpointBotsApi.issuePairingCode>;
let enqueueMock: MockInstance<typeof endpointBotsApi.enqueueTask>;

beforeEach(() => {
  listMock = vi.spyOn(endpointBotsApi, "list");
  auditMock = vi.spyOn(endpointBotsApi, "listAudit").mockResolvedValue(auditResponse([]));
  codeMock = vi.spyOn(endpointBotsApi, "issuePairingCode");
  enqueueMock = vi.spyOn(endpointBotsApi, "enqueueTask");
});

const LAST_SEEN_MS = Date.parse("2026-01-01T09:00:00.000Z");
const EXPIRES_AT_MS = Date.parse("2026-01-01T09:30:00.000Z");
const RECORDS: EndpointBotRecord[] = [
  {
    companyId: "company-1",
    deviceId: "dev-1",
    botName: "my-mac",
    os: "macOS",
    arch: "arm64",
    detectedClis: ["claude", { id: "codex", binary: "codex", path: null, available: true }],
    allowedFolders: [{ path: "~/Projects", mode: "ro" }],
    tokenPreview: "pcp_…abc",
    lastSeenMs: LAST_SEEN_MS,
    pendingOutboxCount: 2,
    online: true,
  },
];
const AUDIT_EVENT: EndpointAuditEventRecord = {
  id: "audit-1", companyId: "company-1", deviceId: "dev-1", botName: "my-mac", taskId: "task-1",
  kind: "list_dir", targetPath: "~/Projects/paperclip", outcome: "denied", summary: "폴더 정책으로 차단됨",
  createdAtMs: Date.parse("2026-01-01T09:15:00.000Z"),
};

function auditResponse(items: EndpointAuditEventRecord[]) {
  return {
    items,
    stats: {
      total: items.length,
      enqueued: items.filter((item) => item.outcome === "enqueued").length,
      completed: items.filter((item) => item.outcome === "completed").length,
      failed: items.filter((item) => item.outcome === "failed").length,
      denied: items.filter((item) => item.outcome === "denied").length,
    },
  };
}

let root: Root | null = null;
const container = document.createElement("div");

async function renderPage() {
  if (!root) {
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><PersonalEndpoints /></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function click(el: Element | null | undefined) {
  expect(el, "click target exists").toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const issueButton = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("6자리 페어링 코드 발급"));

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

describe("PersonalEndpoints", () => {
  it("renders loaded endpoint bots from endpointBotsApi.list", async () => {
    listMock.mockResolvedValue(RECORDS);
    await renderPage();
    const list = container.querySelector('[aria-label="개인 단말 봇"]')!;
    expect(list).toBeTruthy();
    expect(list.textContent).toContain("my-mac");
    expect(list.textContent).toContain("macOS / arm64");
    expect(list.textContent).toContain("claude");
    expect(list.textContent).toContain("codex");
    expect(list.textContent).toContain("~/Projects");
    expect(list.textContent).toContain("읽기 전용");
    expect(list.textContent).toContain("전송 대기 2건");
    expect(list.querySelector("time")?.getAttribute("datetime")).toBe(new Date(LAST_SEEN_MS).toISOString());
  });

  it("renders recent audit outcomes and target paths from endpointBotsApi.listAudit", async () => {
    listMock.mockResolvedValue(RECORDS);
    auditMock.mockResolvedValue(auditResponse([
      AUDIT_EVENT,
      { ...AUDIT_EVENT, id: "audit-unknown", kind: "future_kind" },
    ]));
    await renderPage();

    expect(auditMock).toHaveBeenCalledWith("company-1", { limit: 20 });
    const auditList = container.querySelector('[aria-label="최근 로컬 작업 기록"] ul')!;
    expect(auditList.textContent).toContain("정책 차단");
    expect(auditList.textContent).toContain("~/Projects/paperclip");
    expect(auditList.querySelectorAll("li")).toHaveLength(1);
    expect(auditList.querySelector("time")?.getAttribute("datetime")).toBe(new Date(AUDIT_EVENT.createdAtMs).toISOString());
  });

  it("issues a 6-digit pairing code and displays it with expiry", async () => {
    listMock.mockResolvedValue([]);
    codeMock.mockResolvedValue({ code: "482913", expiresAtMs: EXPIRES_AT_MS });
    await renderPage();
    const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="페어링 봇 이름"]')!;
    await setInput(nameInput, "lab-top");
    await click(issueButton());
    expect(codeMock).toHaveBeenCalledWith("company-1", {
      botName: "lab-top",
      requestedFolders: [{ path: "~/Projects", mode: "ro" }],
    });
    const code = container.querySelector("[data-pairing-code]")!;
    expect(code.textContent).toContain("482913");
    expect(code.querySelector("time")?.getAttribute("datetime")).toBe(new Date(EXPIRES_AT_MS).toISOString());
  });

  it("shows an error banner when the bot list fails to load", async () => {
    listMock.mockRejectedValue(new Error("network down"));
    await renderPage();
    const banner = container.querySelector('[role="alert"]');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain("단말 봇 목록을 불러오지 못했습니다");
    expect(banner!.textContent).toContain("network down");
  });

  it("dispatches a local task via endpointBotsApi.enqueueTask and renders the returned taskId", async () => {
    listMock.mockResolvedValue(RECORDS);
    auditMock
      .mockResolvedValueOnce(auditResponse([]))
      .mockResolvedValueOnce(auditResponse([{ ...AUDIT_EVENT, id: "audit-enqueued", outcome: "enqueued" }]))
      .mockResolvedValueOnce(auditResponse([{ ...AUDIT_EVENT, id: "audit-denied" }]));
    enqueueMock.mockResolvedValueOnce({
      companyId: "company-1",
      deviceId: "dev-1",
      taskId: "task-77",
      kind: "list_dir",
      targetPath: "~/Projects/paperclip",
      status: "pending",
      createdAtMs: Date.now(),
    });
    enqueueMock.mockRejectedValueOnce(new Error("policy denied"));
    await renderPage();
    // 유일한 온라인 봇(dev-1)이 카드에서 자동 선택되므로 경로만 입력해 제출한다.
    const pathInput = container.querySelector<HTMLInputElement>('input[aria-label="대상 경로"]')!;
    await setInput(pathInput, "~/Projects/paperclip");
    const taskForm = container.querySelector<HTMLFormElement>('[aria-label="로컬 작업 접수"] form')!;
    await act(async () => { taskForm.requestSubmit(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith("company-1", "dev-1", {
      kind: "list_dir",
      targetPath: "~/Projects/paperclip",
    });
    expect(container.textContent).toContain("task-77");
    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("대기 중");

    await setInput(pathInput, "~/Projects/blocked");
    await act(async () => { taskForm.requestSubmit(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(auditMock).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("정책 차단");
    expect(container.textContent).toContain("policy denied");
  });
});
