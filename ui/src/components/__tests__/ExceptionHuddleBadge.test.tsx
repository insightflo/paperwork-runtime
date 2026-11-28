/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExceptionHuddleBadge,
  type ExceptionHuddleBadgeDecisionKind,
  type ExceptionHuddleBadgeProps,
} from "../ExceptionHuddleBadge";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function renderBadge(props: Partial<ExceptionHuddleBadgeProps> = {}) {
  const merged: ExceptionHuddleBadgeProps = {
    status: "open",
    currentRound: 2,
    maxRounds: 3,
    ...props,
  };
  await mount(<ExceptionHuddleBadge {...merged} />);
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

describe("ExceptionHuddleBadge", () => {
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

  it("renders the open status with round progress and a status live region", async () => {
    await renderBadge({ status: "open", currentRound: 2, maxRounds: 3 });

    const pill = host.querySelector("[role='status']");
    expect(pill, "role=status pill").toBeTruthy();
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("Huddle R2/3");
    expect(pill!.getAttribute("aria-label")).toBe("Exception huddle: round 2 of 3 in progress");
  });

  it("renders the timed_out status with the chair decision label", async () => {
    await renderBadge({ status: "timed_out" });

    expect(host.textContent).toContain("Huddle Timeout · Chair Decision");
    const pill = host.querySelector("[role='status']");
    expect(pill).toBeTruthy();
    expect(pill!.getAttribute("aria-label")).toBe("Exception huddle: timed out, chair decision");
  });

  it("renders the cancelled status", async () => {
    await renderBadge({ status: "cancelled" });

    expect(host.textContent).toContain("Huddle Cancelled");
    const pill = host.querySelector("[role='status']");
    expect(pill).toBeTruthy();
    expect(pill!.getAttribute("aria-label")).toBe("Exception huddle: cancelled");
  });

  it("renders the decided status without a chair suffix by default", async () => {
    await renderBadge({ status: "decided", decisionKind: "escalate" });

    expect(host.textContent).toContain("Huddle: Escalate");
    expect(host.textContent).not.toContain("(Chair)");
  });

  it("appends the chair indicator when the decision was forced by the chair", async () => {
    await renderBadge({ status: "decided", decisionKind: "escalate", forcedByChair: true });

    expect(host.textContent).toContain("Huddle: Escalate (Chair)");
    const pill = host.querySelector("[role='status']");
    expect(pill!.getAttribute("aria-label")).toBe("Exception huddle: decided, Escalate, forced by chair");
  });

  it("renders human labels for every decision kind", async () => {
    const expectations: Array<[ExceptionHuddleBadgeDecisionKind, string]> = [
      ["retry_with_guidance", "Huddle: Retry with guidance"],
      ["accept_with_waiver", "Huddle: Accept with waiver"],
      ["replan_remaining", "Huddle: Replan remaining work"],
      ["escalate", "Huddle: Escalate"],
    ];

    for (const [kind, label] of expectations) {
      await renderBadge({ status: "decided", decisionKind: kind });
      expect(host.textContent, `decision kind ${kind}`).toContain(label);
    }
  });

  it("falls back to a generic decided label when no decision kind is given", async () => {
    await renderBadge({ status: "decided", decisionKind: null });

    expect(host.textContent).toContain("Huddle: Decided");
  });

  it("renders an interactive type=button with a clear aria-label when onOpen is provided", async () => {
    const onOpen = vi.fn();
    await renderBadge({ status: "open", currentRound: 1, maxRounds: 2, onOpen });

    const button = host.querySelector("button");
    expect(button, "interactive button").toBeTruthy();
    expect(button!.getAttribute("type")).toBe("button");
    expect(button!.getAttribute("aria-label")).toBe("Open exception huddle: round 1 of 2 in progress");
    expect(host.querySelector("[role='status']")).toBeNull();
  });

  it("invokes onOpen when the interactive pill is clicked", async () => {
    const onOpen = vi.fn();
    await renderBadge({ status: "timed_out", onOpen });

    const button = host.querySelector("button");
    expect(button).toBeTruthy();
    click(button!);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the non-interactive pill is clicked", async () => {
    await renderBadge({ status: "cancelled" });

    const pill = host.querySelector("[role='status']");
    expect(pill).toBeTruthy();
    click(pill!);
    expect(host.textContent).toContain("Huddle Cancelled");
  });
});
