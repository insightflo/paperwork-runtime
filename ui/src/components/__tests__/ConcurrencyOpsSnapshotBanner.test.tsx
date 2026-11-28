/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConcurrencyOpsSnapshotBanner,
  type ConcurrencyOpsSnapshotView,
} from "../ConcurrencyOpsSnapshotBanner";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function snapshot(overrides: Partial<ConcurrencyOpsSnapshotView> = {}): ConcurrencyOpsSnapshotView {
  return {
    utilizationPercent: 62.5,
    totalSlots: 16,
    totalRunning: 8,
    totalQueued: 2,
    attentionRequired: false,
    summaryLine: "8 running, 2 queued across 16 slots",
    ...overrides,
  };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
});

describe("ConcurrencyOpsSnapshotBanner", () => {
  it("returns empty DOM when snapshot is null", async () => {
    await mount(<ConcurrencyOpsSnapshotBanner snapshot={null} />);

    expect(host!.innerHTML).toBe("");
  });

  it('renders role="status" when attention is not required', async () => {
    await mount(<ConcurrencyOpsSnapshotBanner snapshot={snapshot()} />);

    const banner = host!.querySelector('[data-testid="concurrency-ops-snapshot-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("role")).toBe("status");
    expect(banner!.textContent).toContain("8 running, 2 queued across 16 slots");
    expect(banner!.textContent).toContain("62.5%");
  });

  it('renders role="alert" when attention is required', async () => {
    await mount(
      <ConcurrencyOpsSnapshotBanner
        snapshot={snapshot({ attentionRequired: true, sloBreachedLanes: ["implementation"] })}
      />,
    );

    const banner = host!.querySelector('[data-testid="concurrency-ops-snapshot-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("role")).toBe("alert");
    expect(banner!.textContent).toContain("Attention required");
    expect(banner!.textContent).toContain("implementation");
  });

  it("invokes onOpenDetails when the details button is clicked", async () => {
    const onOpenDetails = vi.fn();
    await mount(<ConcurrencyOpsSnapshotBanner snapshot={snapshot()} onOpenDetails={onOpenDetails} />);

    const button = host!.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.getAttribute("type")).toBe("button");
    await act(async () => {
      button!.click();
    });

    expect(onOpenDetails).toHaveBeenCalledTimes(1);
  });
});
