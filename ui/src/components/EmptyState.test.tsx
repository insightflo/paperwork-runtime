// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inbox } from "lucide-react";
import { EmptyState } from "./EmptyState";

let host: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("EmptyState", () => {
  it("renders the icon and message without requiring an action", async () => {
    await render(<EmptyState icon={Inbox} message="No activity yet." />);

    expect(host.querySelector("svg")).not.toBeNull();
    expect(host.textContent).toContain("No activity yet.");
    expect(host.querySelector("button")).toBeNull();
  });

  it("renders the optional action button and calls its callback", async () => {
    const onAction = vi.fn();
    await render(<EmptyState icon={Inbox} message="No missions yet." action="Create Mission" onAction={onAction} />);

    const button = Array.from(host.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Create Mission"),
    );
    expect(button).toBeDefined();
    act(() => button?.click());

    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
