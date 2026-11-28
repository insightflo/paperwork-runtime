// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  conveneExceptionHuddle,
  decideExceptionHuddle,
  getExceptionHuddle,
  postExceptionHuddleTurn,
  type ConveneExceptionHuddleInput,
  type DecideExceptionHuddleInput,
  type ExceptionHuddleRecord,
} from "../../api/exceptionHuddles";
import { CollabChannels } from "../CollabChannels";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const collab = vi.hoisted(() => ({
  agents: vi.fn(), channels: vi.fn(), threads: vi.fn(), messages: vi.fn(),
  createChannel: vi.fn(), createThread: vi.fn(), postMessage: vi.fn(), resumeThread: vi.fn(),
}));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/lib/router", () => ({ useParams: () => ({}) }));
vi.mock("../../api/agents", () => ({ agentsApi: { list: collab.agents } }));
vi.mock("../../api/collabChannels", () => ({ collabChannelsApi: {
  listChannels: collab.channels, listThreads: collab.threads, listMessages: collab.messages,
  createChannel: collab.createChannel, createThread: collab.createThread,
  postMessage: collab.postMessage, resumeThread: collab.resumeThread,
} }));

function mockResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => payload) } as unknown as Response;
}
function setFetchMock(impl: ReturnType<typeof vi.fn>) {
  Object.defineProperty(globalThis, "fetch", { value: impl, configurable: true });
}
function requestBody(call: unknown[]) {
  return JSON.parse(String((call[1] as RequestInit).body));
}

const ownerAgentId = "00000000-0000-4000-8000-000000000001";
const producerAgentId = "00000000-0000-4000-8000-000000000002";
const validatorAgentId = "00000000-0000-4000-8000-000000000003";
const huddleRecord: ExceptionHuddleRecord = {
  schemaVersion: "workflow.exception-huddle.v1",
  missionId: "00000000-0000-4000-8000-000000000010",
  workflowRunId: "00000000-0000-4000-8000-000000000011",
  sourceStepId: "validate-release",
  sourceIssueId: null,
  workProductLinks: ["https://example.com/evidence.json"],
  participants: { ownerAgentId, producerAgentId, validatorAgentId },
  maxRounds: 2,
  currentRound: 1,
  timeoutAt: "2026-03-01T12:05:00.000Z",
  status: "open",
  decision: null,
  decidedByAgentId: null,
  decidedAt: null,
  roundTurns: { "1": [], "2": [] },
  failureSummary: "Validator rejected the release note because evidence was missing.",
};
const thread = {
  id: "thread-1", companyId: "company-1", channelId: "channel-1",
  title: "[Huddle] validate-release: evidence missing", status: "open",
  ownerAgentId, assignmentCount: 0, replyCount: 1, createdByActorType: "agent",
  createdAt: "2026-03-01T12:00:00.000Z", updatedAt: "2026-03-01T12:00:00.000Z",
};
const seedMessage = {
  id: "message-1", companyId: "company-1", channelId: "channel-1", threadId: "thread-1",
  authorType: "system", authorId: null, actionKind: "message", targetAgentId: null,
  body: "Exception huddle convened for validate-release.", expectsReply: true,
  createdAt: "2026-03-01T12:00:00.000Z",
  metadata: { schemaVersion: "workflow.exception-huddle.v1" },
};

