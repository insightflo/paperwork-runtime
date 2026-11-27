/** @vitest-environment jsdom */
// Teams/Slack형 3컬럼 협업 채널 페이지. react-query 는 키 기반 canned data, collab API 는 vi.fn 으로 대체한다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CollabChannels } from "./CollabChannels";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { createChannelMock, createThreadMock, postMessageMock, resumeThreadMock } =
  vi.hoisted(() => ({ createChannelMock: vi.fn(), createThreadMock: vi.fn(), postMessageMock: vi.fn(), resumeThreadMock: vi.fn() }));

let routeParams: Record<string, string | undefined> = {};
const AGENTS = [
  { id: "agent-1", name: "Rocket PM" }, { id: "agent-2", name: "Rocket QA" },
];
const CHANNELS = [
  { id: "ch-1", slug: "product-launch", name: "제품 출시", description: "출시 조율", memberAgentIds: ["agent-1", "agent-2"], leadAgentId: "agent-1" },
  { id: "ch-2", slug: "support", name: "고객 지원", description: null, memberAgentIds: ["agent-2"], leadAgentId: null },
];
const THREADS: Record<string, unknown[]> = {
  "ch-1": [
    { id: "th-1", title: "출시 체크리스트 정리", status: "open", assignmentCount: 2, replyCount: 3 },
    { id: "th-2", title: "보도자료 초안", status: "paused", assignmentCount: 8, replyCount: 1 },
  ],
};
const MESSAGES: Record<string, unknown[]> = {
  "th-1": [
    { id: "m-1", authorType: "user", authorId: "user-1", actionKind: "message", targetAgentId: null, body: "체크리스트 초안을 공유합니다." },
    { id: "m-2", authorType: "agent", authorId: "agent-1", actionKind: "channel_assign", targetAgentId: "agent-2", body: "@Rocket QA 체크리스트 정리를 진행해 주세요." },
    { id: "m-3", authorType: "agent", authorId: "agent-2", actionKind: "channel_result", targetAgentId: null, body: "정리를 완료했습니다." },
    { id: "m-4", authorType: "system", authorId: null, actionKind: "channel_transfer", targetAgentId: "agent-2", body: "담당을 Rocket QA 로 이관합니다." },
    { id: "m-5", authorType: "user", authorId: "user-1", actionKind: "user_steer", targetAgentId: null, body: "방향 수정: QA 결과를 먼저 반영해 주세요." },
  ],
};

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    const settled = (data: unknown) => ({ data, isLoading: false, isFetching: false, error: null, refetch: vi.fn() });
    const key = [...queryKey];
    if (key[0] === "collab-channels") return settled(CHANNELS);
    if (key[0] === "collab-threads") return settled(THREADS[String(key[2])] ?? []);
    if (key[0] === "collab-messages") return settled(MESSAGES[String(key[3])] ?? []);
    return settled(key[0] === "agents" ? AGENTS : []);
  },
  useMutation: <TInput, TOutput>(config: { mutationFn: (input: TInput) => Promise<TOutput>; onSuccess?: (data: TOutput, input: TInput) => void }) => ({
    mutateAsync: async (input: TInput) => {
      const data = await config.mutationFn(input);
      config.onSuccess?.(data, input);
      return data;
    },
    isPending: false,
    error: null,
  }),
}));

vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(() => Promise.resolve(AGENTS)) } }));
vi.mock("../api/collabChannels", () => ({
  collabChannelsApi: {
    listChannels: vi.fn(() => Promise.resolve(CHANNELS)),
    createChannel: createChannelMock,
    listThreads: vi.fn((_companyId: unknown, channelId: string) => Promise.resolve(THREADS[channelId] ?? [])),
    createThread: createThreadMock,
    listMessages: vi.fn((_companyId: unknown, _channelId: unknown, threadId: string) => Promise.resolve(MESSAGES[threadId] ?? [])),
    postMessage: postMessageMock,
    resumeThread: resumeThreadMock,
  },
}));
vi.mock("@/lib/router", () => ({ useParams: () => routeParams }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../components/EmptyState", () => ({ EmptyState: ({ message }: { message: string }) => <div>{message}</div> }));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div data-testid="page-skeleton" /> }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => <button {...props}>{children}</button>,
}));
vi.mock("lucide-react", () => ({ CornerDownRight: () => <span />, MessageSquare: () => <span />, Pause: () => <span />, Plus: () => <span />, Send: () => <span /> }));

describe("CollabChannels", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    routeParams = {};
    for (const mock of [createChannelMock, createThreadMock, postMessageMock, resumeThreadMock]) mock.mockClear();
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
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
    act(() => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const click = async (selector: string, container: HTMLElement) => {
    const el = container.querySelector(selector);
    if (!el) throw new Error(`missing element: ${selector}`);
    await act(async () => { (el as HTMLElement).click(); });
  };

  it("renders channels with slug, name, and member count", () => {
    const html = renderToStaticMarkup(<CollabChannels />);
    expect(html).toContain("#product-launch");
    expect(html).toContain("제품 출시");
    expect(html).toContain("2명");
  });

  it("selects a thread and renders structured action and author badges", async () => {
    const container = await mount();
    expect(container.textContent).toContain("출시 체크리스트 정리");
    expect(container.querySelector('[data-status="open"]')).not.toBeNull();
    expect(container.textContent).toContain("2/8");
    expect(container.textContent).toContain("8/8");
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

  it("creates a thread with title and initial message", async () => {
    const container = await mount();
    await click('[data-testid="new-thread-toggle"]', container);
    setValue(container.querySelector('[data-testid="thread-title-input"]') as Element, "운영 점검");
    setValue(container.querySelector('[data-testid="thread-body-input"]') as Element, "점검 일정을 조율합니다.");
    await click('[data-testid="thread-create-submit"]', container);
    expect(createThreadMock).toHaveBeenCalledWith("company-1", "ch-1", { title: "운영 점검", body: "점검 일정을 조율합니다." });
  });
});
