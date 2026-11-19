import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import {
  InspectorSidePanel,
  INSPECTOR_TABS,
  capLiveLogText,
  normalizeQueuePayload,
  LIVE_LOG_HIGHLIGHT_CAP,
} from "./InspectorSidePanel";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el));

describe("capLiveLogText", () => {
  it("passes through short content and caps long content to the highlight limit", () => {
    expect(capLiveLogText("hello")).toEqual({ text: "hello", truncated: false });
    const big = "x".repeat(LIVE_LOG_HIGHLIGHT_CAP + 500);
    const capped = capLiveLogText(big);
    expect(capped.truncated).toBe(true);
    expect(capped.text.length).toBe(LIVE_LOG_HIGHLIGHT_CAP);
    expect(capLiveLogText(null).text).toBe("");
  });
});

describe("normalizeQueuePayload", () => {
  it("accepts arrays, {items}, and {data} envelopes and drops malformed rows", () => {
    expect(normalizeQueuePayload([{ id: "a", reason: "wake" }])).toEqual([
      { id: "a", agentId: null, status: null, reason: "wake", prompt: null, payload: null },
    ]);
    expect(normalizeQueuePayload({ items: [{ id: "b" }] })[0]?.id).toBe("b");
    expect(normalizeQueuePayload({ data: [{ id: "c" }] })[0]?.id).toBe("c");
    expect(normalizeQueuePayload("junk")).toEqual([]);
  });
});

describe("InspectorSidePanel", () => {
  it("renders all four Korean tabs and the props body without a DOM", () => {
    const html = render(
      createElement(InspectorSidePanel, {
        companyId: "co-1",
        panelContent: createElement("div", null, "패널 콘텐츠"),
      }),
    );
    for (const t of INSPECTOR_TABS) expect(html).toContain(t.label);
    expect(html).toContain("패널 콘텐츠");
    expect(html).toContain("var(--openbot-inspector-width)");
  });

  it("renders empty-props fallback and queue/live tabs without crashing in node env", () => {
    const html = render(createElement(InspectorSidePanel, { companyId: null }));
    expect(html).toContain("실시간 작업");
    expect(html).toContain("대기/큐");
  });
});
