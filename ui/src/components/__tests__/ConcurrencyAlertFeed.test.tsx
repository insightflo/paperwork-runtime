/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConcurrencyAlertFeed,
  type ConcurrencyAlertFeedItem,
  type ConcurrencyAlertFeedProps,
} from "../ConcurrencyAlertFeed";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

function alertItem(overrides: Partial<ConcurrencyAlertFeedItem> = {}): ConcurrencyAlertFeedItem {
  return {
    dedupKey: "alert-1",
    severity: "warning",
    title: "큐 대기열이 비었습니다",
    body: "실행 가능한 작업이 있지만 배정되지 않았습니다.",
    deepLink: "/ops/alerts/alert-1",
    occurredAtIso: "2026-11-28T03:04:05.000Z",
    ...overrides,
  };
}

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function mountFeed(
  alerts: readonly ConcurrencyAlertFeedItem[],
  props: Partial<Omit<ConcurrencyAlertFeedProps, "alerts">> = {},
) {
  await mount(<ConcurrencyAlertFeed alerts={alerts} {...props} />);
}

function rows(): HTMLLIElement[] {
  return Array.from(host.querySelectorAll("li"));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  document.body.innerHTML = "";
});

describe("ConcurrencyAlertFeed", () => {
  it("returns null when alerts is empty", async () => {
    await mountFeed([]);

    expect(host.innerHTML).toBe("");
    expect(host.querySelector('[data-testid="concurrency-alert-feed"]')).toBeNull();
  });

  it("renders the region semantics, severity pills, title, body, and timestamp", async () => {
    await mountFeed([
      alertItem({ severity: "critical", title: "제공자 차단", body: "회로가 열렸습니다." }),
    ]);

    const region = host.querySelector('[data-testid="concurrency-alert-feed"]');
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("aria-label")).toBe("동시성 및 예산 경보 목록");
    expect(region?.textContent).toContain("긴급");
    expect(region?.textContent).toContain("제공자 차단");
    expect(region?.textContent).toContain("회로가 열렸습니다.");
    expect(host.querySelector("time")?.getAttribute("datetime")).toBe(alertItem().occurredAtIso);
  });

  it("deduplicates alerts by dedupKey while keeping the first occurrence", async () => {
    await mountFeed([
      alertItem({ dedupKey: "duplicate", title: "첫 번째 경보" }),
      alertItem({ dedupKey: "duplicate", title: "중복 경보" }),
      alertItem({ dedupKey: "other", title: "다른 경보" }),
    ]);

    expect(rows()).toHaveLength(2);
    expect(host.textContent).toContain("첫 번째 경보");
    expect(host.textContent).toContain("다른 경보");
    expect(host.textContent).not.toContain("중복 경보");
  });

  it("truncates at maxVisible and shows the hidden count", async () => {
    const alerts = Array.from({ length: 5 }, (_, index) =>
      alertItem({ dedupKey: `alert-${index}`, title: `경보 ${index}` }),
    );

    await mountFeed(alerts, { maxVisible: 2 });

    expect(rows()).toHaveLength(2);
    expect(host.textContent).toContain("경보 0");
    expect(host.textContent).toContain("경보 1");
    expect(host.textContent).not.toContain("경보 2");
    expect(host.textContent).toContain("+3건 더 있음");
  });

  it("shows at most five alerts by default", async () => {
    const alerts = Array.from({ length: 7 }, (_, index) =>
      alertItem({ dedupKey: `alert-${index}`, title: `경보 ${index}` }),
    );

    await mountFeed(alerts);

    expect(rows()).toHaveLength(5);
    expect(host.textContent).toContain("+2건 더 있음");
  });

  it("calls onOpenLink with the alert deepLink when its button is clicked", async () => {
    const first = alertItem({ dedupKey: "first", title: "첫 경보", deepLink: "/ops/alerts/first" });
    const second = alertItem({ dedupKey: "second", title: "둘째 경보", deepLink: "/ops/alerts/second" });
    const onOpenLink = vi.fn();
    await mountFeed([first, second], { onOpenLink });

    const target = Array.from(host.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.includes("둘째 경보"),
    );
    expect(target?.getAttribute("type")).toBe("button");
    await act(async () => {
      target?.click();
    });

    expect(onOpenLink).toHaveBeenCalledTimes(1);
    expect(onOpenLink).toHaveBeenCalledWith("/ops/alerts/second");
  });

  it("omits link buttons when onOpenLink is not provided", async () => {
    await mountFeed([alertItem()]);

    expect(host.querySelector("button")).toBeNull();
  });
});
