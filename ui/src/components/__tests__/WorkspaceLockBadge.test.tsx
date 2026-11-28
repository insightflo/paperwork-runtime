/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatWorkspaceLockLabel,
  WorkspaceLockBadge,
} from "../WorkspaceLockBadge";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

describe("formatWorkspaceLockLabel", () => {
  it("formats the unlocked state", () => {
    expect(formatWorkspaceLockLabel("unlocked")).toBe("잠금 없음");
  });

  it("formats a single read lock holder as a read lock", () => {
    expect(formatWorkspaceLockLabel("read", 1)).toBe("읽기 잠금");
  });

  it("formats multiple read lock holders as shared read access", () => {
    expect(formatWorkspaceLockLabel("read", 3)).toBe("읽기 공유 (3)");
  });

  it("formats the write state", () => {
    expect(formatWorkspaceLockLabel("write")).toBe("쓰기 잠금");
  });
});

describe("WorkspaceLockBadge", () => {
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

  it("renders the formatted label in a status live region", async () => {
    await mount(<WorkspaceLockBadge state="read" holderCount={3} />);

    const pill = host.querySelector("[role='status']");
    expect(pill).toBeTruthy();
    expect(host.textContent).toContain("읽기 공유 (3)");
  });

  it("combines the workspace label and lock label in the accessible name", async () => {
    await mount(
      <WorkspaceLockBadge
        state="write"
        workspaceLabel="Design workspace"
      />,
    );

    const pill = host.querySelector("[role='status']");
    expect(pill).toBeTruthy();
    expect(pill!.getAttribute("aria-label")).toBe("Design workspace: 쓰기 잠금");
  });

  it("uses the lock label as the accessible name without a workspace label", async () => {
    await mount(<WorkspaceLockBadge state="unlocked" />);

    const pill = host.querySelector("[role='status']");
    expect(pill).toBeTruthy();
    expect(pill!.getAttribute("aria-label")).toBe("잠금 없음");
  });
});
