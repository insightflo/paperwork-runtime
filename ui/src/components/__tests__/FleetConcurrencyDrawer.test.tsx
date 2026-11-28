/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildQueueTelemetryCsvUrl,
  FleetConcurrencyDrawer,
} from "../FleetConcurrencyDrawer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type DrawerProps = Parameters<typeof FleetConcurrencyDrawer>[0];

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function renderDrawer({ open = true, onClose = vi.fn(), ...props }: Partial<DrawerProps> = {}) {
  await mount(<FleetConcurrencyDrawer open={open} onClose={onClose} {...props} />);
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

function dialog() {
  const element = host.querySelector<HTMLElement>('[role="dialog"]');
  expect(element, "dialog").toBeTruthy();
  return element!;
}

function closeButton() {
  const element = host.querySelector<HTMLButtonElement>('button[aria-label="닫기"]');
  expect(element, "close button").toBeTruthy();
  return element!;
}

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}

describe("buildQueueTelemetryCsvUrl", () => {
  it("encodes the company id in the queue telemetry CSV export path", () => {
    expect(buildQueueTelemetryCsvUrl("company/42 live")).toBe(
      "/api/companies/company%2F42%20live/queue-telemetry/export.csv",
    );
  });
});

describe("FleetConcurrencyDrawer", () => {
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

  it("returns null when open is false", async () => {
    await renderDrawer({ open: false });

    expect(host.innerHTML).toBe("");
    expect(host.querySelector('[data-testid="fleet-concurrency-drawer"]')).toBeNull();
  });

  it("renders an accessible dialog with headline, children, and a CSV download link", async () => {
    const csvExportUrl = "/api/companies/company-1/queue-telemetry/export.csv";
    await renderDrawer({
      title: "Fleet concurrency",
      headline: "실행 중 4개, 대기 중 12개",
      csvExportUrl,
      children: <section>Concurrency details</section>,
    });

    const drawer = dialog();
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(drawer.getAttribute("aria-label")).toBe("Fleet concurrency");
    expect(drawer.getAttribute("data-testid")).toBe("fleet-concurrency-drawer");
    expect(host.textContent).toContain("실행 중 4개, 대기 중 12개");
    expect(host.textContent).toContain("Concurrency details");

    const download = host.querySelector<HTMLAnchorElement>('a[download="queue-telemetry.csv"]');
    expect(download, "CSV download link").toBeTruthy();
    expect(download?.getAttribute("href")).toBe(csvExportUrl);
  });

  it("uses the default Korean accessibility label", async () => {
    await renderDrawer();

    expect(dialog().getAttribute("aria-label")).toBe("동시 실행 및 큐 현황");
  });

  it("invokes onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    await renderDrawer({ onClose });

    click(closeButton());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes onClose on Escape and removes the keydown listener when closed", async () => {
    const onClose = vi.fn();
    await renderDrawer({ onClose });

    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);

    await renderDrawer({ open: false, onClose });
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
