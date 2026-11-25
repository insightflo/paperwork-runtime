// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Activity } from "lucide-react";
import { MetricCard } from "./MetricCard";
import { StatusBadge } from "./StatusBadge";

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

describe("MetricCard", () => {
  it("renders value, label, and description with cockpit telemetry classes", async () => {
    await render(
      <MetricCard
        icon={Activity}
        value={42}
        label="active agents"
        description={<span>3 running now</span>}
      />,
    );

    const card = host.firstElementChild as HTMLElement;
    expect(host.textContent).toContain("42");
    expect(host.textContent).toContain("active agents");
    expect(host.textContent).toContain("3 running now");
    expect(card.className).toContain("border-border/80");
    expect(card.className).toContain("bg-card/80");
    expect(card.className).toContain("px-4");
    expect(card.className).toContain("py-3.5");
    expect(card.querySelector("p:nth-of-type(2)")?.className).toContain("uppercase");
    expect(card.querySelector("p:nth-of-type(2)")?.className).toContain("tracking-wider");
    expect(card.querySelector("p:first-of-type")?.className).toContain("tabular-nums");
  });

  it("calls onClick when the clickable card is clicked", async () => {
    const onClick = vi.fn();
    await render(<MetricCard icon={Activity} value="7" label="queued runs" onClick={onClick} />);

    const clickable = host.firstElementChild as HTMLElement;
    expect(clickable.querySelector("[class*='hover:border-primary/40']")).not.toBeNull();
    act(() => clickable.click());

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("StatusBadge", () => {
  it("renders the formatted status label with semantic cockpit pill classes", async () => {
    await render(<StatusBadge status="in_progress" />);

    const badge = host.querySelector("span") as HTMLSpanElement;
    expect(badge.textContent).toBe("in progress");
    expect(badge.className).toContain("rounded-sm");
    expect(badge.className).toContain("border-current/15");
    expect(badge.className).toContain("px-2");
    expect(badge.className).toContain("py-0.5");
    expect(badge.className).toContain("text-[11px]");
    expect(badge.className).toContain("uppercase");
    expect(badge.className).toContain("tabular-nums");
    expect(badge.className).toContain("bg-yellow-100");
    expect(badge.className).toContain("text-yellow-700");
    expect(badge.className).toContain("dark:bg-yellow-900/50");
    expect(badge.className).toContain("dark:text-yellow-300");
  });
});
