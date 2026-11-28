// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Copy, Inbox } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyText } from "../CopyText";
import { EmptyState } from "../EmptyState";
import { MarkdownBody } from "../MarkdownBody";

vi.mock("../../context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));

let host: HTMLDivElement;
let root: Root;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared utility accessibility", () => {
  it("names icon-only copy actions and announces repeated copies without submitting a form", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    await render(
      <form onSubmit={onSubmit}>
        <CopyText text="session-42" copiedLabel="Session copied"><Copy aria-hidden="true" /></CopyText>
      </form>,
    );
    const button = host.querySelector("button")!;
    const status = host.querySelector('[role="status"]')!;
    expect(button.getAttribute("aria-label")).toBe("Copy session-42");
    expect(button.type).toBe("button");
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");

    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => button.click());
      expect(status.textContent).toBe("Session copied");
      await act(async () => vi.advanceTimersByTime(1500));
      expect(status.textContent).toBe("");
    }
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenCalledWith("session-42");
    expect(document.activeElement).toBe(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("announces clipboard failures politely", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await render(<CopyText text="value" />);
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Copy failed");
    expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it("keeps named empty-state actions focusable and prevents accidental form submission", async () => {
    const onAction = vi.fn();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    await render(
      <form onSubmit={onSubmit}>
        <EmptyState icon={Inbox} message="No items" action="Create item" onAction={onAction} />
      </form>,
    );
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe("Create item");
    expect(button.type).toBe("button");
    button.focus();
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    expect(onAction).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("preserves native link navigation and safe external link relations", async () => {
    await render(<MarkdownBody>{"[External](https://example.com) [Local](/issues)"}</MarkdownBody>);
    const links = Array.from(host.querySelectorAll("a"));
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe("https://example.com");
    expect(links[0].rel.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    expect(links[0].getAttribute("target")).toBeNull();
    expect(links[1].getAttribute("href")).toBe("/issues");
    for (const link of links) {
      link.focus();
      expect(document.activeElement).toBe(link);
    }
  });

  it.each(["none", "resolved", "fallback"])("keeps image alternatives and async decoding with %s resolution", async (mode) => {
    const resolveImageSrc = mode === "none" ? undefined : (src: string) => mode === "resolved" ? `/resolved/${src}` : null;
    await render(
      <MarkdownBody resolveImageSrc={resolveImageSrc}>
        {"![Org chart](images/chart.png) ![](images/decoration.png)"}
      </MarkdownBody>,
    );
    const images = Array.from(host.querySelectorAll("img"));
    expect(images).toHaveLength(2);
    expect(images.map((img) => img.getAttribute("alt"))).toEqual(["Org chart", ""]);
    expect(images[0].getAttribute("src")).toBe(mode === "resolved" ? "/resolved/images/chart.png" : "images/chart.png");
    for (const img of images) expect(img.getAttribute("decoding")).toBe("async");
  });
});
