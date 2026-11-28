// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalEndpoints } from "../PersonalEndpoints";
import { WorkspacePrimitives } from "../WorkspacePrimitives";
import { CollabChannels } from "../CollabChannels";

const api = vi.hoisted(() => ({
  bots: vi.fn(), audit: vi.fn(), pairing: vi.fn(), enqueue: vi.fn(),
  waits: vi.fn(), tables: vi.fn(), resolve: vi.fn(), createTable: vi.fn(),
  agents: vi.fn(), channels: vi.fn(), threads: vi.fn(), messages: vi.fn(),
  createChannel: vi.fn(), createThread: vi.fn(), post: vi.fn(), resume: vi.fn(),
}));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/lib/router", () => ({ useParams: () => ({}) }));
vi.mock("../../api/endpointBots", () => ({ endpointBotsApi: {
  list: api.bots, listAudit: api.audit, issuePairingCode: api.pairing, enqueueTask: api.enqueue,
} }));
vi.mock("../../api/workspacePrimitives", () => ({ workspacePrimitivesApi: {
  listOpenWaits: api.waits, listSharedTables: api.tables, resolveOpenWait: api.resolve, createSharedTable: api.createTable,
} }));
vi.mock("../../api/agents", () => ({ agentsApi: { list: api.agents } }));
vi.mock("../../api/collabChannels", () => ({ collabChannelsApi: {
  listChannels: api.channels, listThreads: api.threads, listMessages: api.messages,
  createChannel: api.createChannel, createThread: api.createThread, postMessage: api.post, resumeThread: api.resume,
} }));

const pages = [
  ["personal endpoints", <PersonalEndpoints />, "개인 단말 봇 · 로컬 실행기"],
  ["workspace primitives", <WorkspacePrimitives />, "작업 공간 · 공유 표 & 대기 요청"],
  ["collaboration channels", <CollabChannels />, "채널 협업"],
] as const;
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  api.bots.mockResolvedValue([{ deviceId: "bot-1", botName: "My Mac", os: "macOS", arch: "arm64",
    online: true, lastSeenMs: 0, detectedClis: [], allowedFolders: [], pendingOutboxCount: 0 }]);
  api.audit.mockResolvedValue({ items: [] });
  api.waits.mockResolvedValue([{ id: "wait-1", note: "검토 답변 대기", createdAtMs: 0 }]);
  api.tables.mockResolvedValue([{ id: "table-1", name: "고객", columns: [{ name: "이름" }] }]);
  api.agents.mockResolvedValue([{ id: "agent-1", name: "검토 담당" }]);
  api.channels.mockResolvedValue([{ id: "channel-1", slug: "team", name: "팀", memberAgentIds: ["agent-1"] }]);
  api.threads.mockResolvedValue([{ id: "thread-1", title: "검토", status: "paused", assignmentCount: 8, replyCount: 0 }]);
  api.messages.mockResolvedValue([]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
});
async function render(page: ReactElement) {
  await act(async () => root.render(<QueryClientProvider client={client}>{page}</QueryClientProvider>));
}
async function waitFor(check: () => void) {
  let error: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    try { check(); return; } catch (failure) { error = failure; }
  }
  throw error;
}
async function click(selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => button!.click());
}
function checkHeadings(title: string) {
  expect([...host.querySelectorAll("h1")].map((h) => h.textContent)).toEqual([title]);
  let previous = 0;
  for (const heading of host.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    const level = Number(heading.tagName[1]);
    expect(heading.textContent?.trim()).toBeTruthy();
    expect(level, heading.textContent ?? "heading").toBeLessThanOrEqual(previous + 1);
    previous = level;
  }
}
function checkControls() {
  const fields = host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select");
  expect(fields.length).toBeGreaterThan(0);
  for (const field of fields) {
    const label = [...(field.labels ?? [])].find((item) => field.id && item.htmlFor === field.id);
    expect(field.getAttribute("aria-label")?.trim() || label?.textContent?.trim(), field.outerHTML).toBeTruthy();
  }
  const buttons = host.querySelectorAll<HTMLButtonElement>("button");
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) {
    const content = button.cloneNode(true) as HTMLElement;
    content.querySelectorAll('svg,[aria-hidden="true"]').forEach((item) => item.remove());
    const text = content.textContent?.trim();
    expect(button.getAttribute("aria-label")?.trim() || text, button.outerHTML).toBeTruthy();
    expect(button.getAttribute("type")).toMatch(/^(button|submit)$/);
    if (!text) expect(button.getAttribute("aria-label")?.trim()).toBeTruthy();
    if (!button.disabled) expect(button.tabIndex).toBeGreaterThanOrEqual(0);
  }
}
function announced(text: string) {
  const regions = [...host.querySelectorAll('[role="alert"],[aria-live="polite"],[role="status"]')];
  expect(regions.some((region) => region.textContent?.includes(text)), text).toBe(true);
}

