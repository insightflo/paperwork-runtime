/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CollabChannels } from "./CollabChannels";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { createChannelMock, createThreadMock, postMessageMock, resumeThreadMock } =
  vi.hoisted(() => ({ createChannelMock: vi.fn(), createThreadMock: vi.fn(), postMessageMock: vi.fn(), resumeThreadMock: vi.fn() }));
let emptyChannels = false;
const AGENTS = [{ id: "agent-1", name: "Rocket PM" }, { id: "agent-2", name: "Rocket QA" }];
const CHANNELS = [
  { id: "ch-1", slug: "product-launch", name: "제품 출시", description: "출시 조율", memberAgentIds: ["agent-1", "agent-2"], leadAgentId: "agent-1" },
  { id: "ch-2", slug: "support", name: "고객 지원", description: null, memberAgentIds: ["agent-2"], leadAgentId: null },
];
const THREADS: Record<string, unknown[]> = { "ch-1": [
  { id: "th-1", title: "출시 체크리스트 정리", status: "open", assignmentCount: 2, replyCount: 3 },
    { id: "th-2", title: "보도자료 초안", status: "paused", assignmentCount: 8, replyCount: 1 },
] };
const MESSAGES: Record<string, unknown[]> = { "th-1": [
  { id: "m-1", authorType: "user", authorId: "user-1", actionKind: "message", targetAgentId: null, body: "체크리스트 초안을 공유합니다." },
    { id: "m-2", authorType: "agent", authorId: "agent-1", actionKind: "channel_assign", targetAgentId: "agent-2", body: "@Rocket QA 체크리스트 정리를 진행해 주세요." },
    { id: "m-3", authorType: "agent", authorId: "agent-2", actionKind: "channel_result", targetAgentId: null, body: "정리를 완료했습니다." },
    { id: "m-4", authorType: "system", authorId: null, actionKind: "channel_transfer", targetAgentId: "agent-2", body: "담당을 Rocket QA 로 이관합니다." },
    { id: "m-5", authorType: "user", authorId: "user-1", actionKind: "user_steer", targetAgentId: null, body: "방향 수정: QA 결과를 먼저 반영해 주세요." },
] };
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    const settled = (data: unknown) => ({ data, isLoading: false, isFetching: false, error: null, refetch: vi.fn() });
    if (queryKey[0] === "collab-channels") return settled(emptyChannels ? [] : CHANNELS);
    if (queryKey[0] === "collab-threads") return settled(THREADS[String(queryKey[2])] ?? []);
    if (queryKey[0] === "collab-messages") return settled(MESSAGES[String(queryKey[3])] ?? []);
    return settled(queryKey[0] === "agents" ? AGENTS : []);
  },
  useMutation: <TInput, TOutput>(config: { mutationFn: (input: TInput) => Promise<TOutput>; onSuccess?: (data: TOutput, input: TInput) => void }) => ({
    mutateAsync: async (input: TInput) => {
      const data = await config.mutationFn(input);
      config.onSuccess?.(data, input);
      return data;
    },
    isPending: false, error: null,
  }),
}));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(() => Promise.resolve(AGENTS)) } }));
vi.mock("../api/collabChannels", () => ({
  collabChannelsApi: { createChannel: createChannelMock, createThread: createThreadMock, postMessage: postMessageMock, resumeThread: resumeThreadMock },
}));
vi.mock("@/lib/router", () => ({ useParams: () => ({}) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
describe("CollabChannels", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  beforeEach(() => {
    emptyChannels = false;
    for (const mock of [createChannelMock, createThreadMock, postMessageMock, resumeThreadMock]) mock.mockClear();
  });
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove(); host = null;
  });
  async function mount(): Promise<HTMLElement> {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root?.render(<CollabChannels />); });
    return host;
  }
  const setValue = (el: Element, value: string) => {
    const ctor = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(ctor.prototype, "value")?.set?.call(el, value);
    act(() => { el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  const click = async (selector: string, container: HTMLElement) => {
    const el = container.querySelector(selector);
    if (!el) throw new Error(`missing element: ${selector}`);
    await act(async () => { (el as HTMLElement).click(); });
  };
  it("renders channels with slug, name, and member count", () => {
    const html = renderToStaticMarkup(<CollabChannels />);
    for (const label of ["#product-launch", "제품 출시", "2명"]) expect(html).toContain(label);
  });
  it("selects a thread and renders structured action and author badges", async () => {
    const container = await mount();
    expect(container.textContent).toContain("출시 체크리스트 정리");
    expect(container.querySelector('[data-status="open"]')).not.toBeNull();
    for (const count of ["2/8", "8/8"]) expect(container.textContent).toContain(count);
    await click('[data-thread-row="th-1"]', container);
    const actions = [...container.querySelectorAll('[data-testid="action-badge"]')].map((el) => el.getAttribute("data-action"));
    expect(actions).toEqual(["channel_assign", "channel_result", "channel_transfer", "user_steer"]);
    for (const label of ["위임", "이관", "결과", "방향 수정", "사람", "시스템", "Rocket PM"]) expect(container.textContent).toContain(label);
    expect(container.querySelectorAll('[data-testid="message-row"]').length).toBe(5);
  });
  it("shows the paused approval banner and resumes the thread on Continue", async () => {
    const container = await mount();
    await click('[data-thread-row="th-2"]', container);
    expect(container.querySelector('[data-testid="paused-banner"]')?.textContent).toContain("승인 후 계속 (Continue)");
    await click('[data-testid="resume-continue"]', container);
    expect(resumeThreadMock).toHaveBeenCalledWith("company-1", "ch-1", "th-2");
  });
  it("submits a message and a steer through postMessage", async () => {
    const container = await mount();
    await click('[data-thread-row="th-1"]', container);
    const textarea = container.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    setValue(textarea, "QA 결과 반영 부탁드립니다.");
    setValue(container.querySelector('[data-testid="composer-target"]') as Element, "agent-2");
    await click('[data-testid="composer-send"]', container);
    expect(postMessageMock).toHaveBeenLastCalledWith("company-1", "ch-1", "th-1", { body: "QA 결과 반영 부탁드립니다.", actionKind: "message", targetAgentId: "agent-2" });
    setValue(textarea, "우선순위를 출시 블로커로 수정해 주세요.");
    await click('[data-testid="composer-steer"]', container);
    expect(postMessageMock).toHaveBeenLastCalledWith("company-1", "ch-1", "th-1", { body: "우선순위를 출시 블로커로 수정해 주세요.", actionKind: "user_steer", targetAgentId: null });
  });
  it("creates a channel from the inline form with selected members", async () => {
    const container = await mount();
    await click('[data-testid="new-channel-toggle"]', container);
    setValue(container.querySelector('[data-testid="channel-name-input"]') as Element, "신규 채널");
    setValue(container.querySelector('[data-testid="channel-description-input"]') as Element, "신규 설명");
    await click('[data-channel-agent="agent-2"]', container);
    await click('[data-testid="channel-create-submit"]', container);
    expect(createChannelMock).toHaveBeenCalledWith("company-1", { name: "신규 채널", description: "신규 설명", memberAgentIds: ["agent-2"] });
  });
  it("explains first steps and opens channel creation from onboarding", async () => {
    emptyChannels = true;
    const container = await mount();
    expect(container.textContent).toContain("Paperwork에서 팀 대화를 시작하세요");
    expect(container.textContent).toContain("@멘션");
    expect(container.querySelector('[data-testid="channel-name-input"]')).toBeNull();
    await click('[data-testid="onboarding-create-channel"]', container);
    expect(container.querySelector('[data-testid="channel-name-input"]')).not.toBeNull();
  });
  it("appends mention chips to the draft and focuses the composer", async () => {
    const container = await mount();
    const textarea = container.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    await click('[data-mention-agent="agent-1"]', container);
    expect(textarea.value).toBe("@Rocket PM ");
    setValue(textarea, "Review this");
    await click('[data-mention-agent="agent-2"]', container);
    await click('[data-mention-agent="agent-1"]', container);
    expect(textarea.value).toBe("Review this @Rocket QA @Rocket PM ");
    expect(document.activeElement).toBe(textarea);
  });
  it.each(["ctrlKey", "metaKey"])("submits with %s+Enter, excluding IME composition", async (modifier) => {
    const container = await mount();
    const textarea = container.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    setValue(textarea, "  Ready to review  ");
    const keydown = async (options: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
      await act(async () => { textarea.dispatchEvent(event); });
      return event;
    };
    expect((await keydown({ [modifier]: true, isComposing: true })).defaultPrevented).toBe(false);
    expect((await keydown({})).defaultPrevented).toBe(false);
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(textarea.value).toBe("  Ready to review  ");
    expect((await keydown({ [modifier]: true })).defaultPrevented).toBe(true);
    expect(postMessageMock).toHaveBeenCalledExactlyOnceWith("company-1", "ch-1", "th-1", { body: "Ready to review", actionKind: "message", targetAgentId: null });
    expect(textarea.value).toBe("");
    await keydown({ [modifier]: true });
    expect(postMessageMock).toHaveBeenCalledTimes(1);
  });
  it("creates a thread with title and initial message", async () => {
    const container = await mount();
    await click('[data-testid="new-thread-toggle"]', container);
    setValue(container.querySelector('[data-testid="thread-title-input"]') as Element, "운영 점검");
    setValue(container.querySelector('[data-testid="thread-body-input"]') as Element, "점검 일정을 조율합니다.");
    await click('[data-testid="thread-create-submit"]', container);
    expect(createThreadMock).toHaveBeenCalledWith("company-1", "ch-1", { title: "운영 점검", body: "점검 일정을 조율합니다." });
  });
});