describe("exception huddle API client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls typed endpoints with encoded paths and exact request payloads", async () => {
    const fetchMock = vi.fn(async () => mockResponse(200, {}));
    setFetchMock(fetchMock);

    await getExceptionHuddle("co/1", "thread/1");
    const conveneBody: ConveneExceptionHuddleInput = {
      missionId: huddleRecord.missionId,
      workflowRunId: huddleRecord.workflowRunId,
      sourceStepId: "validate-release",
      ownerAgentId,
      producerAgentId,
      validatorAgentId,
      workProductLinks: ["https://example.com/evidence.json"],
      failureSummary: "Evidence missing",
      verdict: "REQUEST_CHANGES",
      failureKind: "qa_rejection",
      qaFailureCount: 1,
    };
    await conveneExceptionHuddle("co/1", conveneBody);
    const turnBody = { actorAgentId: producerAgentId, body: "I can attach the missing digest." };
    await postExceptionHuddleTurn("co/1", "thread/1", turnBody);
    const decideBody: DecideExceptionHuddleInput = {
      actorAgentId: ownerAgentId,
      decision: {
        kind: "retry_with_guidance",
        rationale: "The gap is narrow and correctable.",
        guidance: "Attach the digest and rerun validation.",
      },
    };
    await decideExceptionHuddle("co/1", "thread/1", decideBody);

    const calls = fetchMock.mock.calls as unknown as unknown[][];
    expect(calls.map(([input]) => input)).toEqual([
      "/api/companies/co%2F1/collab-channels/huddles/thread%2F1",
      "/api/companies/co%2F1/collab-channels/huddles",
      "/api/companies/co%2F1/collab-channels/huddles/thread%2F1/turns",
      "/api/companies/co%2F1/collab-channels/huddles/thread%2F1/decide",
    ]);
    expect(calls[0]![1]).not.toHaveProperty("method");
    expect(requestBody(calls[1]!)).toEqual(conveneBody);
    expect(requestBody(calls[2]!)).toEqual(turnBody);
    expect(requestBody(calls[3]!)).toEqual(decideBody);
  });
});

describe("CollabChannels exception huddle integration", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.resetAllMocks();
    collab.agents.mockResolvedValue([
      { id: ownerAgentId, name: "Olivia Owner" },
      { id: producerAgentId, name: "Paul Producer" },
      { id: validatorAgentId, name: "Vera Validator" },
    ]);
    collab.channels.mockResolvedValue([{ id: "channel-1", companyId: "company-1", slug: "huddles", name: "Huddles", description: null, memberAgentIds: [ownerAgentId], leadAgentId: ownerAgentId, createdAt: "", updatedAt: "" }]);
    collab.threads.mockResolvedValue([thread]);
    collab.messages.mockResolvedValue([seedMessage]);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
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
  function type(element: Element, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("renders ExceptionHuddleCard above huddle messages and posts structured decisions", async () => {
    const huddleResponse = { thread, huddle: huddleRecord, messages: [seedMessage] };
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url === "/api/companies/company-1/collab-channels/huddles/thread-1") return mockResponse(200, huddleResponse);
      if (method === "POST" && url === "/api/companies/company-1/collab-channels/huddles/thread-1/decide") {
        return mockResponse(200, { threadId: "thread-1", huddle: huddleRecord, nextAction: "retry_with_guidance" });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    setFetchMock(fetchMock);

    await render(<CollabChannels />);
    await waitFor(() => expect(host.textContent).toContain("Exception huddle thread-1"));
    expect(host.textContent).toContain("Validator rejected the release note because evidence was missing.");
    expect(host.textContent).toContain("Olivia Owner");
    expect(host.textContent).toContain("Paul Producer");
    expect(host.textContent).toContain("Vera Validator");
    const card = host.querySelector("article");
    const firstMessage = host.querySelector('[data-testid="message-row"]');
    expect(card).not.toBeNull();
    expect(firstMessage).not.toBeNull();
    expect(card!.compareDocumentPosition(firstMessage!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    type(host.querySelector('textarea[name="rationale"]')!, "The failure is recoverable with one focused retry.");
    type(host.querySelector('textarea[name="detail"]')!, "Attach the digest and rerun validation.");
    const submit = [...host.querySelectorAll("button")].find((button) => button.textContent === "Submit decision")!;
    await act(async () => submit.click());

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/decide") && (init as RequestInit).method === "POST")).toBe(true);
    });
    const decideCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/decide") && (init as RequestInit).method === "POST")!;
    expect(requestBody(decideCall)).toEqual({
      actorAgentId: ownerAgentId,
      decision: {
        kind: "retry_with_guidance",
        rationale: "The failure is recoverable with one focused retry.",
        guidance: "Attach the digest and rerun validation.",
      },
    });
  });
});
