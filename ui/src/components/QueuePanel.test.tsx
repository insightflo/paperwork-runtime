import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { QueuePanel, normalizeQueueItems, queueItemLabel, reorderQueueItems } from "./QueuePanel";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el));

describe("normalizeQueueItems", () => {
  it("normalizes array, {items}, {data} envelopes and drops malformed entries", () => {
    expect(normalizeQueueItems([{ id: "q1", prompt: "hi" }])).toEqual([
      { id: "q1", agentId: null, status: null, reason: null, prompt: "hi", payload: null },
    ]);
    expect(normalizeQueueItems({ items: [{ id: "q2", promptPreview: "preview" }] })[0]?.prompt).toBe("preview");
    expect(normalizeQueueItems({ data: [{ id: "q3" }] })[0]?.id).toBe("q3");
    expect(normalizeQueueItems(null)).toEqual([]);
    expect(normalizeQueueItems([{ noId: true }])).toEqual([]);
  });
});

describe("reorderQueueItems", () => {
  it("moves elements and guards out-of-range indexes", () => {
    expect(reorderQueueItems(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorderQueueItems(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(reorderQueueItems(["a", "b"], -1, 1)).toEqual(["a", "b"]);
    expect(reorderQueueItems(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });
});

describe("QueuePanel", () => {
  it("renders items, steer composer and pending-model badge via static markup", () => {
    const html = render(
      createElement(QueuePanel, {
        companyId: "co",
        agentId: "ag",
        pendingModel: "gpt-5.4",
        items: [
          { id: "w1", prompt: "첫 번째 대기 작업" },
          { id: "w2", reason: "retry" },
        ],
      }),
    );
    expect(html).toContain("대기/큐 (2)");
    expect(html).toContain("첫 번째 대기 작업");
    expect(html).toContain("개입(Steer)");
    expect(html).toContain("이번 턴 종료 후 적용");
  });

  it("shows empty state without crashing when no items and no company", () => {
    const html = render(createElement(QueuePanel, { companyId: null, items: [] }));
    expect(html).toContain("대기 중인 항목이 없습니다");
  });

  it("prefers payload.message then prompt then reason for labels", () => {
    expect(queueItemLabel({ id: "x", payload: { message: "m" }, prompt: "p" })).toBe("m");
    expect(queueItemLabel({ id: "x", prompt: "p", reason: "r" })).toBe("p");
    expect(queueItemLabel({ id: "x", reason: "r" })).toBe("r");
  });
});
