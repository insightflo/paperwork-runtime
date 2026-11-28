/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueExportToolbar } from "../QueueExportToolbar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function toolbar() {
  return host.querySelector<HTMLElement>('[data-testid="queue-export-toolbar"]');
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

describe("QueueExportToolbar", () => {
  it("returns null when neither CSV nor Markdown copy action is provided", async () => {
    await mount(<QueueExportToolbar />);

    expect(host.innerHTML).toBe("");
  });

  it("returns null for an empty CSV URL when no Markdown copy action is provided", async () => {
    await mount(<QueueExportToolbar csvUrl="" />);

    expect(host.innerHTML).toBe("");
  });

  it("renders the CSV download link with the expected toolbar, href, and download attributes", async () => {
    await mount(
      <QueueExportToolbar
        csvUrl="/api/companies/company-1/queue-telemetry.csv"
        csvFilename="fleet-queue.csv"
      />,
    );

    const region = toolbar();
    expect(region?.getAttribute("role")).toBe("toolbar");
    expect(region?.getAttribute("aria-label")).toBe("큐 텔레메트리 내보내기");

    const link = host.querySelector<HTMLAnchorElement>("a");
    expect(link?.textContent).toBe("CSV 다운로드");
    expect(link?.getAttribute("href")).toBe("/api/companies/company-1/queue-telemetry.csv");
    expect(link?.getAttribute("download")).toBe("fleet-queue.csv");
  });

  it("uses the default CSV filename when csvFilename is omitted", async () => {
    await mount(<QueueExportToolbar csvUrl="/queue.csv" />);

    expect(host.querySelector("a")?.getAttribute("download")).toBe("queue-telemetry.csv");
  });

  it("calls onCopyMarkdown when the Markdown copy button is clicked", async () => {
    const onCopyMarkdown = vi.fn();
    await mount(<QueueExportToolbar onCopyMarkdown={onCopyMarkdown} />);

    const button = host.querySelector<HTMLButtonElement>("button");
    expect(button?.type).toBe("button");
    expect(button?.textContent).toBe("Markdown 브리핑 복사");

    await act(async () => {
      button!.click();
    });

    expect(onCopyMarkdown).toHaveBeenCalledTimes(1);
  });

  it("renders the copied label state", async () => {
    await mount(<QueueExportToolbar onCopyMarkdown={vi.fn()} copied />);

    expect(host.querySelector("button")?.textContent).toBe("브리핑 복사됨");
  });

  it("hides the CSV link and disables Markdown copy while disabled", async () => {
    const onCopyMarkdown = vi.fn();
    await mount(
      <QueueExportToolbar
        csvUrl="/queue.csv"
        onCopyMarkdown={onCopyMarkdown}
        disabled
      />,
    );

    expect(host.querySelector("a")).toBeNull();
    const button = host.querySelector<HTMLButtonElement>("button");
    expect(button?.disabled).toBe(true);

    await act(async () => {
      button!.click();
    });

    expect(onCopyMarkdown).not.toHaveBeenCalled();
  });
});
