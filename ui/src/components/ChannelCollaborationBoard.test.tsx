import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import {
  ChannelCollaborationBoard,
  CHANNEL_ASSIGNMENT_LIMIT,
  canTransfer,
  hopBadgeText,
  isAtHopLimit,
  loadChannelCards,
  resolveMentionRouting,
  saveChannelCards,
} from "./ChannelCollaborationBoard";

const agents = [
  { id: "a1", name: "백엔드봇" },
  { id: "a2", name: "백" },
  { id: "a3", name: "UI Dev" },
];

describe("resolveMentionRouting", () => {
  it("matches @name deterministically, longest name first, and strips mentions from body", () => {
    const r = resolveMentionRouting("안녕 @백엔드봇 이거 확인해줘 @UI Dev", agents);
    expect(r.mentioned.map((a) => a.id).sort()).toEqual(["a1", "a3"]);
    expect(r.body).toBe("안녕 이거 확인해줘");
  });

  it("ignores unknown mentions and dedupes repeated mentions", () => {
    const r = resolveMentionRouting("@nobody @백 @백 작업", agents);
    expect(r.mentioned.map((a) => a.id)).toEqual(["a2"]);
    expect(r.body).toContain("@nobody");
  });

  it("returns empty routing for plain text", () => {
    expect(resolveMentionRouting("just text", agents).mentioned).toEqual([]);
  });
});

describe("hop limit helpers", () => {
  it("reports hops / 8 and blocks transfer at the limit or when done", () => {
    expect(hopBadgeText({ hops: 3 })).toBe("3 / 8");
    expect(isAtHopLimit({ hops: CHANNEL_ASSIGNMENT_LIMIT })).toBe(true);
    expect(canTransfer({ hops: 7, status: "open" })).toBe(true);
    expect(canTransfer({ hops: 8, status: "open" })).toBe(false);
    expect(canTransfer({ hops: 2, status: "done" })).toBe(false);
  });
});

describe("channel card storage", () => {
  it("is SSR-safe without localStorage and round-trips when available", () => {
    expect(loadChannelCards("co-x")).toEqual([]);
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    saveChannelCards("co-x", [
      { id: "c1", title: "t", assigneeAgentId: null, assigneeName: null, hops: 1, replies: 0, status: "open", lastAction: "assign", createdAt: "now" },
    ]);
    expect(loadChannelCards("co-x")[0]?.id).toBe("c1");
    expect(loadChannelCards("co-other")).toEqual([]);
    delete (globalThis as Record<string, unknown>).localStorage;
  });
});

describe("ChannelCollaborationBoard", () => {
  it("renders composer and empty state via static markup", () => {
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: new QueryClient() },
        createElement(ChannelCollaborationBoard, { companyId: "co-1" })),
    );
    expect(html).toContain("할당");
    expect(html).toContain("채널 작업 카드가 없습니다");
    expect(html).toContain("var(--openbot-surface-25d-bg)");
  });
});