describe("workspace page accessibility", () => {
  it.each(pages)("%s has one page heading, ordered subheadings and named controls", async (_name, page, title) => {
    await render(page);
    await waitFor(() => expect(host.querySelector("input,textarea")).not.toBeNull());
    checkHeadings(title); checkControls();
  });

  it("labels channel member checkboxes and both inline forms explicitly", async () => {
    await render(<CollabChannels />);
    await waitFor(() => expect(host.querySelector('[data-testid="composer-input"]')).not.toBeNull());
    await click('[data-testid="new-channel-toggle"]');
    await click('[data-testid="new-thread-toggle"]');
    expect(host.querySelectorAll("input[type=checkbox]")).toHaveLength(1);
    expect(host.querySelector('[data-testid="thread-body-input"]')).not.toBeNull();
    checkControls();
  });

  it("announces pairing results and pairing failures", async () => {
    api.pairing.mockResolvedValueOnce({ code: "123456", expiresAtMs: 1_800_000_000_000 }).mockRejectedValueOnce(new Error("offline"));
    await render(<PersonalEndpoints />);
    const issue = () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("6자리 페어링"))!;
    await act(async () => issue().click());
    await waitFor(() => announced("123456"));
    await act(async () => issue().click());
    await waitFor(() => announced("페어링 코드 발급에 실패했습니다"));
  });

  it.each([
    ["endpoints", <PersonalEndpoints />, "bots", "단말 봇 목록을 불러오지 못했습니다"],
    ["audit", <PersonalEndpoints />, "audit", "로컬 작업 기록을 불러오지 못했습니다"],
    ["waits", <WorkspacePrimitives />, "waits", "대기 요청을 불러오지 못했습니다"],
    ["tables", <WorkspacePrimitives />, "tables", "공유 표를 불러오지 못했습니다"],
    ["channels", <CollabChannels />, "channels", "채널을 불러오지 못했습니다"],
    ["agents", <CollabChannels />, "agents", "에이전트를 불러오지 못했습니다"],
    ["threads", <CollabChannels />, "threads", "스레드를 불러오지 못했습니다"],
    ["messages", <CollabChannels />, "messages", "메시지를 불러오지 못했습니다"],
  ] as const)("announces %s query errors", async (_name, page, key, message) => {
    api[key].mockRejectedValue(new Error("offline"));
    await render(page);
    await waitFor(() => announced(message));
  });

  it("announces open waits and workspace loading", async () => {
    await render(<WorkspacePrimitives />);
    await waitFor(() => announced("검토 답변 대기"));
    api.waits.mockImplementation(() => new Promise(() => {}));
    await act(async () => { void client.resetQueries(); });
    await waitFor(() => expect(host.querySelector('[aria-label="작업 공간 불러오는 중"][aria-live="polite"]')).not.toBeNull());
  });

  it("retains the channel heading and announces loading", async () => {
    api.channels.mockImplementation(() => new Promise(() => {}));
    await render(<CollabChannels />);
    checkHeadings("채널 협업");
    expect(host.querySelector('[role="status"][aria-label="채널 협업 불러오는 중"]')).not.toBeNull();
  });

  it("announces paused state and mutation errors even with no selected thread", async () => {
    await render(<CollabChannels />);
    await waitFor(() => announced("일시 중지되었습니다"));
    api.createChannel.mockRejectedValue(new Error("offline"));
    await click('[data-testid="new-channel-toggle"]');
    const input = host.querySelector<HTMLInputElement>('[data-testid="channel-name-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "새 채널");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    api.threads.mockResolvedValue([]);
    await act(async () => client.invalidateQueries({ queryKey: ["collab-threads"] }));
    await waitFor(() => expect(host.querySelector('[data-testid="composer-input"]')).toBeNull());
    await act(async () => host.querySelector("form")!.requestSubmit());
    await waitFor(() => announced("요청이 실패했습니다"));
  });

  it("keeps keyboard mention focus and composition-safe Ctrl/Meta+Enter", async () => {
    await render(<CollabChannels />);
    await waitFor(() => expect(host.querySelector('[data-mention-agent="agent-1"]')).not.toBeNull());
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    for (const modifier of ["ctrlKey", "metaKey"]) {
      await click('[data-mention-agent="agent-1"]');
      expect(document.activeElement).toBe(input);
      const send = async (isComposing: boolean) => {
        await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", [modifier]: true, isComposing, bubbles: true, cancelable: true,
        })); });
      };
      api.post.mockClear();
      await send(true); expect(api.post).not.toHaveBeenCalled();
      await send(false); expect(api.post).toHaveBeenCalledTimes(1);
    }
  });
});
