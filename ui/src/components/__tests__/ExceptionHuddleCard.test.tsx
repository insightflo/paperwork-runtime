/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExceptionHuddleCard, type ExceptionHuddle } from "../ExceptionHuddleCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const baseHuddle: ExceptionHuddle = {
  id: "huddle-1",
  status: "open",
  currentRound: 2,
  maxRounds: 3,
  timeoutAt: "2026-03-01T12:05:00.000Z",
  failureSummary: "Validator rejected the release note because evidence was missing.",
  workProductLinks: [
    "https://example.com/report.pdf",
    "https://example.com/evidence.json",
  ],
  participants: {
    ownerName: "Olivia Owner",
    producerName: "Paul Producer",
    validatorName: "Vera Validator",
  },
  decision: null,
};

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

async function renderCard(props: Partial<Parameters<typeof ExceptionHuddleCard>[0]> = {}) {
  await mount(<ExceptionHuddleCard huddle={baseHuddle} {...props} />);
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

function type(element: Element, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitButton() {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === "Submit decision");
  expect(button, "submit decision button").toBeTruthy();
  return button!;
}

function field(name: string) {
  const element = host.querySelector(`textarea[name="${name}"]`);
  expect(element, `${name} textarea`).toBeTruthy();
  return element!;
}

async function submitForm() {
  await act(async () => {
    submitButton().click();
  });
}

describe("ExceptionHuddleCard", () => {
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

  it("renders participants, round badge, deadline, and safe external work product links", async () => {
    await renderCard();

    expect(host.textContent).toContain("Round 2/3");
    expect(host.textContent).toContain("5-min deadline");
    expect(host.textContent).toContain("Owner (Chair)");
    expect(host.textContent).toContain("Olivia Owner");
    expect(host.textContent).toContain("Producer");
    expect(host.textContent).toContain("Paul Producer");
    expect(host.textContent).toContain("Validator");
    expect(host.textContent).toContain("Vera Validator");

    const links = [...host.querySelectorAll<HTMLAnchorElement>("a[target='_blank']")];
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.getAttribute("rel"))).toEqual([
      "noopener noreferrer",
      "noopener noreferrer",
    ]);
    expect(links[0]!.href).toBe("https://example.com/report.pdf");
  });

  it("shows role=alert validation and does not submit without rationale or kind-specific detail", async () => {
    const onDecide = vi.fn();
    await renderCard({ canDecide: true, onDecide });

    type(field("detail"), "Use the registered artifact digest as evidence.");
    await submitForm();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Rationale is required");
    expect(onDecide).not.toHaveBeenCalled();

    type(field("rationale"), "The failure is recoverable with one focused retry.");
    const detail = field("detail");
    type(detail, "");
    await submitForm();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Guidance is required");
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("submits a structured retry_with_guidance payload", async () => {
    const onDecide = vi.fn();
    await renderCard({ canDecide: true, onDecide });

    click(host.querySelector('input[type="radio"][value="retry_with_guidance"]')!);
    type(field("rationale"), "  The validator identified a narrow correctable gap.  ");
    type(field("detail"), "  Attach the digest and rerun validation.  ");
    await submitForm();

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith({
      kind: "retry_with_guidance",
      rationale: "The validator identified a narrow correctable gap.",
      guidance: "Attach the digest and rerun validation.",
    });
  });

  it("submits a structured accept_with_waiver payload", async () => {
    const onDecide = vi.fn();
    await renderCard({ canDecide: true, onDecide });

    click(host.querySelector('input[type="radio"][value="accept_with_waiver"]')!);
    type(field("rationale"), "The missing evidence does not affect the approved output.");
    type(field("detail"), "Waiver expires after this release and requires board review.");
    await submitForm();

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith({
      kind: "accept_with_waiver",
      rationale: "The missing evidence does not affect the approved output.",
      waiverCondition: "Waiver expires after this release and requires board review.",
    });
  });

  it("renders the structured decision as read-only status when decided", async () => {
    await renderCard({
      canDecide: true,
      huddle: {
        ...baseHuddle,
        status: "decided",
        decision: {
          kind: "accept_with_waiver",
          rationale: "The residual risk is documented and bounded.",
          waiverCondition: "Only valid for the current release candidate.",
          forcedByChair: true,
        },
      },
    });

    const status = host.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status!.textContent).toContain("Accept with waiver");
    expect(status!.textContent).toContain("The residual risk is documented and bounded.");
    expect(status!.textContent).toContain("Only valid for the current release candidate.");
    expect(status!.textContent).toContain("Forced by Owner Chair");
    expect(host.querySelector('textarea[name="rationale"]')).toBeNull();
    expect(submitButtonOrNull()).toBeNull();
  });

  it("hides the decision form when canDecide is false", async () => {
    await renderCard({ canDecide: false });

    expect(host.textContent).toContain("Failure summary");
    expect(host.querySelector('input[type="radio"]')).toBeNull();
    expect(host.querySelector('textarea[name="rationale"]')).toBeNull();
    expect(submitButtonOrNull()).toBeNull();
  });
});

function submitButtonOrNull() {
  return [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === "Submit decision") ?? null;
}
